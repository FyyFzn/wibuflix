import Anime from '../models/Anime.js';
import { getNeosatsuCatalog } from '../scraper/neosatsu.js';
import { fileURLToPath } from 'url';
import fs from 'fs';

const log = (...args) => {
    if (global.forceLog) {
        global.forceLog(...args);
    } else {
        console.log(...args);
    }
};

export async function syncNeosatsu() {
    log('[Neosatsu Sync] Memulai sinkronisasi katalog Tokusatsu ke MongoDB...');
    try {
        // Panggil dengan parameter default untuk memaksa scraper mengambil seluruh halaman statis
        // dan mengisi global['neosatsu_static_catalog']
        await getNeosatsuCatalog(1, '', '');
        
        const cacheData = global['neosatsu_static_catalog'];
        if (!cacheData || !cacheData.data || cacheData.data.length === 0) {
            log('[Neosatsu Sync] Cache kosong, tidak ada data Tokusatsu untuk disinkronkan.');
            return;
        }

        const tokuList = cacheData.data;
        const bulkOps = [];

        for (const toku of tokuList) {
            // Bersihkan judul dari angka episode khusus untuk pencarian DB (misal "Kamen Rider Gavv Episode 12" -> "Kamen Rider Gavv")
            let baseTitle = toku.title.replace(/Episode\s*\d+.*$/i, '').trim();

            bulkOps.push({
                updateOne: {
                    filter: { title: baseTitle },
                    update: {
                        $set: {
                            title: baseTitle,
                            type: 'Toku',
                            cover_url: toku.thumb,
                            status: toku.status,
                            "sources.neosatsu": {
                                url: toku.endpoint,
                                last_updated: new Date()
                            },
                            last_sync: new Date()
                        }
                    },
                    upsert: true
                }
            });
        }

        if (bulkOps.length > 0) {
            const result = await Anime.bulkWrite(bulkOps);
            log(`[Neosatsu Sync] Selesai! Inserted: ${result.upsertedCount}, Modified: ${result.modifiedCount}`);
        } else {
            log(`[Neosatsu Sync] Tidak ada bulk operation yang perlu dijalankan.`);
        }

    } catch (error) {
        console.error('[Neosatsu Sync] Gagal menjalankan sinkronisasi:', error);
    }
}

// Jika file dijalankan langsung melalui CLI
if (process.argv[1] && fileURLToPath(import.meta.url) === fs.realpathSync(process.argv[1])) {
    import('../config/db.js').then(({ default: connectDB }) => {
        connectDB().then(() => syncNeosatsu().then(() => process.exit(0)));
    });
}
