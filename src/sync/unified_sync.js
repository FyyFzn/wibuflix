import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import stringSimilarity from 'string-similarity';
import { loadLocalDatabase } from './anime_sync.js';
import { loadOtakuDatabase } from '../scraper/otakudesu_sync.js';
import { searchTMDB, saveTMDBCache } from '../api/tmdb.js';
import { getDataDir } from '../utils/pathUtils.js';

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

export function loadUnifiedDatabase() {
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

async function processInBatches(items, batchSize, processor) {
    const results = [];
    for (let i = 0; i < items.length; i += batchSize) {
        const batch = items.slice(i, i + batchSize);
        const batchResults = await Promise.all(batch.map(processor));
        results.push(...batchResults);
    }
    return results;
}

export async function syncUnified() {
    log('[UnifiedSync] Memulai pembuatan/update Unified Database...');
    try {
        const samehadakuDb = loadLocalDatabase();
        const otakuDb = loadOtakuDatabase();
        
        // Load existing database to enable Delta Sync
        const existingDb = loadUnifiedDatabase();
        const unifiedMap = new Map();
        
        // Populate map with existing entries
        existingDb.forEach(item => {
            // Kita butuh key asli, karena struktur DB akhir tidak menyimpan key secara eksplisit, 
            // kita gunakan title lowercase + suffix sebagai pendekatan. 
            // Namun, saat iterasi Samehadaku/Otaku nanti, jika ditemukan, kita akan perbarui.
            // Paling aman: kita inisialisasi Map dengan entry yang sudah ada.
            // Key yang tepat adalah yang dihasilkan dari proses ekstrak.
            // Kita akan cocokkan berdasarkan 'aliases' atau 'title' nanti.
        });
        
        // Helper: Find existing entry
        const findExistingEntry = (title, aliases, suffix) => {
            const searchTerms = [title.toLowerCase(), ...(aliases || []).map(a => a.toLowerCase())];
            for (const existing of existingDb) {
                const existingTerms = [existing.title.toLowerCase(), ...(existing.aliases || []).map(a => a.toLowerCase())];
                const hasIntersection = searchTerms.some(term => existingTerms.includes(term));
                if (hasIntersection) {
                    return existing; // Return referensi ke objek existing
                }
            }
            return null;
        };

        // Karena struktur key sebelumnya dinamis, kita bangun ulang unifiedMap dengan data existing
        for (const item of existingDb) {
            const key = item.title.toLowerCase(); 
            unifiedMap.set(key, item);
        }

        log(`[UnifiedSync] Memproses ${samehadakuDb.length} data Samehadaku (Delta & Batching)...`);
        
        await processInBatches(samehadakuDb, 5, async (item) => {
            const { cleanTitle, suffix, originalTitle } = extractTitleAndSuffix(item.judul);
            
            // Delta Check
            let existingEntry = findExistingEntry(item.judul, [cleanTitle], suffix);
            
            let tmdbData = null;
            if (!existingEntry) {
                tmdbData = await searchTMDB(cleanTitle);
            }
            
            const baseKey = existingEntry ? existingEntry.title.toLowerCase() : (tmdbData ? tmdbData.title.toLowerCase() : originalTitle);
            const unifiedKey = baseKey + suffix;
            
            if (existingEntry) {
                // Update source samehadaku
                existingEntry.sources.samehadaku = {
                    url: item.url,
                    id: item.url.split('/').filter(Boolean).pop()
                };
                unifiedMap.set(unifiedKey, existingEntry);
            } else {
                const finalTitle = tmdbData ? (tmdbData.title + (suffix ? ' ' + suffix.trim().toUpperCase() : '')) : item.judul;
                const finalImage = (suffix && item.gambar) ? item.gambar : ((tmdbData && tmdbData.image) ? tmdbData.image : item.gambar);

                let finalAliases = tmdbData && tmdbData.aliases ? [...tmdbData.aliases] : [];
                if (item.judul) finalAliases.push(item.judul);
                if (cleanTitle) finalAliases.push(cleanTitle);
                finalAliases = [...new Set(finalAliases.filter(Boolean))];

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
            }
        });
        
        log(`[UnifiedSync] Memproses ${otakuDb.length} data Otakudesu (Delta & Batching)...`);
        
        await processInBatches(otakuDb, 5, async (item) => {
            const { cleanTitle, suffix, originalTitle } = extractTitleAndSuffix(item.title);
            
            // Delta Check
            let existingEntry = findExistingEntry(item.title, [cleanTitle], suffix);
            
            let tmdbData = null;
            if (!existingEntry) {
                tmdbData = await searchTMDB(cleanTitle);
            }
            
            const baseKey = existingEntry ? existingEntry.title.toLowerCase() : (tmdbData ? tmdbData.title.toLowerCase() : originalTitle);
            let unifiedKey = baseKey + suffix;
            
            // FUZZY MATCH FALLBACK
            if (!tmdbData && !existingEntry && !unifiedMap.has(unifiedKey)) {
                const existingKeys = Array.from(unifiedMap.keys());
                if (existingKeys.length > 0) {
                    const sameSuffixKeys = existingKeys.filter(k => k.endsWith(suffix));
                    if (sameSuffixKeys.length > 0) {
                        const matches = stringSimilarity.findBestMatch(unifiedKey, sameSuffixKeys);
                        if (matches.bestMatch.rating > 0.7) {
                            unifiedKey = matches.bestMatch.target;
                            existingEntry = unifiedMap.get(unifiedKey);
                        }
                    }
                }
            }
            
            if (existingEntry || unifiedMap.has(unifiedKey)) {
                const existing = existingEntry || unifiedMap.get(unifiedKey);
                if (!existing.sources) existing.sources = {};
                existing.sources.otakudesu = {
                    url: item.url,
                    id: item.id
                };
                if ((!existing.image || existing.image.includes('placehold.co')) && item.gambar) {
                    existing.image = item.gambar;
                }
                unifiedMap.set(unifiedKey, existing);
            } else {
                const finalTitle = tmdbData ? (tmdbData.title + (suffix ? ' ' + suffix.trim().toUpperCase() : '')) : item.title;
                const finalImage = (suffix && item.gambar) ? item.gambar : ((tmdbData && tmdbData.image) ? tmdbData.image : (item.gambar || 'https://placehold.co/300x450/1a1a2e/ffffff?text=No+Image'));

                let finalAliases = tmdbData && tmdbData.aliases ? [...tmdbData.aliases] : [];
                if (item.title) finalAliases.push(item.title);
                if (cleanTitle) finalAliases.push(cleanTitle);
                finalAliases = [...new Set(finalAliases.filter(Boolean))];

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
            }
        });
        
        // Remove duplicates by ID (fallback cleanup)
        const uniqueValues = Array.from(unifiedMap.values());
        
        // Simpan ke unified_db.json
        const dbDir = path.dirname(DB_PATH);
        if (!fs.existsSync(dbDir)) fs.mkdirSync(dbDir, { recursive: true });
        
        fs.writeFileSync(DB_PATH, JSON.stringify(uniqueValues, null, 2));
        log(`[UnifiedSync] Berhasil menyimpan ${uniqueValues.length} entri ke Unified Database!`);
        
        // Simpan cache TMDB ke disk
        saveTMDBCache();
        log('[UnifiedSync] Cache TMDB berhasil disimpan ke disk.');

    } catch (err) {
        console.error('[UnifiedSync] Error:', err.message);
    }
}

// Jika dijalankan langsung
if (process.argv[1] && fileURLToPath(import.meta.url) === fs.realpathSync(process.argv[1])) {
    syncUnified().then(() => process.exit(0));
}
