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
    // Normalisasi kurung jepang ke kurung siku biasa agar lebih seragam
    rawTitle = rawTitle.replace(/【/g, '[').replace(/】/g, ']');
    const originalTitle = rawTitle.toLowerCase();
    let suffix = "";
    let cleanTitle = rawTitle;

    // Tambahkan deteksi \bs\s*(\d+)\b untuk mendeteksi "S2", "S3"
    const sMatch = originalTitle.match(/season\s*(\d+)/i) || originalTitle.match(/(\d+)(?:st|nd|rd|th)\s*season/i) || originalTitle.match(/\bs\s*(\d+)\b/i);
    if (sMatch) {
        suffix = ` s${sMatch[1]}`;
        cleanTitle = cleanTitle.replace(new RegExp(sMatch[0], 'i'), '').trim();
    }
    // Tambahkan deteksi \bp\s*(\d+)\b untuk mendeteksi "P2", "Part 2"
    const pMatch = originalTitle.match(/part\s*(\d+)/i) || originalTitle.match(/\bp\s*(\d+)\b/i);
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
            
            const baseKey = tmdbData ? tmdbData.title.toLowerCase() : originalTitle;
            const unifiedKey = baseKey + suffix;
            
            const finalTitle = tmdbData ? (tmdbData.title + (suffix ? ' ' + suffix.trim().toUpperCase() : '')) : item.judul;
            const finalImage = (suffix && item.gambar) ? item.gambar : ((tmdbData && tmdbData.image) ? tmdbData.image : item.gambar);

            let finalAliases = tmdbData && tmdbData.aliases ? [...tmdbData.aliases] : [];
            if (item.judul) finalAliases.push(item.judul);
            if (cleanTitle) finalAliases.push(cleanTitle);
            finalAliases = [...new Set(finalAliases.filter(Boolean))];

            if (!unifiedMap.has(unifiedKey)) {
                unifiedMap.set(unifiedKey, {
                    title: finalTitle,
                    image: finalImage,
                    score: tmdbData ? tmdbData.score : (item.skor || '-'),
                    type: tmdbData ? tmdbData.type : (item.tipe || 'Anime'),
                    status: tmdbData ? tmdbData.status : (item.status || '-'),
                    aliases: finalAliases,
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
            
            const baseKey = tmdbData ? tmdbData.title.toLowerCase() : originalTitle;
            let unifiedKey = baseKey + suffix;
            
            // FUZZY MATCH FALLBACK (Bug Fix Card Kosong)
            // Jika pencarian TMDB gagal, dan exact match key tidak ada, cari yang mirip > 70%
            if (!tmdbData && !unifiedMap.has(unifiedKey)) {
                const existingKeys = Array.from(unifiedMap.keys());
                if (existingKeys.length > 0) {
                    // Hanya bandingkan dengan kunci yang memiliki suffix yang sama agar tidak salah merge beda season
                    const sameSuffixKeys = existingKeys.filter(k => k.endsWith(suffix));
                    if (sameSuffixKeys.length > 0) {
                        const stringSimilarity = require('string-similarity');
                        const matches = stringSimilarity.findBestMatch(unifiedKey, sameSuffixKeys);
                        if (matches.bestMatch.rating > 0.7) {
                            unifiedKey = matches.bestMatch.target;
                            log(`[UnifiedSync] Merged by fuzzy match: "${originalTitle}" -> "${unifiedKey}" (${(matches.bestMatch.rating*100).toFixed(1)}%)`);
                        }
                    }
                }
            }
            
            const finalTitle = tmdbData ? (tmdbData.title + (suffix ? ' ' + suffix.trim().toUpperCase() : '')) : item.title;
            const finalImage = (suffix && item.gambar) ? item.gambar : ((tmdbData && tmdbData.image) ? tmdbData.image : (item.gambar || 'https://placehold.co/300x450/1a1a2e/ffffff?text=No+Image'));

            let finalAliases = tmdbData && tmdbData.aliases ? [...tmdbData.aliases] : [];
            if (item.title) finalAliases.push(item.title);
            if (cleanTitle) finalAliases.push(cleanTitle);
            finalAliases = [...new Set(finalAliases.filter(Boolean))];

            if (!unifiedMap.has(unifiedKey)) {
                unifiedMap.set(unifiedKey, {
                    title: finalTitle,
                    image: finalImage,
                    score: tmdbData ? tmdbData.score : '-',
                    type: tmdbData ? tmdbData.type : 'Anime',
                    status: tmdbData ? tmdbData.status : '-',
                    aliases: finalAliases,
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
                // Timpa gambar jika saat ini masih menggunakan placeholder / kosong
                if ((!existing.image || existing.image.includes('placehold.co')) && item.gambar) {
                    existing.image = item.gambar;
                }
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
