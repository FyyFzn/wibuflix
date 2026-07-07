import * as cheerio from 'cheerio';
import { fileURLToPath } from 'url';
import fs from 'fs';
import Anime from '../models/Anime.js';
import { normalizeTitleForMatch, isSafeToMerge } from '../utils/stringUtils.js';
import { fetchWithCF } from '../utils/scrapeHelper.js';
import { releaseToPool } from '../puppeteer/pool.js';

const log = (...args) => {
    if (global.forceLog) global.forceLog(...args);
    else console.log(...args);
};

/**
 * Sinkronisasi katalog anime dari Nimegami.id (A-Z list).
 * Menggunakan Fuzzy Matching (isSafeToMerge) agar tidak ada duplikasi kartu di MongoDB.
 */
export async function syncNimegami() {
    log('[NimegamiSync] Memulai sinkronisasi katalog A-Z Nimegami...');
    const list = [];
    try {
        const seenUrls = new Set();
        const ignoreWords = ['/category/', '/tag/', '/list', '/jadwal', '/genre', 'wp-content', 'javascript:', 'telegram', 'facebook', 'twitter', 'instagram', 'discord', '/page/', '/anime-terbaru', '/live-action', '/drama-jepang', '/dorama', '/jdrama', '/j-drama', '/type', '/seasons', '/streaming', '/ongoing', '/completed', '/movie-list', '/author/', '/about', '/contact', '/privacy', '/disclaimer', '/dmca', '/donasi'];
        const ignoreTitles = ['anime list', 'live action', 'j-drama', 'jdrama', 'drama jepang', 'anime terbaru', 'jadwal rilis', 'streaming list', 'baca komik', 'type', 'seasons', 'genre', 'home', 'beranda', 'ongoing', 'completed', 'next', 'prev', 'previous', 'dramaid'];

        let page = 1;
        let hasNextPage = true;

        while (hasNextPage && page <= 20) {
            const url = page === 1 ? 'https://nimegami.id/anime-list/' : `https://nimegami.id/anime-list/page/${page}/`;
            log(`[NimegamiSync] Mengambil halaman ${page}: ${url}...`);

            let fetchRes, currentSlot;
            try {
                fetchRes = await fetchWithCF(url, { fetchTimeout: 30000 });
                currentSlot = fetchRes?.slot;
            } catch (err) {
                log(`[NimegamiSync] Gagal memuat halaman ${page}:`, err.message);
                break;
            }

            if (!fetchRes || !fetchRes.$ || fetchRes.html === '404_NOT_FOUND') {
                if (currentSlot) releaseToPool(currentSlot);
                break;
            }

            const $ = fetchRes.$;
            let addedCount = 0;

            $('.content, #main, .main, .post, article, .list-anime').find('a').each((_, el) => {
                if ($(el).closest('nav, header, footer, .sidebar, .menu, .nav, ul.menu, li.menu-item').length > 0) return;

                let title = $(el).text().trim();
                const link = $(el).attr('href');
                if (!title || !link || !link.startsWith('http')) return;

                if (ignoreWords.some(w => link.toLowerCase().includes(w)) || link === 'https://nimegami.id/' || link.endsWith('.id')) {
                    return;
                }

                if (ignoreTitles.some(t => title.toLowerCase() === t || title.toLowerCase().includes(t))) {
                    return;
                }

                if (link.includes('nimegami.id/') && title.length > 2 && !seenUrls.has(link)) {
                    seenUrls.add(link);
                    addedCount++;

                    title = title
                        .replace(/\s*\(Complete\)\s*/i, '')
                        .replace(/\s*\(On-?going\)\s*/i, '')
                        .replace(/\s*Subtitle\s*Indonesia\s*/i, '')
                        .replace(/\s*Sub\s*Indo\s*/i, '')
                        .replace(/\s*Batch\s*/i, '')
                        .trim();

                    const parts = link.replace(/\/$/, '').split('/');
                    const slug = parts[parts.length - 1];

                    list.push({ title, url: link, slug, id: `nimegami:${slug}` });
                }
            });

            if (currentSlot) releaseToPool(currentSlot);

            if (addedCount === 0 || page >= 15) {
                hasNextPage = false;
            } else {
                page++;
            }
        }

        if (list.length === 0) {
            log('[NimegamiSync] Tidak ada anime ditemukan. Cek struktur halaman.');
            return;
        }

        log(`[NimegamiSync] ${list.length} anime ditemukan dari seluruh halaman A-Z Nimegami. Memulai pemetaan ke database...`);

        // Pre-fetch database (skip Toku agar tidak tercampur)
        const existingAnimes = await Anime.find(
            { type: { $ne: 'Toku' } },
            { title: 1, aliases: 1, 'sources.nimegami': 1 }
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
                // Gabungkan ke entri yang sudah ada
                bulkOps.push({
                    updateOne: {
                        filter: { _id: matchedId },
                        update: {
                            $set: {
                                'sources.nimegami.url': anime.url,
                                'sources.nimegami.id': anime.id,
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
                                'sources.nimegami.url': anime.url,
                                'sources.nimegami.id': anime.id,
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
            log(`[NimegamiSync] ✅ Selesai. Modified: ${result.modifiedCount}, Upserted: ${result.upsertedCount}`);
        }
    } catch (err) {
        log(`[NimegamiSync] ❌ Error: ${err.message}`);
    }
}

/**
 * Jalankan sync sekali saat startup (jika perlu), lalu setiap 7 hari.
 */
export async function startBackgroundNimegamiSync() {
    try {
        const count = await Anime.countDocuments({ 'sources.nimegami.url': { $ne: null } });

        if (count === 0) {
            log('[NimegamiSync] Database Nimegami kosong. Memulai sinkronisasi awal...');
            syncNimegami();
        } else {
            const latestDoc = await Anime
                .findOne({ 'sources.nimegami.url': { $ne: null } })
                .sort({ lastUpdated: -1 });
            const ageInMs = latestDoc?.lastUpdated
                ? Date.now() - latestDoc.lastUpdated.getTime()
                : Infinity;
            const sevenDays = 7 * 24 * 60 * 60 * 1000;

            if (ageInMs > sevenDays) {
                log('[NimegamiSync] Data Nimegami sudah usang (>7 hari). Memulai sinkronisasi pembaruan...');
                syncNimegami();
            } else {
                log(`[NimegamiSync] ${count} anime Nimegami masih baru (${Math.round(ageInMs / 1000 / 60 / 60)} jam). Melewati sync awal.`);
            }
        }
    } catch (err) {
        log('[NimegamiSync] Error cek status:', err.message);
    }

    // Ulangi setiap 7 hari
    setInterval(() => syncNimegami(), 7 * 24 * 60 * 60 * 1000);
}

// Jalankan langsung jika dipanggil via CLI
if (process.argv[1] && fileURLToPath(import.meta.url) === fs.realpathSync(process.argv[1])) {
    import('../config/db.js').then(async (mod) => {
        await mod.default();
        await syncNimegami();
        process.exit(0);
    }).catch(err => {
        console.error('Gagal menjalankan CLI Nimegami Sync:', err);
        process.exit(1);
    });
}
