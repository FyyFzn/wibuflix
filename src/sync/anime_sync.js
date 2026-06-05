const fs = require('fs');
const path = require('path');
const cheerio = require('cheerio');
const { ambilDariPool, kembalikanKePool } = require('../puppeteer/pool');

const DB_PATH = path.join(__dirname, '../../data/anime_db.json');
let isSyncing = false;

async function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function startBackgroundAnimeSync() {
    // Run immediately if DB doesn't exist
    if (!fs.existsSync(DB_PATH)) {
        console.log("[Anime Sync] Database lokal tidak ditemukan. Memulai sinkronisasi awal...");
        runSync(true); // true = initial sync (don't block server startup)
    }

    // Schedule every 12 hours (43200000 ms)
    setInterval(() => {
        runSync(false);
    }, 43200000);
}

async function runSync(isInitial = false) {
    if (isSyncing) return;
    isSyncing = true;
    
    console.log(`\n===========================================`);
    console.log(`[Anime Sync] Memulai sinkronisasi katalog...`);
    console.log(`===========================================\n`);

    const dbDir = path.dirname(DB_PATH);
    if (!fs.existsSync(dbDir)) {
        fs.mkdirSync(dbDir, { recursive: true });
    }

    const allAnime = [];
    let page = 1;
    let hasNext = true;
    let consecutiveFails = 0;

    let slot;
    try {
        slot = await ambilDariPool();
        const browserPage = slot.page;

        while (hasNext) {
            const url = page === 1 ? `https://v2.samehadaku.how/daftar-anime-2/` : `https://v2.samehadaku.how/daftar-anime-2/page/${page}/`;
            console.log(`[Anime Sync] Scraping Halaman ${page}...`);

            let html = await browserPage.evaluate(async (targetUrl) => {
                try {
                    const controller = new AbortController();
                    const timeoutId = setTimeout(() => controller.abort(), 10000);
                    const res = await fetch(targetUrl, { signal: controller.signal });
                    clearTimeout(timeoutId);
                    if (res.status === 404) return '404_NOT_FOUND';
                    return await res.text();
                } catch(e) {
                    return '';
                }
            }, url);

            if (html === '404_NOT_FOUND') {
                console.log(`[Anime Sync] Halaman ${page} mengembalikan 404. Akhir dari katalog dicapai.`);
                hasNext = false;
                break;
            }

            const isCloudflare = html.includes('Just a moment') || html.includes('cloudflare') || html.includes('cf-browser-verification') || html.includes('Ray ID:');
            if (!html || html.trim() === '' || isCloudflare) {
                console.log(`[Anime Sync] Fetch gagal/terblokir. Menggunakan page.goto...`);
                try {
                    const response = await browserPage.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
                    if (response.status() === 404) {
                        console.log(`[Anime Sync] Halaman ${page} mengembalikan 404 (Goto). Akhir dari katalog dicapai.`);
                        hasNext = false;
                        break;
                    }
                    html = await browserPage.content();
                } catch (e) {
                    console.error(`[Anime Sync] Gagal memuat halaman ${page}:`, e.message);
                }
            }

            if (!html) {
                consecutiveFails++;
                if (consecutiveFails >= 3) {
                    console.error(`[Anime Sync] Gagal berturut-turut 3 kali. Menghentikan sinkronisasi.`);
                    break;
                }
                await delay(8000);
                continue; // Retry same page
            }

            const $ = cheerio.load(html);
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

            // Check if there's a next page
            let hasNextPage = false;
            $('.pagination a').each((_, el) => {
                const txt = $(el).text();
                if (txt.includes('Next') || $(el).hasClass('next')) hasNextPage = true;
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
            fs.writeFileSync(DB_PATH, JSON.stringify(allAnime, null, 2));
            console.log(`[Anime Sync] SUKSES! Tersimpan ${allAnime.length} anime ke database lokal.`);
            // Update cache memory on the fly
            global.anime_db_cache = allAnime;
        }

    } catch (e) {
        console.error(`[Anime Sync] Error fatal selama sinkronisasi:`, e.message);
    } finally {
        if (slot) kembalikanKePool(slot);
        isSyncing = false;
    }
}

// Fungsi pembantu untuk load DB agar cepat
function loadLocalDatabase() {
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

module.exports = {
    startBackgroundAnimeSync,
    loadLocalDatabase
};
