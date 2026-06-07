const fs = require('fs');
const path = require('path');
const { loadLocalDatabase } = require('./anime_sync');
const { loadOtakuDatabase } = require('../scraper/otakudesu_sync');
const { searchTMDB, saveTMDBCache } = require('../api/tmdb');
const { getDataDir } = require('../utils/pathUtils');

const DB_PATH = path.join(getDataDir(), 'unified_db.json');

const log = (...args) => {
    if (global.forceLog) {
        global.forceLog(...args);
    } else {
        console.log(...args);
    }
};

async function syncUnified() {
    log('[UnifiedSync] Memulai pembuatan Unified Database...');
    try {
        const samehadakuDb = loadLocalDatabase();
        const otakuDb = loadOtakuDatabase();

        const unifiedMap = new Map(); // Key: TMDB title (lowercased)
        
        log(`[UnifiedSync] Memproses ${samehadakuDb.length} data Samehadaku...`);
        for (let i = 0; i < samehadakuDb.length; i++) {
            const item = samehadakuDb[i];
            const tmdbData = await searchTMDB(item.judul);
            
            // Jeda agar tidak terkena rate limit TMDB (jika tidak dari cache)
            await new Promise(r => setTimeout(r, 50)); 
            
            // Smart Season Detector: Pisahkan S1, S2, dsb. agar tidak tergabung oleh TMDB
            const originalTitle = item.judul.toLowerCase();
            let suffix = "";
            const sMatch = originalTitle.match(/season\s*(\d+)/) || originalTitle.match(/(\d+)(?:st|nd|rd|th)\s*season/);
            if (sMatch) suffix = ` s${sMatch[1]}`;
            const pMatch = originalTitle.match(/part\s*(\d+)/);
            if (pMatch) suffix += ` p${pMatch[1]}`;
            if (originalTitle.includes('ova')) suffix += ` ova`;
            if (originalTitle.includes('movie')) suffix += ` movie`;

            const baseKey = tmdbData ? tmdbData.title.toLowerCase() : originalTitle;
            const unifiedKey = baseKey + suffix;
            
            if (!unifiedMap.has(unifiedKey)) {
                unifiedMap.set(unifiedKey, {
                    title: tmdbData ? tmdbData.title : item.judul,
                    image: tmdbData ? tmdbData.image : item.gambar,
                    score: tmdbData ? tmdbData.score : (item.skor || '-'),
                    type: tmdbData ? tmdbData.tipe : (item.tipe || 'Anime'),
                    status: tmdbData ? tmdbData.status : (item.status || '-'),
                    sources: {
                        samehadaku: {
                            url: item.url,
                            id: item.url.split('/').filter(Boolean).pop()
                        }
                    }
                });
            } else {
                // Sangat jarang Samehadaku duplikat internal, tapi just in case
                const existing = unifiedMap.get(unifiedKey);
                existing.sources.samehadaku = {
                    url: item.url,
                    id: item.url.split('/').filter(Boolean).pop()
                };
            }
        }
        
        log(`[UnifiedSync] Memproses ${otakuDb.length} data Otakudesu...`);
        for (let i = 0; i < otakuDb.length; i++) {
            const item = otakuDb[i];
            const tmdbData = await searchTMDB(item.title);
            
            await new Promise(r => setTimeout(r, 50));
            
            // Smart Season Detector: Pisahkan S1, S2, dsb. agar tidak tergabung oleh TMDB
            const originalTitle = item.title.toLowerCase();
            let suffix = "";
            const sMatch = originalTitle.match(/season\s*(\d+)/) || originalTitle.match(/(\d+)(?:st|nd|rd|th)\s*season/);
            if (sMatch) suffix = ` s${sMatch[1]}`;
            const pMatch = originalTitle.match(/part\s*(\d+)/);
            if (pMatch) suffix += ` p${pMatch[1]}`;
            if (originalTitle.includes('ova')) suffix += ` ova`;
            if (originalTitle.includes('movie')) suffix += ` movie`;

            const baseKey = tmdbData ? tmdbData.title.toLowerCase() : originalTitle;
            const unifiedKey = baseKey + suffix;
            
            if (!unifiedMap.has(unifiedKey)) {
                unifiedMap.set(unifiedKey, {
                    title: tmdbData ? tmdbData.title : item.title,
                    image: tmdbData ? tmdbData.image : 'https://placehold.co/300x450/1a1a2e/ffffff?text=No+Image',
                    score: tmdbData ? tmdbData.score : '-',
                    type: tmdbData ? tmdbData.tipe : 'Anime',
                    status: tmdbData ? tmdbData.status : '-',
                    sources: {
                        otakudesu: {
                            url: item.url,
                            id: item.id
                        }
                    }
                });
            } else {
                // Merge dengan data Samehadaku yang sudah ada!
                const existing = unifiedMap.get(unifiedKey);
                existing.sources.otakudesu = {
                    url: item.url,
                    id: item.id
                };
            }
        }
        
        const unifiedArray = Array.from(unifiedMap.values());
        
        // Simpan ke unified_db.json
        const dbDir = path.dirname(DB_PATH);
        if (!fs.existsSync(dbDir)) fs.mkdirSync(dbDir, { recursive: true });
        
        fs.writeFileSync(DB_PATH, JSON.stringify(unifiedArray, null, 2));
        log(`[UnifiedSync] Berhasil menyimpan ${unifiedArray.length} entri ke Unified Database!`);
        
        // Simpan cache TMDB ke disk
        saveTMDBCache();
        log('[UnifiedSync] Cache TMDB berhasil disimpan ke disk.');

    } catch (err) {
        console.error('[UnifiedSync] Error:', err.message);
    }
}

function loadUnifiedDatabase() {
    if (fs.existsSync(DB_PATH)) {
        try {
            const raw = fs.readFileSync(DB_PATH, 'utf-8');
            return JSON.parse(raw);
        } catch(e) {
            console.error("[Unified DB] Gagal membaca JSON:", e.message);
            return [];
        }
    }
    return [];
}

// Jika dijalankan langsung
if (require.main === module) {
    syncUnified().then(() => process.exit(0));
}

module.exports = { syncUnified, loadUnifiedDatabase };
