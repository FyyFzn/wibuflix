import * as cheerio from 'cheerio';
import { fetchWithCF } from '../utils/scrapeHelper.js';
import { releaseToPool } from '../puppeteer/pool.js';
import Anime from '../models/Anime.js';

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
    log(`[Latest Sync] Memulai Fast-Sync Beranda Samehadaku & Otakudesu...`);
    log(`===========================================\n`);

    try {
        await scrapeSamehadakuLatest();
        // Nanti bisa ditambahkan await scrapeOtakudesuLatest(); di sini
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

    let fetchRes;
    try {
        fetchRes = await fetchWithCF(url, { timeout: 60000, fetchTimeout: 10000 });
    } catch (e) {
        console.error(`[Latest Sync] Gagal memuat Samehadaku:`, e.message);
        return;
    }

    if (!fetchRes || fetchRes.html === '404_NOT_FOUND' || !fetchRes.html) {
        log(`[Latest Sync] Gagal mendapatkan HTML Samehadaku.`);
        if (fetchRes && fetchRes.slot) releaseToPool(fetchRes.slot);
        return;
    }

    const $ = fetchRes.$;
    const slot = fetchRes.slot;
    const updates = [];

    // Mencari di bagian "Post Show" atau elemen animepost terbaru di beranda
    $('.post-show ul li, .animepost').each((_, el) => {
        const titleNode = $(el).find('.title, .entry-title, .tt h2').first();
        const epNode = $(el).find('author[itemprop="name"], .epx').first();
        
        if (titleNode.length && epNode.length) {
            const judul = titleNode.text().trim();
            const epsText = epNode.text().trim();
            
            // Format eps jika perlu (contoh: "12" menjadi "Eps 12")
            const finalStatus = epsText.toLowerCase().includes('eps') ? epsText : `Eps ${epsText}`;

            updates.push({ judul, status: finalStatus });
        }
    });

    releaseToPool(slot);

    if (updates.length > 0) {
        log(`[Latest Sync] Ditemukan ${updates.length} anime terupdate. Melakukan sinkronisasi ke MongoDB...`);
        
        const bulkOps = updates.map(anime => ({
            updateOne: {
                filter: { title: anime.judul },
                update: { $set: { status: anime.status } }
                // Jangan pakai upsert: true di sini, karena beranda mungkin tidak memuat data lengkap seperti URL gambar
                // Kita hanya ingin mengupdate "status" episode jika anime-nya sudah ada di database.
            }
        }));

        const result = await Anime.bulkWrite(bulkOps);
        log(`[Latest Sync] ✅ Samehadaku: Berhasil mengupdate status ${result.modifiedCount} anime.`);
    } else {
        log(`[Latest Sync] Tidak ada elemen update yang terdeteksi di Samehadaku.`);
    }
}
