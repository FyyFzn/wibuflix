import * as cheerio from 'cheerio';
import { releaseToPool } from '../puppeteer/pool.js';
import { fetchWithCF } from '../utils/scrapeHelper.js';
import Anime from '../models/Anime.js'; // Model MongoDB

let isSyncing = false;

const log = (...args) => {
    if (global.forceLog) global.forceLog(...args);
    else console.log(...args);
};

async function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

export async function startBackgroundAnimeSync() {
    try {
        const count = await Anime.countDocuments({ 'sources.samehadaku.url': { $exists: true, $ne: null } });
        
        if (count === 0) {
            log("[Anime Sync] Database Samehadaku kosong. Memulai sinkronisasi awal A-Z...");
            runSync(true);
        } else {
            const latestDoc = await Anime.findOne({ 'sources.samehadaku.url': { $exists: true, $ne: null } }).sort({ lastUpdated: -1 });
            const ageInMs = latestDoc && latestDoc.lastUpdated ? (Date.now() - latestDoc.lastUpdated.getTime()) : 0;
            const twelveHours = 12 * 60 * 60 * 1000;
            
            if (ageInMs > twelveHours || !latestDoc || !latestDoc.lastUpdated) {
                log(`[Anime Sync] Database Samehadaku sudah usang (>12 jam). Menjalankan sinkronisasi pembaruan (Delay 1 menit)...`);
                setTimeout(() => runSync(false), 60000);
            } else {
                log(`[Anime Sync] Database Samehadaku masih baru (Umur: ${Math.round(ageInMs/1000/60)} menit). Melewati sinkronisasi awal.`);
            }
        }
    } catch(err) {
        log("[Anime Sync] Error mengecek status database:", err.message);
    }

    // Schedule every 7 days (604800000 ms) karena daftar A-Z jarang berubah
    setInterval(() => {
        runSync(false);
    }, 604800000);
}

