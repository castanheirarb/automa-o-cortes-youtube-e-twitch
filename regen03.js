// Regenera um clipe num timestamp específico de um URL do YouTube
// Uso temporário — pode deletar após usar
import 'dotenv/config';
import { processClip, initBinaries } from './src/processor/ffmpeg.js';

initBinaries();
await processClip({
    videoUrl: 'https://www.youtube.com/watch?v=o-6S1pEcIfg',
    peakTime: 1679,
    title: 'live balestrin e cariani',
    duration: undefined,
}, 3, 15);

console.log('Clipe 03 regenerado em ./output/live balestrin e cariani/');
