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
    const originalTitle = rawTitle.toLowerCase();
    
    // Normalisasi ekstrim: buang semua kurung siku, kurung biasa, dan simbol
    let cleanTitle = rawTitle.replace(/[\[\]【】()]/g, '');
    let suffix = "";

    const sMatch = originalTitle.match(/season\s*(\d+)/i) || originalTitle.match(/(\d+)(?:st|nd|rd|th)\s*season/i) || originalTitle.match(/\bs\s*(\d+)\b/i);
    if (sMatch) {
        suffix = ` s${sMatch[1]}`;
        cleanTitle = cleanTitle.replace(new RegExp(sMatch[0], 'i'), '').trim();
    }
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

const normalizeForMatch = (str) => str.toLowerCase().replace(/[^a-z0-9]/g, '');

export async function syncUnified() {
    log('[UnifiedSync] Memulai pembuatan/update Unified Database...');
    try {
        const samehadakuDb = loadLocalDatabase();
        const otakuDb = loadOtakuDatabase();
        
        const existingDb = loadUnifiedDatabase();
        const unifiedMap = new Map();
        
        const findExistingEntry = (title, aliases, targetSuffix) => {
            const searchTerms = [title, ...(aliases || [])].map(normalizeForMatch).filter(Boolean);
            for (const existing of existingDb) {
                const { suffix: existingSuffix } = extractTitleAndSuffix(existing.title);
                if (existingSuffix !== targetSuffix) continue; // Pastikan beda season TIDAK menimpa satu sama lain

                const existingTerms = [existing.title, ...(existing.aliases || [])].map(normalizeForMatch).filter(Boolean);
                const hasIntersection = searchTerms.some(term => existingTerms.includes(term));
                if (hasIntersection) {
                    return existing;
                }
            }
            return null;
        };

        for (const item of existingDb) {
            const { cleanTitle, suffix } = extractTitleAndSuffix(item.title);
            const key = normalizeForMatch(cleanTitle) + suffix; 
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
            
            let unifiedKey;
            if (existingEntry) {
                const extInfo = extractTitleAndSuffix(existingEntry.title);
                unifiedKey = normalizeForMatch(extInfo.cleanTitle) + extInfo.suffix;
            } else {
                const baseKey = tmdbData ? normalizeForMatch(extractTitleAndSuffix(tmdbData.title).cleanTitle) : normalizeForMatch(cleanTitle);
                unifiedKey = baseKey + suffix;
            }
            
            if (existingEntry) {
                // Update source samehadaku
                if (!existingEntry.sources) existingEntry.sources = {};
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
            
            let unifiedKey;
            if (existingEntry) {
                const extInfo = extractTitleAndSuffix(existingEntry.title);
                unifiedKey = normalizeForMatch(extInfo.cleanTitle) + extInfo.suffix;
            } else {
                const baseKey = tmdbData ? normalizeForMatch(extractTitleAndSuffix(tmdbData.title).cleanTitle) : normalizeForMatch(cleanTitle);
                unifiedKey = baseKey + suffix;
            }
            
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

        // Bersihkan seluruh cache API (seperti /api/katalog) agar aplikasi frontend langsung menerima data baru tanpa harus menunggu 1 jam
        try {
            const { flushAll } = await import('../utils/cacheManager.js');
            flushAll();
            log('[UnifiedSync] Berhasil menghapus cache API di memori. Pembaruan akan langsung terlihat di aplikasi!');
        } catch (cacheErr) {
            log('[UnifiedSync] Gagal menghapus cache API:', cacheErr.message);
        }

    } catch (err) {
        console.error('[UnifiedSync] Error:', err.message);
    }
}

// Jika dijalankan langsung
if (process.argv[1] && fileURLToPath(import.meta.url) === fs.realpathSync(process.argv[1])) {
    syncUnified().then(() => process.exit(0));
}
