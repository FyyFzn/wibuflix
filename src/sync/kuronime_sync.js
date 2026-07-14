import * as cheerio from 'cheerio';
import axios from 'axios';
import { fileURLToPath } from 'url';
import Anime from '../models/Anime.js';
import { normalizeTitleForMatch, isSafeToMerge } from '../utils/stringUtils.js';
import { PROVIDER_URLS } from '../config/providerUrls.js';

const log = (...args) => {
    if (global.forceLog) global.forceLog(...args);
    else console.log(...args);
};

/**
 * Sinkronisasi katalog anime dari Kuronime (A-Z list).
 * Menggunakan Fuzzy Matching (isSafeToMerge) agar tidak ada duplikasi kartu.
 */
export async function syncKuronime() {
    log('[KuronimeSync] Memulai sinkronisasi katalog Kuronime...');
    const list = [];

    try {
        // URL list A-Z yang menampilkan semua anime dalam satu halaman (tidak perlu pagination)
        const { data } = await axios.get(PROVIDER_URLS.KURONIME.CATALOG_URL, {

            headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
            timeout: 15000
        });

        const $ = cheerio.load(data);

        // Selector terverifikasi: menghasilkan ~2378 anime dalam sekali fetch
        $('.soralist ul li a').each((_, el) => {
            let title = $(el).text().trim();
            const url = $(el).attr('href');
            if (!title || !url) return;

            // Bersihkan embel-embel
            title = title
                .replace(/\s*Subtitle\s*Indonesia\s*/i, '')
                .replace(/\s*Sub\s*Indo\s*/i, '')
                .replace(/\s*Batch\s*/i, '')
                .trim();

            const parts = url.replace(/\/$/, '').split('/');
            const slug = parts[parts.length - 1];

            list.push({ title, url, slug, id: `kuronime:${slug}` });
        });

        if (list.length === 0) {
            log('[KuronimeSync] Tidak ada anime ditemukan. Cek selector az-list.');
            return;
        }

        log(`[KuronimeSync] ${list.length} anime ditemukan dari A-Z list. Memulai pemetaan ke database...`);

        // Pre-fetch database (skip Toku agar tidak tercampur)
        const existingAnimes = await Anime.find(
            { type: { $ne: 'Toku' } },
            { title: 1, aliases: 1, 'sources.kuronime': 1 }
        ).lean();

        const now = Date.now();
        const bulkOps = [];

        for (let i = 0; i < list.length; i++) {
            const anime = list[i];
            const normTitle = normalizeTitleForMatch(anime.title);

            let matchedId = null;
            let bestScore = 0;

            // Fuzzy match terhadap database yang sudah ada
            for (const dbAnime of existingAnimes) {
                const { isSafe, score } = isSafeToMerge(anime.title, dbAnime.title, 0.85);
                if (isSafe && score > bestScore) {
                    bestScore = score;
                    matchedId = dbAnime._id;
                }
                // Cek juga aliases
                if (bestScore < 0.85 && dbAnime.aliases) {
                    for (const alias of dbAnime.aliases) {
                        const { isSafe: sa, score: sc } = isSafeToMerge(anime.title, alias, 0.85);
                        if (sa && sc > bestScore) {
                            bestScore = sc;
                            matchedId = dbAnime._id;
                        }
                    }
                }
                if (bestScore >= 0.95) break;
            }

            if (bestScore > 0.85 && matchedId) {
                // Gabungkan ke entri yang sudah ada (tanpa menimpa lastUpdated!)
                bulkOps.push({
                    updateOne: {
                        filter: { _id: matchedId },
                        update: {
                            $set: {
                                'sources.kuronime.url': anime.url,
                                'sources.kuronime.id': anime.id
                            }
                        }
                    }
                });
            } else {
                // Buat entri baru (belum ada di database manapun)
                bulkOps.push({
                    updateOne: {
                        filter: { title: anime.title },
                        update: {
                            $set: {
                                'sources.kuronime.url': anime.url,
                                'sources.kuronime.id': anime.id,
                                normalizedTitle: normTitle
                            },
                            $setOnInsert: {
                                title: anime.title,
                                type: 'TV',
                                status: 'Completed',
                                image: '',
                                tmdbEnriched: false,
                                lastUpdated: new Date(now - i * 1000)
                            }
                        },
                        upsert: true
                    }
                });
            }
        }

        if (bulkOps.length > 0) {
            const result = await Anime.bulkWrite(bulkOps);
            log(`[KuronimeSync] ✅ Selesai. Modified: ${result.modifiedCount}, Upserted: ${result.upsertedCount}`);
        }
    } catch (err) {
        log(`[KuronimeSync] ❌ Error: ${err.message}`);
    }
}

/**
 * Jalankan sync sekali saat startup (jika perlu), lalu setiap 7 hari.
 */
export async function startBackgroundKuronimeSync() {
    try {
        const count = await Anime.countDocuments({ 'sources.kuronime.url': { $ne: null } });

        if (count === 0) {
            log('[KuronimeSync] Database Kuronime kosong. Memulai sinkronisasi awal...');
            syncKuronime();
        } else {
            const latestDoc = await Anime
                .findOne({ 'sources.kuronime.url': { $ne: null } })
                .sort({ lastUpdated: -1 });
            const ageInMs = latestDoc?.lastUpdated
                ? Date.now() - latestDoc.lastUpdated.getTime()
                : Infinity;
            const sevenDays = 7 * 24 * 60 * 60 * 1000;

            if (ageInMs > sevenDays) {
                log('[KuronimeSync] Data Kuronime sudah usang (>7 hari). Memulai sinkronisasi pembaruan...');
                syncKuronime();
            } else {
                log(`[KuronimeSync] ${count} anime Kuronime masih baru (${Math.round(ageInMs / 1000 / 60 / 60)} jam). Melewati sync awal.`);
            }
        }
    } catch (err) {
        log('[KuronimeSync] Error cek status:', err.message);
    }

    // Ulangi setiap 7 hari
    setInterval(() => syncKuronime(), 7 * 24 * 60 * 60 * 1000);
}


// Jalankan langsung jika dipanggil via CLI
import fs from 'fs';
if (process.argv[1] && fileURLToPath(import.meta.url) === fs.realpathSync(process.argv[1])) {
    syncKuronime();
}
