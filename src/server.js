import express from 'express';
import cors from 'cors';
import { initPagePool, closeAllBrowsers } from './puppeteer/pool.js';
import path from 'path';
import { fileURLToPath } from 'url';
import { backgroundQueue } from './utils/queueManager.js';
import connectDB from './config/db.js';
import mongoose from 'mongoose';
import fs from 'fs';
import os from 'os';
import { cancelAllUploads } from './utils/azureUploader.js';

import { initScheduler } from './jobs/scheduler.js';
import { errorHandler } from './middlewares/errorHandler.js';
import { ssrfMiddleware } from './middlewares/urlValidator.js';

// Route Imports
import katalogRouter from './routes/katalog.js';
import episodesRouter from './routes/episodes.js';
import scrapeRouter from './routes/scrape.js';
import extractRouter from './routes/extract.js';
import proxyRouter from './routes/proxy.js';
import otakudesuRouter from './routes/otakudesu.js';
import kuronimeRouter from './routes/kuronime.js';
import adminRouter from './routes/admin.js';
import v2Router from './routes/v2.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const APP_TMP_DIR = path.join(os.tmpdir(), 'wibuflix_temp');
if (!fs.existsSync(APP_TMP_DIR)) {
    fs.mkdirSync(APP_TMP_DIR, { recursive: true });
}

export function sweepOrphanedTempFiles() {
    console.log('[System] Menyapu file sampah dari sesi sebelumnya...');
    fs.readdir(APP_TMP_DIR, (err, files) => {
        if (err) return console.warn('[System] Gagal memindai direktori temp:', err.message);
        files.forEach(file => {
            const fullPath = path.join(APP_TMP_DIR, file);
            fs.rm(fullPath, { recursive: true, force: true }, err => {
                if (err && err.code !== 'ENOENT') console.warn(`Gagal menghapus: ${file}`);
            });
        });
    });
}

async function gracefulShutdown(signal) {
    console.warn(`[System] Menerima ${signal}. Memulai Graceful Shutdown...`);
    try {
        cancelAllUploads('player');
        cancelAllUploads('prefetch');
        
        // 1. Matikan koneksi DB dengan aman
        await mongoose.connection.close(false);
        console.log('[System] Koneksi MongoDB ditutup.');

        // 2. Bersihkan Browser Puppeteer jika ada instance yang jalan
        await closeAllBrowsers();
        console.log('[System] Browser Puppeteer ditutup.');
        
        process.exit(0);
    } catch (e) {
        console.error('[System] Error saat shutdown:', e);
        process.exit(1);
    }
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

const app = express();
app.set('trust proxy', true); // Fix: agar req.protocol terbaca 'https' di Azure (di belakang proxy)
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.set('json spaces', 2);

// SSRF Protection Middleware
app.use(ssrfMiddleware);

// Sajikan file statis (HTML, CSS, JS) dari direktori root proyek
app.use(express.static(path.join(__dirname, '../')));

// Mounting Routers
app.use(v2Router);
app.use(katalogRouter);
app.use(episodesRouter);
app.use(scrapeRouter);
app.use(extractRouter);
app.use(proxyRouter);
app.use(otakudesuRouter);
app.use(kuronimeRouter);
app.use(adminRouter);


// Global Error Handler Middleware (Harus diletakkan setelah semua router)
app.use(errorHandler);

function startServer() {
    sweepOrphanedTempFiles();
    // 1. Hubungkan ke MongoDB terlebih dahulu
    connectDB().then(() => {
        // 2. Jalankan Express App
        app.listen(PORT, '0.0.0.0', async () => {
            const log = typeof global.forceLog === 'function' ? global.forceLog : console.log;

        const modeText = typeof global.forceLog === 'function'
          ? `\n💡 Mode         : PRODUCTION (Log standar dinonaktifkan)`
          : '';
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
        try {
            await initPagePool();
            log('✅ [Puppeteer] Pool browser berhasil diinisialisasi dan siap digunakan!\n');
        } catch (err) {
            log('❌ [Puppeteer] Gagal inisialisasi pool browser pada startup:', err.message);
        }

        // Lanjutkan antrean download HLS yang mungkin terputus saat server restart
        backgroundQueue.resumeOrphanedTasks().catch(err => console.error("Error resuming orphaned tasks:", err));

        // Memulai semua jadwal background jobs
        initScheduler();

        });
    }).catch(err => {
        // JIKA MONGODB GAGAL (MISAL KARENA IP DIBLOKIR), JALANKAN SAJA SERVERNYA AGAR LOG BISA DILIHAT!
        console.error("❌ [FATAL] GAGAL TERHUBUNG KE MONGODB PADA SAAT STARTUP!", err.message);
        
        app.listen(PORT, '0.0.0.0', () => {
            console.log(`Server berjalan di port ${PORT} (DALAM KEADAAN MONGODB MATI/ERROR)`);
        });
    });
}

export { startServer };
