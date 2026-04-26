#!/usr/bin/env python3
"""
active_speaker.py — Active Speaker Detection (ASD) para crop 9:16 dinâmico.

Usa MediaPipe Face Mesh para detectar rostos e medir a variação do movimento
labial ao longo do tempo, determinando qual pessoa está falando em cada instante.

Gera um arquivo sendcmd do FFmpeg (formato de texto) com comandos que reposicionam
a janela de crop frame a frame, mantendo o falante ativo centralizado com
transições suaves (EMA smoothing).

Uso:
    python active_speaker.py <video_path> <output_cmds.txt> [opções]

Saída:
    <output_cmds.txt>       — arquivo sendcmd para o filtro FFmpeg
    <output_cmds.txt>.json  — metadados (crop_w, crop_h, vid_w, vid_h)

Requer:
    pip install mediapipe opencv-python numpy
"""

import sys
import os
import json
import argparse
import numpy as np
import cv2
import mediapipe as mp


# ─── Índices de landmarks MediaPipe Face Mesh ─────────────────────────────────
#
#  O Face Mesh retorna 468 landmarks por rosto (normalizados de 0.0 a 1.0).
#  Usamos os pontos internos do lábio superior e inferior para medir abertura.
#
UPPER_LIP_IDX = 13   # ponto interno superior do lábio
LOWER_LIP_IDX = 14   # ponto interno inferior do lábio


# ─── Parâmetros de processamento ─────────────────────────────────────────────

SAMPLE_FPS    = 6     # frames/s efetivos analisados (maior = mais preciso, porém mais lento)
LIP_WINDOW    = 8     # janela de snapshots para calcular variância labial (detecção de fala)
SMOOTH_ALPHA  = 0.12  # alpha do EMA: 0.05=muito suave/lento, 0.30=rápido/brusco
KEYFRAME_STEP = 0.1   # intervalo em segundos entre keyframes no sendcmd


# ─── Utilitários de vídeo ─────────────────────────────────────────────────────

def get_video_info(cap):
    """Extrai metadados básicos do VideoCapture aberto."""
    w   = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
    h   = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
    fps = cap.get(cv2.CAP_PROP_FPS) or 30.0
    n   = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
    return w, h, fps, n


# ─── Etapa 1: Análise de frames ───────────────────────────────────────────────

def analyze_frames(video_path, sample_fps=SAMPLE_FPS):
    """
    Lê o vídeo em saltos regulares (a cada vid_fps/sample_fps frames)
    e detecta rostos usando MediaPipe Face Mesh.

    Para cada rosto detectado registra:
      - cx, cy : centro normalizado [0, 1] no frame
      - lip    : abertura labial normalizada (distância entre lábio sup/inf)

    Retorna:
      snapshots : list[dict]  — { time: float, faces: list[dict] }
      vid_w, vid_h, vid_fps, duration
    """
    cap = cv2.VideoCapture(video_path)
    if not cap.isOpened():
        raise RuntimeError(f"Não foi possível abrir o vídeo: {video_path}")

    vid_w, vid_h, vid_fps, total_frames = get_video_info(cap)
    duration = total_frames / vid_fps
    print(
        f"[ASD] Vídeo: {vid_w}x{vid_h} @ {vid_fps:.1f}fps | "
        f"{duration:.1f}s | {total_frames} frames",
        flush=True
    )

    frame_step = max(1, round(vid_fps / sample_fps))
    effective_fps = vid_fps / frame_step
    print(f"[ASD] Amostragem: 1 frame a cada {frame_step} ({effective_fps:.1f}fps efetivo)", flush=True)

    face_mesh = mp.solutions.face_mesh.FaceMesh(
        static_image_mode=False,
        max_num_faces=4,          # suporta até 4 pessoas (podcasts, painéis)
        refine_landmarks=True,    # landmarks mais precisos ao redor dos olhos/lábios
        min_detection_confidence=0.5,
        min_tracking_confidence=0.5,
    )

    snapshots  = []
    frame_idx  = 0
    n_analyzed = 0

    while frame_idx < total_frames:
        cap.set(cv2.CAP_PROP_POS_FRAMES, frame_idx)
        ret, frame = cap.read()
        if not ret:
            break

        timestamp = frame_idx / vid_fps
        rgb       = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
        results   = face_mesh.process(rgb)

        faces = []
        if results.multi_face_landmarks:
            for face_lm in results.multi_face_landmarks:
                lm = face_lm.landmark

                # Abertura labial: distância normalizada entre lábio sup e inf
                upper = lm[UPPER_LIP_IDX]
                lower = lm[LOWER_LIP_IDX]
                lip   = abs(lower.y - upper.y)

                # Bounding box do rosto via extremos dos landmarks
                xs = [l.x for l in lm]
                ys = [l.y for l in lm]
                cx = (min(xs) + max(xs)) / 2
                cy = (min(ys) + max(ys)) / 2

                faces.append({'cx': cx, 'cy': cy, 'lip': lip})

        snapshots.append({'time': timestamp, 'faces': faces})
        frame_idx  += frame_step
        n_analyzed += 1

    cap.release()
    face_mesh.close()

    total_detected = sum(len(s['faces']) for s in snapshots)
    print(
        f"[ASD] {n_analyzed} snapshots analisados | "
        f"{total_detected} detecções de rosto no total",
        flush=True
    )
    return snapshots, vid_w, vid_h, vid_fps, duration


