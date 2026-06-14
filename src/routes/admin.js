import express from 'express';
import { flushAll } from '../utils/cacheManager.js';
import { runSync } from '../sync/anime_sync.js';
import { syncUnified } from '../sync/unified_sync.js';

const router = express.Router();

// ============================================================
// RUTE 7: GET /api/cache-clear  [DEV only]
// ============================================================
router.get('/api/cache-clear', (req, res) => {
    flushAll();
    res.json({ status: 'ok', message: 'Cache cleared' });
});

// ============================================================
// RUTE 7.5: GET /api/admin/logs/raw  [DATA MENTAH LOG]
// ============================================================
router.get('/api/admin/logs/raw', (req, res) => {
    res.type('text/plain');
    res.send(global.memLogs ? global.memLogs.join('\n') : 'Menunggu log...');
});

// ============================================================
// RUTE 7.6: GET /api/admin/logs  [UI LOG STREAM REAL-TIME]
// ============================================================
router.get('/api/admin/logs', (req, res) => {
    const html = `
    <html>
        <head>
            <title>WibuFlix Live Log Stream</title>
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <style>
                body { background-color: #0d1117; color: #39ff14; font-family: 'Courier New', Courier, monospace; padding: 20px; font-size: 13px; line-height: 1.5; margin: 0; }
                #header { position: fixed; top: 0; left: 0; right: 0; background: #161b22; padding: 10px 20px; border-bottom: 1px solid #30363d; display: flex; justify-content: space-between; align-items: center; }
                h3 { margin: 0; color: #ffffff; }
                .status { color: #39ff14; font-weight: bold; }
                .status.offline { color: #ff3333; }
                pre { white-space: pre-wrap; word-wrap: break-word; margin-top: 50px; padding-bottom: 40px; }
            </style>
        </head>
        <body>
            <div id="header">
                <h3>🚀 WibuFlix Live Terminal</h3>
                <span id="statusIndicator" class="status">● LIVE</span>
            </div>
            <pre id="logbox">Memuat log...</pre>
            <script>
                const logbox = document.getElementById('logbox');
                const statusIndicator = document.getElementById('statusIndicator');
                let autoScroll = true;

                // Cek jika user scroll ke atas, matikan auto-scroll
                window.addEventListener('scroll', () => {
                    const isAtBottom = window.innerHeight + window.scrollY >= document.body.offsetHeight - 10;
                    autoScroll = isAtBottom;
                });

                async function fetchLogs() {
                    try {
                        const response = await fetch('/api/admin/logs/raw');
                        if (!response.ok) throw new Error('Network response was not ok');
                        const text = await response.text();
                        logbox.textContent = text;
                        statusIndicator.textContent = '● LIVE';
                        statusIndicator.className = 'status';
                        if (autoScroll) {
                            window.scrollTo(0, document.body.scrollHeight);
                        }
                    } catch (error) {
                        statusIndicator.textContent = '● TERPUTUS';
                        statusIndicator.className = 'status offline';
                    }
                }

                // Jalankan setiap 2 detik secara halus tanpa berkedip
                setInterval(fetchLogs, 2000);
                fetchLogs();
            </script>
        </body>
    </html>
    `;
    res.send(html);
});

// ============================================================
// ============================================================
// RUTE 8: GET /api/force-sync  [MANUAL TRIGGER]
// ============================================================
router.get('/api/force-sync', (req, res) => {
    res.json({ status: 'ok', message: 'Sinkronisasi paksa (Samehadaku & Unified DB) sedang dijalankan di latar belakang. Proses ini memakan waktu beberapa menit.' });

    // Jalankan asinkron tanpa memblokir request
    import('../sync/otaku_sync.js').then(({ syncOtakudesu }) => {
        Promise.all([
            runSync(true),
            syncOtakudesu()
        ]).then(() => {
            console.log('[ForceSync] Raw Sync selesai. Memulai Unified Sync...');
            return syncUnified();
        }).catch(err => console.error('[ForceSync] Error:', err.message));
    });
});

// ============================================================
// RUTE 8.5: GET /api/retry-enrich  [RETRY FAILED TMDB ENRICHMENT]
// ============================================================
router.get('/api/retry-enrich', async (req, res) => {
    try {
        const Anime = (await import('../models/Anime.js')).default;
        
        // Cari anime yang sudah "diperkaya" tapi datanya masih jelek/kosong
        const result = await Anime.updateMany(
            { 
                tmdbEnriched: true, 
                $or: [
                    { score: '-' },
                    { image: { $regex: /placehold/i } },
                    { image: null },
                    { image: '' }
                ]
            },
            { $set: { tmdbEnriched: false } }
        );

        res.json({ 
            status: 'ok', 
            message: `Berhasil mereset status tmdbEnriched untuk ${result.modifiedCount} anime. Proses Unified Sync sedang dijalankan di latar belakang untuk mencoba ulang pencarian TMDB.` 
        });

        // Jalankan ulang pekerja enrichment
        console.log(`[RetryEnrich] Mereset ${result.modifiedCount} anime. Memulai ulang Unified Sync...`);
        syncUnified().catch(err => console.error('[RetryEnrich] Error:', err.message));

    } catch (error) {
        console.error('[RetryEnrich] Gagal:', error.message);
        res.status(500).json({ error: error.message });
    }
});

// ============================================================
// RUTE 9: GET /api/factory-reset  [HARD RESET DB]
// ============================================================
router.get('/api/factory-reset', async (req, res) => {
    try {
        const Anime = (await import('../models/Anime.js')).default;
        const TMDBCache = (await import('../models/TMDBCache.js')).default;
        
        await Anime.deleteMany({});
        await TMDBCache.deleteMany({});

        // Bersihkan cache memori agar sistem tidak memakai data lama
        if (global.anime_db_cache) global.anime_db_cache = null;
        if (global.otaku_db_cache) global.otaku_db_cache = null;
        
        const { syncOtakudesu } = await import('../sync/otaku_sync.js');

        res.json({ status: 'ok', message: 'BERHASIL! Semua Database MongoDB (Anime & TMDB Cache) telah DIHANCURKAN. Memulai scraping total dari titik nol...' });

        Promise.all([
            runSync(true),
            syncOtakudesu()
        ]).then(() => {
            console.log('[FactoryReset] Raw Sync selesai. Memulai Unified Sync...');
            return syncUnified();
        }).catch(err => console.error('[FactoryReset] Error:', err.message));

    } catch (error) {
        console.error('[FactoryReset] Gagal:', error.message);
        res.status(500).json({ error: error.message });
    }
});

export default router;
