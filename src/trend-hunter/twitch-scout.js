// src/trend-hunter/twitch-scout.js
import axios from 'axios';
import { logger } from '../utils/logger.js';

const TWITCH_API_BASE = 'https://api.twitch.tv/helix';
let twitchToken = null;

async function getTwitchToken() {
    if (twitchToken) return twitchToken;
    const { TWITCH_CLIENT_ID, TWITCH_CLIENT_SECRET } = process.env;
    const res = await axios.post('https://id.twitch.tv/oauth2/token', null, {
        params: { client_id: TWITCH_CLIENT_ID, client_secret: TWITCH_CLIENT_SECRET, grant_type: 'client_credentials' },
    });
    twitchToken = res.data.access_token;
    return twitchToken;
}

async function getTopStreams() {
    const token = await getTwitchToken();
    const res = await axios.get(`${TWITCH_API_BASE}/streams`, {
        headers: { 'Client-Id': process.env.TWITCH_CLIENT_ID, Authorization: `Bearer ${token}` },
        params: { language: 'pt', first: 10 }, // Top 10 streams em português
    });
    return res.data.data || [];
}

async function getTopClips(broadcasterId) {
    const token = await getTwitchToken();
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);

    const res = await axios.get(`${TWITCH_API_BASE}/clips`, {
        headers: { 'Client-Id': process.env.TWITCH_CLIENT_ID, Authorization: `Bearer ${token}` },
        params: { broadcaster_id: broadcasterId, started_at: yesterday.toISOString(), first: 5 },
    });
    return res.data.data || [];
}

export async function scoutTwitch() {
    logger.info('[TrendHunter/Twitch] Buscando streams e clips em alta...');
    const topStreams = await getTopStreams();
    let allClips = [];

    for (const stream of topStreams) {
        try {
            const clips = await getTopClips(stream.user_id);
            const formatted = clips.map(c => ({
                platform: 'twitch',
                title: c.title,
                url: c.url,
                views: c.view_count,
                creator: c.broadcaster_name,
                duration: c.duration,
                vod_offset: c.vod_offset,
                video_id: c.video_id,
            }));
            allClips.push(...formatted);
        } catch (err) {
            logger.warn(`[TrendHunter/Twitch] Falha ao buscar clips de ${stream.user_name}: ${err.message}`);
        }
    }

    allClips.sort((a, b) => b.views - a.views);
    logger.success(`[TrendHunter/Twitch] ${allClips.length} clips encontrados e ordenados.`);
    return allClips.slice(0, 15);
}
