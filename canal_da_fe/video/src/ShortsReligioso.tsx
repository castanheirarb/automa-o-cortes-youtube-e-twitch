import React, {useEffect, useState} from 'react';
import {
    AbsoluteFill,
    Sequence,
    Audio,
    staticFile,
    useCurrentFrame,
    useVideoConfig,
    interpolate,
    spring,
    Img,
    delayRender,
    continueRender,
} from 'remotion';
import {Cena, VideoMetadata} from './types';

const TEXT_OUTLINE = `
  -2px -2px 0 rgba(0,0,0,0.7),
   2px -2px 0 rgba(0,0,0,0.7),
  -2px  2px 0 rgba(0,0,0,0.7),
   2px  2px 0 rgba(0,0,0,0.7)
`;

const SceneComponent: React.FC<{cena: Cena; imageSrc: string; fps: number; sceneDurationFrames: number}> = ({cena, imageSrc, fps, sceneDurationFrames}) => {
    const frame = useCurrentFrame();

    const scale = interpolate(frame, [0, sceneDurationFrames], [1.0, 1.08], {extrapolateRight: 'clamp'});
    const imageOpacity = interpolate(frame, [0, 15, sceneDurationFrames - 15, sceneDurationFrames], [0, 1, 1, 0], {extrapolateLeft: 'clamp', extrapolateRight: 'clamp'});
    const textScale = spring({frame, fps, config: {damping: 14, mass: 0.7, stiffness: 140}, from: 0.6, to: 1, durationInFrames: 18});

    const words = cena.texto.split(' ');
    const syncableFrames = sceneDurationFrames * 0.95;
    const framesPerWord = syncableFrames / words.length;
    const currentWordIndex = Math.min(Math.floor(frame / framesPerWord), words.length - 1);

    return (
        <AbsoluteFill style={{backgroundColor: '#000'}}>
            <Img
                src={imageSrc}
                style={{
                    width: '100%',
                    height: '100%',
                    objectFit: 'cover',
                    opacity: imageOpacity,
                    transform: `scale(${scale})`,
                    transformOrigin: 'center center',
                }}
            />

            <AbsoluteFill style={{background: 'linear-gradient(to top, rgba(0,0,0,0.6) 0%, rgba(0,0,0,0) 40%)'}} />

            <div style={{position: 'absolute', bottom: 0, width: '90%', left: '5%', paddingBottom: 120}}>
                <h1 style={{
                    fontFamily: "'Cinzel', 'Georgia', serif",
                    fontSize: 78,
                    fontWeight: 700,
                    lineHeight: 1.2,
                    textAlign: 'center',
                    textShadow: TEXT_OUTLINE,
                    transform: `scale(${textScale})`,
                }}>
                    {words.map((word, i) => {
                        const isHighlighted = i === currentWordIndex;
                        const isPast = i < currentWordIndex;
                        return (
                            <span
                                key={i}
                                style={{
                                    color: isHighlighted ? '#FFD700' : isPast ? '#bbbbbb' : '#ffffff',
                                    fontSize: isHighlighted ? 82 : 78,
                                    letterSpacing: '-1px',
                                    transition: 'font-size 0.05s, color 0.05s',
                                }}>
                                {word}{' '}
                            </span>
                        );
                    })}
                </h1>
            </div>
        </AbsoluteFill>
    );
};

export const ShortsReligioso: React.FC = () => {
    const {fps} = useVideoConfig();
    const [meta, setMeta] = useState<VideoMetadata | null>(null);
    const [handle] = useState(() => delayRender());

    useEffect(() => {
        fetch(staticFile('metadata.json'))
            .then((r) => r.json())
            .then((data) => {
                setMeta(data);
                continueRender(handle);
            })
            .catch(() => continueRender(handle));
    }, [handle]);

    if (!meta) return null;

    let fromFrame = 0;
    return (
        <AbsoluteFill style={{backgroundColor: '#0a0a0a'}}>
            {meta.audio && <Audio src={staticFile('audio.mp3')} volume={1} />}
            {meta.cenas.map((cena, i) => {
                const sceneDurationFrames = Math.max(1, Math.round((cena.duracao_real_s ?? cena.duracao_s) * fps));
                const imageSrc = staticFile(`images/${meta.imagens[i % meta.imagens.length]}`);
                const sequence = (
                    <Sequence key={i} from={fromFrame} durationInFrames={sceneDurationFrames}>
                        <SceneComponent cena={cena} imageSrc={imageSrc} fps={fps} sceneDurationFrames={sceneDurationFrames} />
                    </Sequence>
                );
                fromFrame += sceneDurationFrames;
                return sequence;
            })}
        </AbsoluteFill>
    );
};
