import { initLogger } from './utils/logger.js';
initLogger({
    productionSilent: process.env.NODE_ENV === 'production' || process.env.PROD_SILENT === 'true'
});

process.on('uncaughtException', (err) => {
    console.error('[FATAL] Uncaught Exception:', err);
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('[FATAL] Unhandled Rejection at:', promise, 'reason:', reason);
});

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
import { cancelAllUploads } from './services/stream/uploadProgressService.js';

import { initScheduler } from './jobs/scheduler.js';
import { errorHandler } from './middlewares/errorHandler.js';
import { ssrfMiddleware } from './middlewares/urlValidator.js';

// Route Imports
import katalogRouter from './routes/katalog.js';
import scrapeRouter from './routes/scrape.js';
import extractRouter from './routes/extract.js';
import proxyRouter from './routes/proxy.js';
import adminRouter from './routes/admin.js';
import v2Router from './routes/v2.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

import { sweepOrphanedTempFiles, ensureAppTmpDir } from './utils/tempFileCleanupWorker.js';
export { sweepOrphanedTempFiles };
ensureAppTmpDir();

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
app.use(scrapeRouter);
app.use(extractRouter);
app.use(proxyRouter);
app.use(adminRouter);


// Global Error Handler Middleware (Harus diletakkan setelah semua router)
app.use(errorHandler);

let isServerStarted = false;
function startServer() {
    if (isServerStarted) return;
    isServerStarted = true;
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

        // Memulai semua jadwal background jobs langsung tanpa diblokir oleh Puppeteer
        initScheduler();

        // Lanjutkan antrean download HLS yang mungkin terputus saat server restart
        backgroundQueue.resumeOrphanedTasks().catch(err => console.error("Error resuming orphaned tasks:", err));

        log('⏳ [Puppeteer] Memulai inisialisasi pool browser (di latar belakang)...');
        initPagePool().then(() => {
            log('✅ [Puppeteer] Pool browser berhasil diinisialisasi dan siap digunakan!\n');
        }).catch(err => {
            log('❌ [Puppeteer] Gagal inisialisasi pool browser pada startup:', err.message);
        });

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

if (!process.argv[1]?.endsWith('server-prod.js')) {
    startServer();
}


