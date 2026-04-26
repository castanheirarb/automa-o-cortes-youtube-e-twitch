// poster/branding.js

export function getPersonaBranding(persona) {
    if (!persona || !persona.displayName) return '';

    const name = persona.displayName.toLowerCase();

    if (name.includes('flow')) return '| Cortes do Flow';
    if (name.includes('inteligência') || name.includes('inteligencia')) return '| Cortes do Inteligência';
    if (name.includes('casimiro') || name.includes('casimito')) return '| Cortes do Casimito';
    if (name.includes('podpah')) return '| Cortes do Podpah';
    if (name.includes('venus')) return '| Cortes do Venus';

    const firstName = persona.displayName.split(' ')[0];
    return `| Cortes do ${firstName}`;
}
