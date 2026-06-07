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

function extractTitleAndSuffix(rawTitle) {
    const originalTitle = rawTitle.toLowerCase();
    let suffix = "";
    let cleanTitle = rawTitle;

    const sMatch = originalTitle.match(/season\s*(\d+)/i) || originalTitle.match(/(\d+)(?:st|nd|rd|th)\s*season/i);
    if (sMatch) {
        suffix = ` s${sMatch[1]}`;
        cleanTitle = cleanTitle.replace(new RegExp(sMatch[0], 'i'), '').trim();
    }
    const pMatch = originalTitle.match(/part\s*(\d+)/i);
    if (pMatch) {
        suffix += ` p${pMatch[1]}`;
        cleanTitle = cleanTitle.replace(new RegExp(pMatch[0], 'i'), '').trim();
    }
    if (originalTitle.includes('ova')) {
        suffix += ` ova`;
        cleanTitle = cleanTitle.replace(/ova/i, '').trim();
    }
    if (originalTitle.includes('movie')) {
        suffix += ` movie`;
        cleanTitle = cleanTitle.replace(/movie/i, '').trim();
    }
    
    // Clean up trailing dashes or colons
    cleanTitle = cleanTitle.replace(/[-:]\s*$/, '').trim();

    return { cleanTitle, suffix, originalTitle };
}

async function syncUnified() {
    log('[UnifiedSync] Memulai pembuatan Unified Database...');
    try {
        const samehadakuDb = loadLocalDatabase();
        const otakuDb = loadOtakuDatabase();

        const unifiedMap = new Map(); // Key: TMDB title (lowercased)
        
        log(`[UnifiedSync] Memproses ${samehadakuDb.length} data Samehadaku...`);
        for (let i = 0; i < samehadakuDb.length; i++) {
            const item = samehadakuDb[i];
            const { cleanTitle, suffix, originalTitle } = extractTitleAndSuffix(item.judul);
            
            // Cari TMDB menggunakan judul bersih tanpa tulisan "Season X"
            const tmdbData = await searchTMDB(cleanTitle);
            
            // Jeda agar tidak terkena rate limit TMDB (jika tidak dari cache)
            await new Promise(r => setTimeout(r, 50)); 
            
            const baseKey = tmdbData ? tmdbData.title.toLowerCase() : originalTitle;
            const unifiedKey = baseKey + suffix;
            
            const finalTitle = tmdbData ? (tmdbData.title + (suffix ? ' ' + suffix.trim().toUpperCase() : '')) : item.judul;
            const finalImage = (suffix && item.gambar) ? item.gambar : ((tmdbData && tmdbData.image) ? tmdbData.image : item.gambar);

            if (!unifiedMap.has(unifiedKey)) {
                unifiedMap.set(unifiedKey, {
                    title: finalTitle,
                    image: finalImage,
                    score: tmdbData ? tmdbData.score : (item.skor || '-'),
                    type: tmdbData ? tmdbData.type : (item.tipe || 'Anime'),
                    status: tmdbData ? tmdbData.status : (item.status || '-'),
                    aliases: tmdbData && tmdbData.aliases ? tmdbData.aliases : [],
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
            const { cleanTitle, suffix, originalTitle } = extractTitleAndSuffix(item.title);
            
            const tmdbData = await searchTMDB(cleanTitle);
            
            await new Promise(r => setTimeout(r, 50));
            
            const baseKey = tmdbData ? tmdbData.title.toLowerCase() : originalTitle;
            const unifiedKey = baseKey + suffix;
            
            const finalTitle = tmdbData ? (tmdbData.title + (suffix ? ' ' + suffix.trim().toUpperCase() : '')) : item.title;
            const finalImage = (suffix && item.gambar) ? item.gambar : ((tmdbData && tmdbData.image) ? tmdbData.image : (item.gambar || 'https://placehold.co/300x450/1a1a2e/ffffff?text=No+Image'));

            if (!unifiedMap.has(unifiedKey)) {
                unifiedMap.set(unifiedKey, {
                    title: finalTitle,
                    image: finalImage,
                    score: tmdbData ? tmdbData.score : '-',
                    type: tmdbData ? tmdbData.type : 'Anime',
                    status: tmdbData ? tmdbData.status : '-',
                    aliases: tmdbData && tmdbData.aliases ? tmdbData.aliases : [],
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
