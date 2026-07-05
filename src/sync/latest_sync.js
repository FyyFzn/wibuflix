import * as cheerio from 'cheerio';
import { fetchWithCF } from '../utils/scrapeHelper.js';
import { releaseToPool } from '../puppeteer/pool.js';
import Anime from '../models/Anime.js';
import { cleanSeriesTitle, normalizeTitleForMatch } from '../utils/stringUtils.js';

let isLatestSyncing = false;

const log = (...args) => {
    if (global.forceLog) global.forceLog(...args);
    else console.log(...args);
};

export async function startBackgroundLatestSync() {
    log("[Latest Sync] Memulai penjadwalan pengecekan update episode (setiap 30 menit)...");
    
    // Jalankan pertama kali (tunggu 20 detik agar pool puppeteer siap)
    setTimeout(() => {
        runLatestSync();
    }, 20000);

    // Jadwalkan setiap 30 menit (1.800.000 ms)
    setInterval(() => {
        runLatestSync();
    }, 1800000);
}

export async function runLatestSync() {
    if (isLatestSyncing) return;
    isLatestSyncing = true;
    
    log(`\n===========================================`);
    log(`[Latest Sync] Memulai Fast-Sync Beranda Samehadaku, Otakudesu & Kuronime...`);
    log(`===========================================\n`);

    try {
        await scrapeSamehadakuLatest();
        await scrapeOtakudesuLatest();
        await scrapeKuronimeLatest();
    } catch (e) {
        console.error(`[Latest Sync] Error fatal:`, e.message);
    } finally {
        isLatestSyncing = false;
        log(`[Latest Sync] Selesai.\n`);
    }
}

async function scrapeSamehadakuLatest() {
    const url = `https://v2.samehadaku.how/`;
    log(`[Latest Sync] Mengakses Beranda Samehadaku...`);

    let fetchRes, slot;
    const updates = [];
    try {
        fetchRes = await fetchWithCF(url, { timeout: 60000, fetchTimeout: 10000 });
        slot = fetchRes?.slot;
        
        if (!fetchRes || fetchRes.html === '404_NOT_FOUND' || !fetchRes.html) {
            log(`[Latest Sync] Gagal mendapatkan HTML Samehadaku.`);
            return;
        }

        const $ = fetchRes.$;

        // Mencari di bagian "Post Show" atau elemen animepost terbaru di beranda
        $('.post-show ul li, .animepost').each((_, el) => {
            const titleNode = $(el).find('.title, .entry-title, .tt h2').first();
            const epNode = $(el).find('author[itemprop="name"], .epx').first();
            const linkNode = $(el).find('a').first();
            
            if (titleNode.length && epNode.length) {
                const rawJudul = titleNode.text().trim();
                const judul = cleanSeriesTitle(rawJudul);
                const epsText = epNode.text().trim();
                const href = linkNode.attr('href') || '';
                
                // Format eps jika perlu (contoh: "12" menjadi "Eps 12")
                const finalStatus = epsText.toLowerCase().includes('eps') ? epsText : `Eps ${epsText}`;

                if (judul) {
                    updates.push({ judul, status: finalStatus, url: href });
                }
            }
        });
    } catch (e) {
        console.error(`[Latest Sync] Gagal memuat Samehadaku:`, e.message);
        return;
    } finally {
        if (slot) releaseToPool(slot);
    }

    if (updates.length > 0) {
        log(`[Latest Sync] Ditemukan ${updates.length} anime terupdate di Samehadaku. Melakukan sinkronisasi ke MongoDB...`);
        
        const now = Date.now();
        const bulkOps = updates.map((anime, index) => {
            const normTitle = normalizeTitleForMatch(anime.judul);
            const queryFilter = anime.url 
                ? { $or: [{ 'sources.samehadaku.url': anime.url }, { normalizedTitle: normTitle }, { title: anime.judul }] }
                : { $or: [{ normalizedTitle: normTitle }, { title: anime.judul }] };

            return {
                updateOne: {
                    filter: queryFilter,
                    update: { 
                        $set: { 
                            status: anime.status,
                            lastUpdated: new Date(now - index * 1000)
                        } 
                    }
                }
            };
        });

        const result = await Anime.bulkWrite(bulkOps);
        log(`[Latest Sync] ✅ Samehadaku: Berhasil mengupdate status & waktu ${result.modifiedCount} anime.`);
    } else {
        log(`[Latest Sync] Tidak ada elemen update yang terdeteksi di Samehadaku.`);
    }
}

