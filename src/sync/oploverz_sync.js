import * as cheerio from 'cheerio';
import { fileURLToPath } from 'url';
import fs from 'fs';
import Anime from '../models/Anime.js';
import { normalizeTitleForMatch, isSafeToMerge } from '../utils/stringUtils.js';
import { acquireFromPool, releaseToPool } from '../puppeteer/pool.js';

const log = (...args) => {
    if (global.forceLog) global.forceLog(...args);
    else console.log(...args);
};

const OPLOVERZ_SERIES_URL = 'https://plus.oploverz.ltd/series';

/**
 * Sinkronisasi katalog anime dari Oploverz (plus.oploverz.ltd/series).
 * Menggunakan Puppeteer untuk merender SvelteKit SPA, kemudian Fuzzy Matching
 * (isSafeToMerge) agar tidak ada duplikasi di MongoDB.
 */
export async function syncOploverz() {
    log('[OploverzSync] Memulai sinkronisasi katalog Oploverz...');
    let slot;
    try {
        slot = await acquireFromPool();
        const page = slot.page;

        log(`[OploverzSync] Navigasi ke ${OPLOVERZ_SERIES_URL}...`);
        await page.goto(OPLOVERZ_SERIES_URL, { waitUntil: 'networkidle2', timeout: 60000 });

        // Scroll ke bawah untuk memastikan semua konten lazy-load ter-render
        await page.evaluate(async () => {
            await new Promise((resolve) => {
                let totalHeight = 0;
                const distance = 400;
                const timer = setInterval(() => {
                    window.scrollBy(0, distance);
                    totalHeight += distance;
                    if (totalHeight >= document.body.scrollHeight - window.innerHeight) {
                        clearInterval(timer);
                        resolve();
                    }
                }, 150);
            });
        });

        const html = await page.content();
        const $ = cheerio.load(html);

        const animeMap = new Map();
        $('a[href^="/series/"]').each((_, el) => {
            const href = $(el).attr('href');
            if (!href || href.includes('/episode/')) return;

            let titleRaw = $(el).text().trim() || $(el).attr('title') || $(el).find('img').attr('alt');
            titleRaw = titleRaw ? String(titleRaw).trim() : '';
            if (!titleRaw || titleRaw.length < 2) return;

            const id = href.replace('/series/', '').replace(/\/$/, '');
            if (!animeMap.has(id)) {
                animeMap.set(id, {
                    title: titleRaw,
                    url: `https://plus.oploverz.ltd${href}`,
                    id
                });
            }
        });

        const list = Array.from(animeMap.values());
        log(`[OploverzSync] ${list.length} anime ditemukan. Memulai pemetaan ke database...`);

        if (list.length === 0) {
            log('[OploverzSync] Tidak ada anime ditemukan. SvelteKit DOM mungkin tidak terrender sempurna.');
            return;
        }

        // Pre-fetch database sekali (lebih efisien daripada query satu per satu)
        const existingAnimes = await Anime.find(
            { type: { $ne: 'Toku' } },
            { title: 1, aliases: 1, normalizedTitle: 1, 'sources.oploverz': 1 }
        ).lean();

        const now = Date.now();
        const bulkOps = [];

        for (let i = 0; i < list.length; i++) {
            const anime = list[i];
            const normTitle = normalizeTitleForMatch(anime.title);

            let matchedId = null;
            let bestScore = 0;

            // Fuzzy match terhadap semua dokumen di database
            for (const dbAnime of existingAnimes) {
                // Skip jika sudah linked ke Oploverz dengan ID yang sama
                if (dbAnime?.sources?.oploverz?.id === anime.id) {
                    matchedId = null;
                    bestScore = 999; // Tanda sudah ada — skip
                    break;
                }

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

            if (bestScore === 999) continue; // Sudah ada, skip

            if (bestScore > 0.85 && matchedId) {
                // Merge ke entri yang sudah ada
                bulkOps.push({
                    updateOne: {
                        filter: { _id: matchedId },
                        update: {
                            $set: {
                                'sources.oploverz.url': anime.url,
                                'sources.oploverz.id': anime.id,
                                lastUpdated: new Date(now - i * 1000)
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
                                'sources.oploverz.url': anime.url,
                                'sources.oploverz.id': anime.id,
                                normalizedTitle: normTitle,
                                lastUpdated: new Date(now - i * 1000)
                            },
                            $setOnInsert: {
                                title: anime.title,
                                type: 'TV',
                                status: 'Completed',
                                image: '',
                                tmdbEnriched: false
                            }
                        },
                        upsert: true
                    }
                });
            }
        }

        if (bulkOps.length > 0) {
            const result = await Anime.bulkWrite(bulkOps);
            log(`[OploverzSync] ✅ Selesai. Modified: ${result.modifiedCount}, Upserted: ${result.upsertedCount}`);
        } else {
            log('[OploverzSync] ✅ Semua data sudah sinkron. Tidak ada perubahan.');
        }
    } catch (err) {
        log(`[OploverzSync] ❌ Error: ${err.message}`);
    } finally {
        if (slot) releaseToPool(slot);
    }
}

/**
 * Jalankan sync sekali saat startup (jika perlu), lalu setiap 7 hari.
 */
export async function startBackgroundOploverzSync() {
    try {
        const count = await Anime.countDocuments({ 'sources.oploverz.url': { $ne: null } });

        if (count === 0) {
            log('[OploverzSync] Database Oploverz kosong. Memulai sinkronisasi awal...');
            syncOploverz();
        } else {
            const latestDoc = await Anime
                .findOne({ 'sources.oploverz.url': { $ne: null } })
                .sort({ lastUpdated: -1 });
            const ageInMs = latestDoc?.lastUpdated
                ? Date.now() - latestDoc.lastUpdated.getTime()
                : Infinity;
            const sevenDays = 7 * 24 * 60 * 60 * 1000;

            if (ageInMs > sevenDays) {
                log('[OploverzSync] Data Oploverz sudah usang (>7 hari). Memulai sinkronisasi pembaruan...');
                syncOploverz();
            } else {
                log(`[OploverzSync] ${count} anime Oploverz masih baru (${Math.round(ageInMs / 1000 / 60 / 60)} jam). Melewati sync awal.`);
            }
        }
    } catch (err) {
        log('[OploverzSync] Error cek status:', err.message);
    }

    // Ulangi setiap 7 hari
    setInterval(() => syncOploverz(), 7 * 24 * 60 * 60 * 1000);
}

// Jalankan langsung jika dipanggil via CLI
if (process.argv[1] && fileURLToPath(import.meta.url) === fs.realpathSync(process.argv[1])) {
    import('../config/db.js').then(async (mod) => {
        await mod.default();
        await syncOploverz();
        process.exit(0);
    }).catch(err => {
        console.error('Gagal menjalankan CLI Oploverz Sync:', err);
        process.exit(1);
    });
}
