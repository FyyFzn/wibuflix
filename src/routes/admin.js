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
// RUTE 8: GET /api/force-sync  [MANUAL TRIGGER]
// ============================================================
router.get('/api/force-sync', (req, res) => {
    res.json({ status: 'ok', message: 'Sinkronisasi paksa (Samehadaku & Unified DB) sedang dijalankan di latar belakang. Proses ini memakan waktu beberapa menit.' });
    
    // Jalankan asinkron tanpa memblokir request
    runSync(true).then(() => {
        console.log('[ForceSync] Anime Sync selesai. Memulai Unified Sync...');
        return syncUnified();
    }).catch(err => console.error('[ForceSync] Error:', err.message));
});

export default router;
