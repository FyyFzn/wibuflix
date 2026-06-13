import express from 'express';
import cors from 'cors';
import { initPagePool } from './puppeteer/pool.js';
import path from 'path';
import { fileURLToPath } from 'url';

import { syncUnified } from './sync/unified_sync.js';
import { startBackgroundAnimeSync } from './sync/anime_sync.js';
import { startBackgroundOtakuSync } from './scraper/otakudesu_sync.js';
import { startBackgroundLatestSync } from './sync/latest_sync.js';

// Route Imports
import katalogRouter from './routes/katalog.js';
import episodesRouter from './routes/episodes.js';
import scrapeRouter from './routes/scrape.js';
import extractRouter from './routes/extract.js';
import proxyRouter from './routes/proxy.js';
import otakudesuRouter from './routes/otakudesu.js';
import adminRouter from './routes/admin.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.set('trust proxy', true); // Fix: agar req.protocol terbaca 'https' di Azure (di belakang proxy)
const PORT = process.env.PORT || 3000;

app.use(cors());
app.set('json spaces', 2);

// Sajikan file statis (HTML, CSS, JS) dari direktori root proyek
app.use(express.static(path.join(__dirname, '../')));

// Mounting Routers
app.use(katalogRouter);
app.use(episodesRouter);
app.use(scrapeRouter);
app.use(extractRouter);
app.use(proxyRouter);
app.use(otakudesuRouter);
app.use(adminRouter);

import connectDB from './config/db.js';

function startServer() {
    // 1. Hubungkan ke MongoDB terlebih dahulu
    connectDB().then(() => {
        // 2. Jalankan Express App
        app.listen(PORT, '0.0.0.0', async () => {
            const log = global.forceLog || console.log;

        const modeText = global.forceLog ? `\n💡 Mode         : PRODUCTION (Log standar dinonaktifkan)` : '';
        const banner = `
=============================================
🚀 WIBUFLIX BACKEND SERVER BERHASIL RESTART!
⏰ Waktu Lokal  : ${new Date().toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' })}
📡 Port Aktif   : ${PORT}${modeText}
=============================================
`;
        // Print sebagai satu kesatuan string (Atomic) agar tidak terselip error/log lain di Azure
        log(banner);

        log('⏳ [Puppeteer] Memulai inisialisasi pool browser...');
        await initPagePool();
        log('✅ [Puppeteer] Pool browser berhasil diinisialisasi dan siap digunakan!\n');

        // Memulai background job
        startBackgroundAnimeSync();
        startBackgroundOtakuSync();
        startBackgroundLatestSync();

        // Mulai proses unified sync (akan berjalan sinkron atau asinkron tanpa memblok server)
        setTimeout(() => {
            syncUnified();
            // Jadwalkan sinkronisasi berulang tiap jam
            setInterval(syncUnified, 60 * 60 * 1000);
        }, 10000); // Tunda 10 detik agar localDb & otakuDb selesai di-load

        });
    });
}

export { startServer };
