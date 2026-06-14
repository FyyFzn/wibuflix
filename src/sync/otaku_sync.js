import axios from 'axios';
import * as cheerio from 'cheerio';
import { fileURLToPath } from 'url';
import Anime from '../models/Anime.js'; // Model MongoDB

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
        const { data } = await axios.get('https://otakudesu.blog/anime-list/', {
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
                // 1. Simpan ke MongoDB (Bulk Upsert)
                const now = Date.now();
                const bulkOps = list.map((anime, index) => ({
                    updateOne: {
                        filter: { 
                            $or: [
                                { title: { $regex: new RegExp(`^${anime.title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i') } },
                                { aliases: { $regex: new RegExp(`^${anime.title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i') } }
                            ]
                        },
                        update: { 
                            $set: { 
                                'sources.otakudesu.url': anime.url,
                                'sources.otakudesu.id': anime.id,
                                lastUpdated: new Date(now - index * 1000)
                            },
                            $setOnInsert: {
                                title: anime.title,
                                type: 'TV',
                                status: 'Completed',
                                image: 'https://via.placeholder.com/225x320?text=No+Cover', // Akan ditimpa oleh TMDB Enrichment nanti
                                tmdbEnriched: false,
                                last_sync: new Date()
                            }
                        },
                        upsert: true // Bolehkan pembuatan data baru jika anime tersebut eksklusif HANYA ada di Otakudesu
                    }
                }));

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
        const count = await Anime.countDocuments({ 'sources.otakudesu': { $exists: true } });
        
        if (count === 0) {
            log("[OtakuSync] Database Otakudesu kosong. Memulai sinkronisasi awal...");
            syncOtakudesu();
        } else {
            // Otakudesu A-Z list jarang update secara masif, kita bisa cek dari lastUpdated
            const latestDoc = await Anime.findOne({ 'sources.otakudesu': { $exists: true } }).sort({ lastUpdated: -1 });
            const ageInMs = latestDoc && latestDoc.lastUpdated ? (Date.now() - latestDoc.lastUpdated.getTime()) : 0;
            const sixHours = 6 * 60 * 60 * 1000;
            
            if (ageInMs > sixHours || !latestDoc || !latestDoc.lastUpdated) {
                log(`[OtakuSync] Database Otakudesu usang. Memulai sinkronisasi pembaruan...`);
                syncOtakudesu();
            } else {
                log(`[OtakuSync] Database Otakudesu masih baru (Umur: ${Math.round(ageInMs/1000/60)} menit). Melewati sinkronisasi awal.`);
            }
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
