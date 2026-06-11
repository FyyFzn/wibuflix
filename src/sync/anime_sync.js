import fs from 'fs';
import path from 'path';
import * as cheerio from 'cheerio';
import { releaseToPool } from '../puppeteer/pool.js';
import { fetchWithCF } from '../utils/scrapeHelper.js';
import { getDataDir } from '../utils/pathUtils.js';

// Gunakan path dari utility
const DB_PATH = path.join(getDataDir(), 'anime_db.json');
let isSyncing = false;

const log = (...args) => {
    if (global.forceLog) global.forceLog(...args);
    else console.log(...args);
};

async function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

export async function startBackgroundAnimeSync() {
    // Run immediately if DB doesn't exist
    if (!fs.existsSync(DB_PATH)) {
        log("[Anime Sync] Database lokal tidak ditemukan. Memulai sinkronisasi awal...");
        runSync(true); // true = initial sync (don't block server startup)
    } else {
        const stats = fs.statSync(DB_PATH);
        const ageInMs = Date.now() - stats.mtimeMs;
        const twelveHours = 12 * 60 * 60 * 1000;
        
        if (ageInMs > twelveHours) {
            log(`[Anime Sync] Database sudah usang (>12 jam). Menjalankan sinkronisasi pembaruan (Delay 1 menit)...`);
            setTimeout(() => runSync(false), 60000);
        } else {
            log(`[Anime Sync] Database masih baru (Umur: ${Math.round(ageInMs/1000/60)} menit). Melewati sinkronisasi awal.`);
        }
    }

    // Schedule every 12 hours (43200000 ms)
    setInterval(() => {
        runSync(false);
    }, 43200000);
}

export async function runSync(isInitial = false) {
    if (isSyncing) return;
    isSyncing = true;
    
    log(`\n===========================================`);
    log(`[Anime Sync] Memulai sinkronisasi katalog...`);
    log(`===========================================\n`);

    const dbDir = path.dirname(DB_PATH);
    if (!fs.existsSync(dbDir)) {
        fs.mkdirSync(dbDir, { recursive: true });
    }

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
                const dbDir = path.dirname(DB_PATH);
                if (!fs.existsSync(dbDir)) fs.mkdirSync(dbDir, { recursive: true });
                
                fs.writeFileSync(DB_PATH, JSON.stringify(allAnime, null, 2));
                log(`[Anime Sync] SUKSES! Tersimpan ${allAnime.length} anime ke database lokal.`);
            } catch (fsErr) {
                log(`[Anime Sync] Gagal menyimpan ke disk (mungkin Read-Only). Tersimpan di memory cache. Error: ${fsErr.message}`);
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

// Fungsi pembantu untuk load DB agar cepat
export function loadLocalDatabase() {
    if (global.anime_db_cache) return global.anime_db_cache;
    
    if (fs.existsSync(DB_PATH)) {
        try {
            const raw = fs.readFileSync(DB_PATH, 'utf-8');
            global.anime_db_cache = JSON.parse(raw);
            return global.anime_db_cache;
        } catch(e) {
            console.error("[Anime DB] Gagal membaca JSON:", e.message);
            return [];
        }
    }
    return [];
}
