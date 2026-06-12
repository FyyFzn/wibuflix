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

// ============================================================
// RUTE 9: GET /api/factory-reset  [HARD RESET DB]
// ============================================================
router.get('/api/factory-reset', async (req, res) => {
    try {
        const { getDataDir } = await import('../utils/pathUtils.js');
        const fs = await import('fs');
        const path = await import('path');
        
        const dataDir = getDataDir();
        const unifiedPath = path.join(dataDir, 'unified_db.json');
        const tmdbPath = path.join(dataDir, 'tmdb_cache.json');
        
        if (fs.existsSync(unifiedPath)) fs.unlinkSync(unifiedPath);
        if (fs.existsSync(tmdbPath)) fs.unlinkSync(tmdbPath);
        
        res.json({ status: 'ok', message: 'BERHASIL! Database Unified & TMDB Cache lama yang tercemar telah DIHANCURKAN. Proses pembangunan ulang (Rebuild) dimulai di latar belakang.' });
        
        runSync(true).then(() => {
            console.log('[FactoryReset] Anime Sync selesai. Memulai Unified Sync...');
            return syncUnified();
        }).catch(err => console.error('[FactoryReset] Error:', err.message));
        
    } catch (e) {
        res.status(500).json({ status: 'error', message: e.message });
    }
});

export default router;
