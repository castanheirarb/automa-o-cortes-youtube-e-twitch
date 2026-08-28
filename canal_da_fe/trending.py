"""
trending.py — Seleciona temas religiosos otimizados para viralização.
"""

import random

TEMAS_RELIGIOSOS = [
    # Categoria: Histórias Épicas
    "a travessia do Mar Vermelho por Moisés",
    "a história de Davi e Golias",
    "Daniel na cova dos leões",
    "a queda das muralhas de Jericó",
    "a força de Sansão e sua queda",

    # Categoria: Parábolas Emocionais
    "a parábola do filho pródigo",
    "a parábola do bom samaritano",
    "a parábola da ovelha perdida",
    "a parábola do servo impiedoso",
    "a parábola dos talentos",

    # Categoria: Milagres de Jesus
    "Pedro andando sobre as águas",
    "a ressurreição de Lázaro",
    "a multiplicação dos pães e peixes",
    "a cura do cego de nascença",
    "Jesus acalma a tempestade",

    # Categoria: Momentos de Fé
    "a fé de Abraão ao sacrificar Isaque",
    "a conversão de Saulo no caminho de Damasco",
    "a coragem da rainha Ester",
    "a paciência de Jó em meio ao sofrimento",
    "a obediência de Noé ao construir a arca",

    # Categoria: Temas Universais
    "quando Deus parece silencioso na sua vida",
    "por que Deus permite a dor e o sofrimento",
    "o poder de uma oração desesperada",
    "quando você se sente abandonado por todos",
    "a força que nasce da fraqueza",

    # Categoria: Versículos Poderosos
    "Salmo 23 — O Senhor é meu pastor",
    "Jeremias 29:11 — Planos de esperança e futuro",
    "Filipenses 4:13 — Tudo posso naquele que me fortalece",
    "Isaías 41:10 — Não temas, porque eu sou contigo",
    "Romanos 8:28 — Todas as coisas cooperam para o bem",
]


def get_tema() -> str:
    """Retorna um tema religioso aleatório para o vídeo."""
    return random.choice(TEMAS_RELIGIOSOS)