export async function runSync(isInitial = false) {
    if (isSyncing) return;
    isSyncing = true;
    
    log(`\n===========================================`);
    log(`[Anime Sync] Memulai sinkronisasi katalog...`);
    log(`===========================================\n`);

    const allAnime = [];
    let page = 1;
    let hasNext = true;
    let consecutiveFails = 0;

    try {
        while (hasNext) {
            const url = page === 1 ? `https://v2.samehadaku.how/daftar-anime-2/` : `https://v2.samehadaku.how/daftar-anime-2/page/${page}/`;
            log(`[Anime Sync] Scraping Halaman ${page}...`);

            let fetchRes;
            try {
                fetchRes = await fetchWithCF(url, { timeout: 60000, fetchTimeout: 10000 });
            } catch (e) {
                console.error(`[Anime Sync] Gagal memuat halaman ${page}:`, e.message);
            }

            if (!fetchRes || fetchRes.html === '404_NOT_FOUND' || !fetchRes.html) {
                if (fetchRes && fetchRes.html === '404_NOT_FOUND') {
                    log(`[Anime Sync] Halaman ${page} mengembalikan 404. Akhir dari katalog dicapai.`);
                    hasNext = false;
                } else {
                    consecutiveFails++;
                    if (consecutiveFails >= 3) {
                        console.error(`[Anime Sync] Gagal berturut-turut 3 kali. Menghentikan sinkronisasi.`);
                        break;
                    }
                    await delay(8000);
                }
                if (fetchRes && fetchRes.slot) {
                    releaseToPool(fetchRes.slot);
                }
                continue; // Retry/break
            }

            const $ = fetchRes.$;
            const slot = fetchRes.slot;
            let itemCount = 0;

            $('.animepost').each((_, el) => {
                const titleNode = $(el).find('.title, .tt h2, .entry-title').first();
                const linkNode = $(el).find('a').first();
                const imgNode = $(el).find('img').first();
                const typeNode = $(el).find('.content-thumb .type, .typez, .bt span.type').first();
                const scoreNode = $(el).find('.score, .numscore, .rating').first();
                const statusNode = $(el).find('.data .type, .status, .epx, .sb, .bt span:not(.type)').first();
                
                if (titleNode.length && linkNode.length && imgNode.length) {
                    const skorRaw = scoreNode.length ? scoreNode.text().trim() : '';
                    const skorAngka = skorRaw.replace(/[^\d.]/g, '');
                    
                    let epText = '';
                    const epNode = $(el).find('author[itemprop="name"]').first();
                    if (epNode.length) epText = 'Eps ' + epNode.text().trim();

                    const gambarScraper = 
                        imgNode.attr('data-src') || 
                        imgNode.attr('data-lazy-src') || 
                        imgNode.attr('data-original') || 
                        (imgNode.attr('srcset') ? imgNode.attr('srcset').split(' ')[0] : null) || 
                        imgNode.attr('src') || '';

                    allAnime.push({
                        judul: titleNode.text().trim(),
                        url: linkNode.attr('href'),
                        gambar: gambarScraper,
                        gambarScraper,
                        tipe: typeNode.length ? typeNode.text().trim().toUpperCase() : 'TV',
                        skor: skorAngka || '-',
                        status: epText || (statusNode.length ? statusNode.text().trim() : 'Completed'),
                    });
                    itemCount++;
                }
            });

            console.log(`[Anime Sync] -> Berhasil mengambil ${itemCount} anime dari Halaman ${page}`);
            consecutiveFails = 0; // reset fails on success

            // Release slot as early as possible so other concurrent tasks can use it
            releaseToPool(slot);

            // Check if there's a next page
            let hasNextPage = false;
            $('.pagination a, .pagination-id a').each((_, el) => {
                const txt = $(el).text();
                const hasNextIcon = $(el).find('#nextpagination, .fa-caret-right').length > 0;
                if (txt.includes('Next') || $(el).hasClass('next') || $(el).hasClass('arrow_pag') || hasNextIcon) {
                    hasNextPage = true;
                }
            });

            if (!hasNextPage) {
                console.log(`[Anime Sync] Tidak ada tombol Next. Sinkronisasi selesai.`);
                hasNext = false;
            } else {
                page++;
                // Delay 6-10 detik agar aman dari blokir
                const waitTime = Math.floor(Math.random() * 4000) + 6000;
                await delay(waitTime);
            }
        }

        if (allAnime.length > 0) {
            // Update cache memory on the fly first (so it works even if disk write fails)
            global.anime_db_cache = allAnime;
            
            try {
                // 1. Simpan ke MongoDB (Bulk Upsert)
                const { normalizeTitleForMatch } = await import('../utils/stringUtils.js');
                const now = Date.now();
                const bulkOps = allAnime.map((anime, index) => {
                    const normTitle = normalizeTitleForMatch(anime.judul);
                    return {
                        updateOne: {
                            filter: { title: anime.judul },
                            update: { 
                                $set: { 
                                    title: anime.judul,
                                    normalizedTitle: normTitle,
                                    image: anime.gambarScraper,
                                    type: anime.tipe,
                                    score: anime.skor,
                                    status: anime.status,
                                    'sources.samehadaku.url': anime.url,
                                    lastUpdated: new Date(now - index * 1000)
                                } 
                            },
                            upsert: true
                        }
                    };
                });

                // Eksekusi operasi massal
                if (bulkOps.length > 0) {
                    await Anime.bulkWrite(bulkOps);
                    log(`[Anime Sync] ✅ MongoDB Bulk Upsert berhasil untuk ${bulkOps.length} anime.`);
                }
            } catch (err) {
                log(`[Anime Sync] ❌ Gagal menyimpan data. Error: ${err.message}`);
            }
        } else {
            log(`[Anime Sync] Peringatan: Tidak ada anime yang terambil.`);
        }

    } catch (e) {
        console.error(`[Anime Sync] Error fatal selama sinkronisasi:`, e.message);
    } finally {
        isSyncing = false;
    }
}