async function scrapeOtakudesuLatest() {
    const url = `https://otakudesu.blog/`;
    log(`[Latest Sync] Mengakses Beranda Otakudesu...`);

    let fetchRes, slot;
    const updates = [];
    try {
        fetchRes = await fetchWithCF(url, { timeout: 60000, fetchTimeout: 10000 });
        slot = fetchRes?.slot;
        
        if (!fetchRes || fetchRes.html === '404_NOT_FOUND' || !fetchRes.html) {
            log(`[Latest Sync] Gagal mendapatkan HTML Otakudesu.`);
            return;
        }

        const $ = fetchRes.$;

        $('.venz ul li').each((_, el) => {
            const rawTitle = $(el).find('.jdlflm').text().trim();
            const ep = $(el).find('.epz').text().trim();
            const href = $(el).find('a').first().attr('href') || '';
            
            if (rawTitle && ep) {
                const title = cleanSeriesTitle(rawTitle);
                if (title) {
                    updates.push({ title, status: ep, url: href });
                }
            }
        });
    } catch (e) {
        console.error(`[Latest Sync] Gagal memuat Otakudesu:`, e.message);
        return;
    } finally {
        if (slot) releaseToPool(slot);
    }

    if (updates.length > 0) {
        log(`[Latest Sync] Ditemukan ${updates.length} anime terupdate di Otakudesu. Melakukan sinkronisasi ke MongoDB...`);
        
        const now = Date.now();
        const bulkOps = updates.map((anime, index) => {
            const normTitle = normalizeTitleForMatch(anime.title);
            const queryFilter = anime.url 
                ? { $or: [{ 'sources.otakudesu.url': anime.url }, { normalizedTitle: normTitle }, { title: anime.title }] }
                : { $or: [{ normalizedTitle: normTitle }, { title: anime.title }] };

            return {
                updateOne: {
                    filter: queryFilter,
                    update: { 
                        $set: { 
                            status: anime.status,
                            lastUpdated: new Date(now - index * 1000)
                        } 
                    }
                }
            };
        });

        const result = await Anime.bulkWrite(bulkOps);
        log(`[Latest Sync] ✅ Otakudesu: Berhasil mengupdate status & waktu ${result.modifiedCount} anime.`);
    } else {
        log(`[Latest Sync] Tidak ada elemen update yang terdeteksi di Otakudesu.`);
    }
}

async function scrapeKuronimeLatest() {
    const url = `https://kuronime.sbs/`;
    log(`[Latest Sync] Mengakses Beranda Kuronime...`);

    let fetchRes, slot;
    const updates = [];
    try {
        fetchRes = await fetchWithCF(url, { timeout: 60000, fetchTimeout: 10000 });
        slot = fetchRes?.slot;
        
        if (!fetchRes || fetchRes.html === '404_NOT_FOUND' || !fetchRes.html) {
            log(`[Latest Sync] Gagal mendapatkan HTML Kuronime.`);
            return;
        }

        const $ = fetchRes.$;
        const seenUrls = new Set();

        // Hanya ambil section "New Episodes" pertama, bukan "Top Episodes Of The Week"
        $('.bixbox').first().find('article.bsu').each((_, el) => {
            const rawTitle = $(el).find('.bsuxtt h2').text().trim();
            const ep = $(el).find('.bt .ep').text().trim();
            const href = $(el).find('a').attr('href');

            if (rawTitle && ep && href && !seenUrls.has(href)) {
                seenUrls.add(href);
                const title = cleanSeriesTitle(rawTitle);
                if (title) {
                    updates.push({ title, status: ep, url: href });
                }
            }
        });
    } catch (e) {
        console.error(`[Latest Sync] Gagal memuat Kuronime:`, e.message);
        return;
    } finally {
        if (slot) releaseToPool(slot);
    }

    if (updates.length > 0) {
        log(`[Latest Sync] Ditemukan ${updates.length} anime terupdate di Kuronime. Melakukan sinkronisasi ke MongoDB...`);

        const now = Date.now();
        const bulkOps = updates.map((anime, index) => {
            const normTitle = normalizeTitleForMatch(anime.title);
            const queryFilter = { $or: [{ 'sources.kuronime.url': anime.url }, { normalizedTitle: normTitle }, { title: anime.title }] };

            return {
                updateOne: {
                    filter: queryFilter,
                    update: {
                        $set: {
                            status: anime.status,
                            lastUpdated: new Date(now - index * 1000)
                        }
                    }
                }
            };
        });

        const result = await Anime.bulkWrite(bulkOps);
        log(`[Latest Sync] ✅ Kuronime: Berhasil mengupdate status & waktu ${result.modifiedCount} anime.`);
    } else {
        log(`[Latest Sync] Tidak ada elemen update yang terdeteksi di Kuronime.`);
    }
}