# ─── Etapa 2: Detecção do falante ativo ──────────────────────────────────────

def detect_active_speaker(snapshots, window=LIP_WINDOW):
    """
    Para cada snapshot, identifica qual rosto é o falante ativo usando
    a variância da abertura labial em uma janela deslizante de `window` frames.

    Lógica:
    - 0 rostos → mantém última posição conhecida
    - 1 rosto  → ele é o ativo (sem comparação)
    - N rostos → calcula variância de `lip` dos últimos `window` snapshots
                 para cada rosto (associando por proximidade de cx) e escolhe
                 o de maior variância (= quem mais moveu os lábios recentemente)

    Retorna list[dict]: { time, cx, detected }
    """
    if not snapshots:
        return []

    results = []
    last_cx = 0.5  # fallback: centro da tela

    for i, snap in enumerate(snapshots):
        faces = snap['faces']

        if not faces:
            results.append({'time': snap['time'], 'cx': last_cx, 'detected': False})
            continue

        if len(faces) == 1:
            last_cx = faces[0]['cx']
            results.append({'time': snap['time'], 'cx': last_cx, 'detected': True})
            continue

        # Múltiplos rostos: competição por atividade labial
        best_score = -1.0
        best_cx    = faces[0]['cx']

        for face in faces:
            # Coletamos o histórico de abertura labial desta face
            # associando por proximidade de cx em cada snapshot passado
            history = []
            for j in range(max(0, i - window), i + 1):
                prev_faces = snapshots[j]['faces']
                if not prev_faces:
                    continue
                # Face mais próxima neste snapshot passado
                nearest = min(prev_faces, key=lambda f: abs(f['cx'] - face['cx']))
                # Tolerância: cx difere em menos de 25% da largura
                if abs(nearest['cx'] - face['cx']) < 0.25:
                    history.append(nearest['lip'])

            # Variância = proxy para "quanta movimentação labial houve"
            score = float(np.var(history)) if len(history) >= 2 else face['lip']

            if score > best_score:
                best_score = score
                best_cx    = face['cx']

        last_cx = best_cx
        results.append({'time': snap['time'], 'cx': best_cx, 'detected': True})

    n_multi = sum(1 for s in snapshots if len(s['faces']) > 1)
    if n_multi:
        print(f"[ASD] {n_multi} snapshots com múltiplos rostos processados por variância labial", flush=True)

    return results


# ─── Etapa 3: Suavização EMA ─────────────────────────────────────────────────

def smooth_cx(detections, alpha=SMOOTH_ALPHA):
    """
    Aplica Exponential Moving Average (EMA) na série temporal de cx.

    EMA(t) = alpha * cx(t) + (1 - alpha) * EMA(t-1)

    Evita que a câmera salte abruptamente quando o falante muda.
    Com alpha=0.12 e SAMPLE_FPS=6, a câmera leva ~1.5s para 90% da transição.
    """
    if not detections:
        return []

    ema = detections[0]['cx']
    smoothed = []

    for d in detections:
        ema = alpha * d['cx'] + (1.0 - alpha) * ema
        smoothed.append({**d, 'cx': ema})

    return smoothed


# ─── Etapa 4: Conversão para pixels ──────────────────────────────────────────

def to_crop_pixels(smoothed, vid_w, vid_h):
    """
    Converte a série temporal de cx normalizado [0, 1] em coordenadas
    de pixel x para o filtro `crop` do FFmpeg.

    A janela de crop tem largura = vid_h * 9/16 (mantém a altura total
    e extrai a região 9:16 horizontal correta).

    Fórmula:
        crop_w        = vid_h * 9 / 16          (pixels, arredondado para par)
        face_center_x = cx * vid_w              (pixels)
        x             = clamp(face_center_x - crop_w/2, 0, vid_w - crop_w)

    Retorna entries (list[dict]: { time, x }) e crop_w (int).
    """
    crop_w = round(vid_h * 9 / 16)
    if crop_w % 2 != 0:   # garante largura par (evita artefatos no encoder)
        crop_w -= 1

    entries = []
    for s in smoothed:
        center_px = s['cx'] * vid_w
        x = center_px - crop_w / 2
        x = max(0.0, min(float(vid_w - crop_w), x))
        entries.append({'time': s['time'], 'x': int(round(x))})

    print(f"[ASD] Janela de crop: {crop_w}px de {vid_w}px totais (9:16 @ altura original)", flush=True)
    return entries, crop_w


