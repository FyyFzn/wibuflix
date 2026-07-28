import axios from 'axios';
import * as cheerio from 'cheerio';
import { fileURLToPath } from 'url';
import Anime from '../models/Anime.js'; // Model MongoDB
import { PROVIDER_URLS } from '../config/providerUrls.js';

const log = (...args) => {
    if (global.forceLog) {
        global.forceLog(...args);
    } else {
        console.log(...args);
    }
};

export async function syncOtakudesu() {
    log('[OtakuSync] Memulai sinkronisasi katalog Otakudesu...');
    try {
        const { data } = await axios.get(PROVIDER_URLS.OTAKUDESU.CATALOG_URL, {
            headers: {

                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
            },
            timeout: 15000
        });

        const $ = cheerio.load(data);
        const list = [];
        
        $('.penzbar .jdlbar ul li a').each((_, el) => {
            let title = $(el).text().trim();
            const url = $(el).attr('href');
            if (title && url) {
                const parts = url.split('/').filter(Boolean);
                const slug = parts[parts.length - 1];
                
                // Bersihkan embel-embel agar bisa dicocokkan dengan Samehadaku
                title = title.replace(/\s*Subtitle\s*Indonesia\s*/i, '')
                             .replace(/\s*Sub\s*Indo\s*/i, '')
                             .replace(/\s*On-Going\s*/i, '')
                             .replace(/\s*Ongoing\s*/i, '')
                             .replace(/\s*Batch\s*/i, '')
                             .trim();
                
                list.push({
                    title: title,
                    url: url,
                    slug: slug,
                    id: `otakudesu:${slug}`
                });
            }
        });

        if (list.length > 0) {
            global.otakudesu_db_cache = list;
            
            try {
                // 1. Pre-fetch seluruh database untuk Fuzzy Matching (Hindari menyentuh data Tokusatsu dari Neosatsu)
                const existingAnimes = await Anime.find({ type: { $ne: 'Toku' } }, { title: 1, aliases: 1, 'sourceUrls': 1 }).lean();
                const { normalizeTitleForMatch, isSafeToMerge } = await import('../utils/stringUtils.js');
                
                const now = Date.now();
                const bulkOps = [];
                
                // Buat Set berisi semua URL yang sudah ada di database (O(1) lookup)
                const existingUrls = new Set();
                existingAnimes.forEach(doc => {
                    if (doc.sourceUrls) doc.sourceUrls.forEach(u => existingUrls.add(u));
                });
                
                for (let i = 0; i < list.length; i++) {
                    if (i % 25 === 0) await new Promise(r => setImmediate(r));
                    
                    const anime = list[i];
                    const normTitle = normalizeTitleForMatch(anime.title);
                    
                    // Skip proses (O(1)) jika URL anime ini sudah ada di database!
                    if (existingUrls.has(anime.url)) {
                        continue;
                    }

                    let matchedId = null;
                    let bestScore = 0;
                    
                    // Coba cari kemiripan Fuzzy > 85% di database
                    for (const dbAnime of existingAnimes) {
                        const { isSafe, score } = isSafeToMerge(anime.title, dbAnime.title, 0.85);
                        
                        if (isSafe && score > bestScore) {
                            bestScore = score;
                            matchedId = dbAnime._id;
                        }
                        
                        // Periksa alias juga
                        if (bestScore < 0.85 && dbAnime.aliases) {
                            for (const alias of dbAnime.aliases) {
                                const { isSafe: isSafeAlias, score: aliasScore } = isSafeToMerge(anime.title, alias, 0.85);
                                if (isSafeAlias && aliasScore > bestScore) {
                                    bestScore = aliasScore;
                                    matchedId = dbAnime._id;
                                }
                            }
                        }
                        
                        // Jika sangat identik (> 95%), sudahi pencarian untuk menghemat CPU
                        if (bestScore >= 0.95) break;
                    }
                    
                    if (bestScore > 0.85 && matchedId) {
                        // Gabungkan ke entri yang sudah ada jika kemiripan tinggi (tanpa menimpa lastUpdated!)
                        bulkOps.push({
                            updateOne: {
                                filter: { _id: matchedId },
                                update: { 
                                    $addToSet: { sourceUrls: anime.url }
                                }
                            }
                        });
                    } else {
                        // Jika tidak ada yang mirip, buat dokumen baru
                        bulkOps.push({
                            updateOne: {
                                // Fallback filter untuk keamanan ganda jika skrip diinterupsi
                                filter: { title: anime.title },
                                update: { 
                                    $set: { normalizedTitle: normTitle },
                                        $addToSet: { sourceUrls: anime.url },
                                    $setOnInsert: {
                                        title: anime.title,
                                        type: 'TV',
                                        status: 'Completed',
                                        image: 'https://via.placeholder.com/225x320?text=No+Cover', 
                                        tmdbEnriched: false,
                                        lastUpdated: new Date(now - i * 1000),
                                        last_sync: new Date()
                                    }
                                },
                                upsert: true
                            }
                        });
                    }
                }

                if (bulkOps.length > 0) {
                    const result = await Anime.bulkWrite(bulkOps);
                    log(`[OtakuSync] ✅ MongoDB Bulk Update berhasil memetakan ${result.modifiedCount} anime dari Otakudesu.`);
                }
            } catch (err) {
                log(`[OtakuSync] ❌ Gagal menyimpan data. Error: ${err.message}`);
            }
        } else {
            log('[OtakuSync] Peringatan: Tidak ada anime yang terambil dari list.');
        }

    } catch (err) {
        console.error('[OtakuSync] Error:', err.message);
    }
}

export async function startBackgroundOtakuSync() {
    try {
        const count = await Anime.countDocuments({ 'sourceUrls': { $exists: true, $not: { $size: 0 } } });
        
        if (count === 0) {
            log("[OtakuSync] Database Otakudesu kosong. Memulai sinkronisasi awal A-Z...");
            syncOtakudesu();
        } else {
            log(`[OtakuSync] Database Otakudesu sudah berisi (${count} anime). A-Z Catalog Sync dijadwalkan mingguan (setiap 7 hari).`);
        }
    } catch(err) {
        log("[OtakuSync] Error mengecek status database:", err.message);
    }

    // Jalankan ulang setiap 7 hari karena ini hanya full list A-Z (Update episode diambil alih latest_sync.js)
    setInterval(() => {
        syncOtakudesu();
    }, 7 * 24 * 60 * 60 * 1000); // 7 Hari
}

// Jika dijalankan langsung
import fs from 'fs';
if (process.argv[1] && fileURLToPath(import.meta.url) === fs.realpathSync(process.argv[1])) {
    syncOtakudesu();
}
