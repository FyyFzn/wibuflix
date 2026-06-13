import axios from 'axios';
import * as cheerio from 'cheerio';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { getDataDir } from '../utils/pathUtils.js';
import Anime from '../models/Anime.js'; // Model MongoDB

// Gunakan path dari utility
const DB_PATH = path.join(getDataDir(), 'otakudesu_db.json');

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
            const title = $(el).text().trim();
            const url = $(el).attr('href');
            if (title && url) {
                const parts = url.split('/').filter(Boolean);
                const slug = parts[parts.length - 1];
                
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
                // Kita update sumber Otakudesu saja, menggunakan "title" sebagai kriteria pencocokan.
                const bulkOps = list.map(anime => ({
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
                                'sources.otakudesu.id': anime.id
                            } 
                        },
                        upsert: false // Jangan buat data anime baru murni dari Otakudesu jika tidak ada (untuk menjaga metadata rapi dari Samehadaku)
                    }
                }));

                if (bulkOps.length > 0) {
                    const result = await Anime.bulkWrite(bulkOps);
                    log(`[OtakuSync] ✅ MongoDB Bulk Update berhasil memetakan ${result.modifiedCount} anime dari Otakudesu.`);
                }

                // 2. Simpan ke lokal sebagai cache raw
                const dbDir = path.dirname(DB_PATH);
                if (!fs.existsSync(dbDir)) fs.mkdirSync(dbDir, { recursive: true });
                
                await fs.promises.writeFile(DB_PATH, JSON.stringify(list, null, 2));
                log(`[OtakuSync] ✅ Berhasil menyimpan ${list.length} anime ke JSON lokal.`);
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

export function startBackgroundOtakuSync() {
    let shouldSyncNow = true;
    if (fs.existsSync(DB_PATH)) {
        const stats = fs.statSync(DB_PATH);
        const ageInMs = Date.now() - stats.mtimeMs;
        const sixHours = 6 * 60 * 60 * 1000;
        if (ageInMs < sixHours) {
            shouldSyncNow = false;
            log(`[OtakuSync] Database masih baru (Umur: ${Math.round(ageInMs/1000/60)} menit). Melewati sinkronisasi awal.`);
        }
    }

    if (shouldSyncNow) {
        syncOtakudesu();
    }

    // Jalankan ulang setiap 7 hari karena ini hanya full list A-Z (Update episode diambil alih latest_sync.js)
    setInterval(() => {
        syncOtakudesu();
    }, 7 * 24 * 60 * 60 * 1000); // 7 Hari
}

// Jika dijalankan langsung
if (process.argv[1] && fileURLToPath(import.meta.url) === fs.realpathSync(process.argv[1])) {
    syncOtakudesu();
}
