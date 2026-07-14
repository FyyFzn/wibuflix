import * as cheerio from 'cheerio';
import { releaseToPool } from '../puppeteer/pool.js';
import { fetchWithCF } from '../utils/scrapeHelper.js';
import Anime from '../models/Anime.js'; // Model MongoDB
import { PROVIDER_URLS } from '../config/providerUrls.js';

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
            const url = page === 1 ? PROVIDER_URLS.SAMEHADAKU.CATALOG_URL : `${PROVIDER_URLS.SAMEHADAKU.CATALOG_URL}page/${page}/`;

            log(`[Anime Sync] Scraping Halaman ${page}...`);

            let fetchRes, slot;
            let pageFailed = false;
            let hasNextPage = false;
            let itemCount = 0;

            try {
                fetchRes = await fetchWithCF(url, { timeout: 60000, fetchTimeout: 10000 });
                slot = fetchRes?.slot;

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
                        pageFailed = true;
                    }
                    continue; // Lanjut ke iterasi berikutnya (finally akan tetap jalan)
                }

                const $ = fetchRes.$;

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

                $('.pagination a, .pagination-id a').each((_, el) => {
                    const txt = $(el).text();
                    const hasNextIcon = $(el).find('#nextpagination, .fa-caret-right').length > 0;
                    if (txt.includes('Next') || $(el).hasClass('next') || $(el).hasClass('arrow_pag') || hasNextIcon) {
                        hasNextPage = true;
                    }
                });

            } catch (e) {
                console.error(`[Anime Sync] Gagal memuat halaman ${page}:`, e.message);
                pageFailed = true;
                consecutiveFails++;
                if (consecutiveFails >= 3) {
                    console.error(`[Anime Sync] Gagal berturut-turut 3 kali. Menghentikan sinkronisasi.`);
                    break;
                }
            } finally {
                if (slot) releaseToPool(slot);
            }

            if (pageFailed) {
                await delay(8000);
                continue;
            }

            if (!hasNext) break;

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
                const { normalizeTitleForMatch } = await import('../utils/stringUtils.js');
                const { searchAnime } = await import('../services/metadata/jikan.js');
                const now = Date.now();
                let updatedCount = 0;
                let createdCount = 0;

                // 1. BULK LOOKUP: Ambil semua URL dan Normalized Title dalam 1x Query Database!
                const allUrls = allAnime.map(a => a.url).filter(Boolean);
                const allNormTitles = allAnime.map(a => normalizeTitleForMatch(a.judul)).filter(Boolean);

                const existingDocs = await Anime.find({
                    $or: [
                        { 'sources.samehadaku.url': { $in: allUrls } },
                        { normalizedTitle: { $in: allNormTitles } }
                    ]
                });

                const urlMap = new Map();
                const titleMap = new Map();
                const malIdMap = new Map();
                const processedMalIds = new Set();
                existingDocs.forEach(doc => {
                    if (doc.sources?.samehadaku?.url) urlMap.set(doc.sources.samehadaku.url, doc);
                    if (doc.normalizedTitle) titleMap.set(doc.normalizedTitle, doc);
                    if (doc.malId) malIdMap.set(doc.malId, doc);
                });

                const bulkOperations = [];

                for (let index = 0; index < allAnime.length; index++) {
                    const anime = allAnime[index];
                    const normTitle = normalizeTitleForMatch(anime.judul);
                    let existing = urlMap.get(anime.url) || titleMap.get(normTitle);

                    if (existing) {
                        if (!existing.isLocked) {
                            const updateFields = {
                                'sources.samehadaku': { url: anime.url }
                            };
                            if (!existing.lastUpdated) {
                                updateFields.lastUpdated = new Date(now - index * 1000);
                            }
                            if (anime.status) updateFields.status = anime.status;
                            if (!existing.image || existing.image.includes('placehold')) {
                                updateFields.image = anime.gambarScraper;
                            }

                            bulkOperations.push({
                                updateOne: {
                                    filter: { _id: existing._id },
                                    update: { $set: updateFields }
                                }
                            });
                        } else {
                            const updateFields = { 'sources.samehadaku': { url: anime.url } };
                            if (!existing.lastUpdated) updateFields.lastUpdated = new Date(now - index * 1000);
                            bulkOperations.push({
                                updateOne: {
                                    filter: { _id: existing._id },
                                    update: { $set: updateFields }
                                }
                            });
                        }
                        updatedCount++;
                    } else {
                        // Untuk anime baru, cari Jikan dengan Rate Limiting (Jeda 350ms agar tidak diblokir MAL)
                        await delay(350);
                        const metadata = await searchAnime(anime.judul).catch(() => null);
                        
                        if (metadata && metadata.malId) {
                            if (processedMalIds.has(metadata.malId)) {
                                continue;
                            }
                            let existingByMal = malIdMap.get(metadata.malId);
                            if (!existingByMal) {
                                existingByMal = await Anime.findOne({ malId: metadata.malId });
                                if (existingByMal) malIdMap.set(metadata.malId, existingByMal);
                            }
                            if (existingByMal) {
                                const updateFields = { 'sources.samehadaku': { url: anime.url } };
                                if (!existingByMal.lastUpdated) updateFields.lastUpdated = new Date(now - index * 1000);
                                bulkOperations.push({
                                    updateOne: {
                                        filter: { _id: existingByMal._id },
                                        update: { $set: updateFields }
                                    }
                                });
                                updatedCount++;
                                processedMalIds.add(metadata.malId);
                                continue;
                            }
                        }

                        if (metadata?.malId) processedMalIds.add(metadata.malId);
                        bulkOperations.push({
                            insertOne: {
                                document: {
                                    title: metadata?.title || anime.judul,
                                    normalizedTitle: normTitle,
                                    malId: metadata?.malId || undefined,
                                    image: metadata?.cover || anime.gambarScraper,
                                    type: anime.tipe,
                                    score: metadata?.malScore || anime.skor,
                                    status: anime.status,
                                    sources: { samehadaku: { url: anime.url } },
                                    lastUpdated: new Date(now - index * 1000)
                                }
                            }
                        });
                        createdCount++;
                    }

                    if (bulkOperations.length >= 100) {
                        await Anime.bulkWrite(bulkOperations, { ordered: false }).catch(e => console.warn('[BulkWrite Partial Error]', e.message));
                        bulkOperations.length = 0;
                    }
                }

                if (bulkOperations.length > 0) {
                    await Anime.bulkWrite(bulkOperations, { ordered: false }).catch(e => console.warn('[BulkWrite Partial Error]', e.message));
                }

                log(`[Anime Sync] ✅ Sinkronisasi selesai: ${updatedCount} diupdate/digabung, ${createdCount} baru dibuat.`);
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