# ─── Etapa 5: Interpolação densa ─────────────────────────────────────────────

def interpolate_keyframes(entries, total_duration, step=KEYFRAME_STEP):
    """
    Gera um keyframe a cada `step` segundos por interpolação linear
    entre os pontos amostrados.

    O FFmpeg lerá estes keyframes no sendcmd e aplicará cada valor
    exato de x no instante correspondente. Com step=0.1s, a "animação"
    terá 10 atualizações por segundo, suficiente para parecer contínua.
    """
    if not entries:
        return []

    dense = []
    t = 0.0

    while t <= total_duration + 0.001:
        before = None
        after  = None

        for kf in entries:
            if kf['time'] <= t:
                before = kf
            elif after is None:
                after = kf
                break

        if before is None:
            x = entries[0]['x']
        elif after is None:
            x = before['x']
        else:
            dt    = after['time'] - before['time']
            ratio = (t - before['time']) / dt if dt > 1e-6 else 0.0
            x     = before['x'] + ratio * (after['x'] - before['x'])

        dense.append({'time': round(t, 3), 'x': int(round(x))})
        t = round(t + step, 3)

    return dense


# ─── Etapa 6: Escrita do sendcmd ─────────────────────────────────────────────

def write_sendcmd(dense, output_path):
    """
    Gera o arquivo de texto no formato sendcmd do FFmpeg.

    Cada linha tem o formato:
        TIMESTAMP crop x PIXEL_VALUE;

    O filtro `sendcmd` lerá este arquivo e atualizará o parâmetro `x`
    do filtro `crop` no instante indicado, produzindo movimento de câmera.

    Linhas com o mesmo x da linha anterior são omitidas para reduzir
    o tamanho do arquivo sem perda de informação.
    """
    written = 0
    prev_x  = None

    with open(output_path, 'w', encoding='utf-8') as f:
        for kf in dense:
            if kf['x'] == prev_x:
                continue
            f.write(f"{kf['time']:.3f} crop x {kf['x']};\n")
            prev_x  = kf['x']
            written += 1

    print(f"[ASD] sendcmd: {output_path} ({written} comandos únicos de {len(dense)} keyframes)", flush=True)


# ─── Entry point ─────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(
        description='ASD: detecta falante ativo e gera sendcmd FFmpeg para crop 9:16 dinâmico',
        formatter_class=argparse.ArgumentDefaultsHelpFormatter,
    )
    parser.add_argument('video_path',    help='Caminho do vídeo local (.mp4)')
    parser.add_argument('output_cmds',   help='Arquivo sendcmd de saída (.txt)')
    parser.add_argument('--sample-fps',  type=float, default=SAMPLE_FPS,
                        help='FPS de amostragem para análise')
    parser.add_argument('--smooth-alpha', type=float, default=SMOOTH_ALPHA,
                        help='Alpha EMA: menor = transição mais suave/lenta')
    args = parser.parse_args()

    if not os.path.isfile(args.video_path):
        print(f"[ASD] ERRO: arquivo não encontrado: {args.video_path}", file=sys.stderr)
        sys.exit(1)

    print(f"[ASD] Iniciando análise: {args.video_path}", flush=True)

    # Pipeline de processamento
    snapshots, vid_w, vid_h, vid_fps, duration = analyze_frames(
        args.video_path, args.sample_fps
    )

    # Valida se o vídeo tem pessoas — aborta se nenhum rosto for detectado
    total_faces = sum(len(s['faces']) for s in snapshots)
    if total_faces == 0:
        print(
            "[ASD] AVISO: nenhum rosto detectado em nenhum frame. "
            "O vídeo não parece conter pessoas visíveis.",
            file=sys.stderr,
        )
        sys.exit(2)  # código 2 = sem rostos (distinto de 1 = arquivo não encontrado)

    detections = detect_active_speaker(snapshots)
    smoothed   = smooth_cx(detections, alpha=args.smooth_alpha)
    entries, crop_w = to_crop_pixels(smoothed, vid_w, vid_h)
    dense      = interpolate_keyframes(entries, duration)
    write_sendcmd(dense, args.output_cmds)

    # Metadados JSON — lidos pelo Node.js para montar o filtro FFmpeg corretamente
    meta = {
        'crop_w':   crop_w,
        'crop_h':   vid_h,
        'vid_w':    vid_w,
        'vid_h':    vid_h,
        'duration': round(duration, 3),
    }
    meta_path = args.output_cmds + '.json'
    with open(meta_path, 'w', encoding='utf-8') as f:
        json.dump(meta, f, indent=2)

    print(f"[ASD] Metadados: {meta_path}", flush=True)
    print(f"[ASD] Concluido com sucesso.", flush=True)


if __name__ == '__main__':
    main()
