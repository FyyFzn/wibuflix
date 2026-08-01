import * as cheerio from 'cheerio';
import axios from 'axios';
import { fileURLToPath } from 'url';
import fs from 'fs';
import Anime from '../models/Anime.js';
import { normalizeTitleForMatch, isSafeToMerge, cleanSeriesTitle } from '../utils/stringUtils.js';
import { PROVIDER_URLS } from '../config/providerUrls.js';

const log = (...args) => {
    if (global.forceLog) global.forceLog(...args);
    else console.log(...args);
};

const BASE_URL = PROVIDER_URLS.YLNIME.BASE_URL;
const CATALOG_URL = PROVIDER_URLS.YLNIME.CATALOG_URL;

const AX_HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
    'Accept-Language': 'id-ID,id;q=0.9,en;q=0.8',
    'Referer': BASE_URL + '/'
};

/**
 * Sinkronisasi katalog anime dari YLnime (A-Z list).
 * Halaman: https://ylnime.com/anime-list.php
 * 
 * Menggunakan Fuzzy Matching (isSafeToMerge) agar tidak ada duplikasi kartu.
 */
export async function syncYlnime() {
    log('[YLnimeSync] Memulai sinkronisasi katalog YLnime...');
    const list = [];

    try {
        // YLnime menggunakan pagination/tab berdasarkan huruf (A-Z dan #)
        const tabs = ['%23', ...'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('')];
        
        for (const tab of tabs) {
            const url = `${CATALOG_URL}?l=${tab}`;
            log(`[YLnimeSync] Memuat tab ${tab === '%23' ? '#' : tab}...`);
            
            try {
                const { data } = await axios.get(url, {
                    headers: AX_HEADERS,
                    timeout: 20000
                });

                const $ = cheerio.load(data);

                // Selector: <a href="index.php?series={slug}" class="stretched-link">
                // dan judul: <h6 class="card-title">Title</h6>
                $('a[href*="series="]').each((_, el) => {
                    const href = $(el).attr('href') || '';
                    if (!href) return;

                    // Ambil judul dari card-title yang ada di container yang sama
                    const card = $(el).closest('.card');
                    let title = card.find('.card-title, h6').first().text().trim();
                    // Fallback: ambil dari alt img
                    if (!title) title = card.find('img').first().attr('alt') || '';
                    if (!title) return;

                    // Bangun full URL
                    const fullUrl = href.startsWith('http') ? href : `${BASE_URL}/${href.replace(/^\//, '')}`;

                    // Ekstrak slug dari param series=
                    const slugMatch = href.match(/series=([^&]+)/);
                    const slug = slugMatch ? decodeURIComponent(slugMatch[1]).replace(/\/$/, '') : '';
                    if (!slug) return;

                    title = cleanSeriesTitle(title);
                    if (!title || title.length < 2) return;

                    list.push({ title, url: fullUrl, slug, id: `ylnime:${slug}` });
                });
                
                // Jeda agar tidak terkena rate limit
                await new Promise(r => setTimeout(r, 500));
            } catch (tabErr) {
                log(`[YLnimeSync] Gagal memuat tab ${tab}:`, tabErr.message);
            }
        }

        if (list.length === 0) {
            log('[YLnimeSync] Tidak ada anime ditemukan. Cek selector atau URL katalog.');
            return;
        }

        log(`[YLnimeSync] ${list.length} anime ditemukan dari A-Z list. Memulai pemetaan ke database...`);

        // Pre-fetch database (skip Toku agar tidak tercampur)
        const existingAnimes = await Anime.find(
            { type: { $ne: 'Toku' } },
            { title: 1, aliases: 1, sourceUrls: 1 }
        ).lean();

        const now = Date.now();
        const bulkOps = [];

        // Set berisi semua URL yang sudah ada di database (O(1) lookup)
        const existingUrls = new Set();
        existingAnimes.forEach(doc => {
            if (doc.sourceUrls) doc.sourceUrls.forEach(u => existingUrls.add(u));
        });

        for (let i = 0; i < list.length; i++) {
            // Unblock event loop agar API tidak mati!
            if (i % 25 === 0) await new Promise(r => setImmediate(r));

            const anime = list[i];
            const normTitle = normalizeTitleForMatch(anime.title);

            // Skip (O(1)) jika URL anime ini sudah ada di database
            if (existingUrls.has(anime.url)) continue;

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
                // Gabungkan ke entri yang sudah ada (tanpa menimpa data lain!)
                bulkOps.push({
                    updateOne: {
                        filter: { _id: matchedId },
                        update: { $addToSet: { sourceUrls: anime.url } }
                    }
                });
            } else {
                // Buat entri baru (belum ada di database manapun)
                bulkOps.push({
                    updateOne: {
                        filter: { title: anime.title },
                        update: {
                            $set: { normalizedTitle: normTitle },
                            $addToSet: { sourceUrls: anime.url },
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
            log(`[YLnimeSync] ✅ Selesai. Modified: ${result.modifiedCount}, Upserted: ${result.upsertedCount}`);
        } else {
            log('[YLnimeSync] ✅ Tidak ada data baru untuk diperbarui.');
        }
    } catch (err) {
        log(`[YLnimeSync] ❌ Error: ${err.message}`);
    }
}

/**
 * Jalankan sync sekali saat startup (jika perlu), lalu setiap 7 hari.
 */
export async function startBackgroundYlnimeSync() {
    try {
        const count = await Anime.countDocuments({
            sourceUrls: { $elemMatch: { $regex: 'ylnime', $options: 'i' } }
        });

        if (count === 0) {
            log('[YLnimeSync] Database YLnime kosong. Memulai sinkronisasi awal...');
            syncYlnime();
        } else {
            log(`[YLnimeSync] Database YLnime sudah berisi (${count} anime dengan URL YLnime). Sync dijadwalkan mingguan.`);
        }
    } catch (err) {
        log('[YLnimeSync] Error cek status:', err.message);
    }

    // Ulangi setiap 7 hari
    setInterval(() => syncYlnime(), 7 * 24 * 60 * 60 * 1000);
}

// Jalankan langsung jika dipanggil via CLI: node src/sync/ylnime_sync.js
if (process.argv[1] && fileURLToPath(import.meta.url) === fs.realpathSync(process.argv[1])) {
    import('../config/db.js').then(m => m.default()).then(() => syncYlnime());
}
