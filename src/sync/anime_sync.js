import * as cheerio from 'cheerio';
import { releaseToPool } from '../puppeteer/pool.js';
import { fetchWithCF } from '../utils/scrapeHelper.js';
import Anime from '../models/Anime.js';
import { cleanSeriesTitle } from '../utils/stringUtils.js';

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
            log("[Anime Sync] Database Samehadaku kosong. Memulai sinkronisasi awal A-Z penuh...");
            runSync(true, Infinity);
        } else {
            const latestDoc = await Anime.findOne({ 'sources.samehadaku.url': { $exists: true, $ne: null } }).sort({ lastUpdated: -1 });
            const ageInMs = latestDoc && latestDoc.lastUpdated ? (Date.now() - latestDoc.lastUpdated.getTime()) : 0;
            const twelveHours = 12 * 60 * 60 * 1000;
            
            if (ageInMs > twelveHours || !latestDoc || !latestDoc.lastUpdated) {
                log(`[Anime Sync] Database Samehadaku sudah usang (>12 jam). Menjalankan Quick-Sync Halaman 1-3 (Delay 1 menit)...`);
                setTimeout(() => runSync(false, 3), 60000);
            } else {
                log(`[Anime Sync] Database Samehadaku masih baru (Umur: ${Math.round(ageInMs/1000/60)} menit). Melewati sinkronisasi awal.`);
            }
        }
    } catch(err) {
        log("[Anime Sync] Error mengecek status database:", err.message);
    }

    // 1. Quick-Sync (Hanya Halaman 1-3) setiap 6 JAM sekali agar anime baru langsung terbuat kartunya
    setInterval(() => {
        log("[Anime Sync] Menjalankan Quick-Sync 6 Jam (Halaman 1-3)...");
        runSync(false, 3);
    }, 6 * 60 * 60 * 1000); // 6 Jam

    // 2. Full Archive Sync (Seluruh Halaman 1-50+) setiap 7 HARI sekali untuk pemeriksaan arsip mendalam
    setInterval(() => {
        log("[Anime Sync] Menjalankan Full Archive Sync Mingguan (Seluruh Halaman)...");
        runSync(false, Infinity);
    }, 7 * 24 * 60 * 60 * 1000); // 7 Hari
}

export async function runSync(isInitial = false, maxPages = Infinity) {
    if (isSyncing) return;
    isSyncing = true;
    
    log(`\n===========================================`);
    log(`[Anime Sync] Memulai sinkronisasi katalog (Max Halaman: ${maxPages === Infinity ? 'Semua' : maxPages})...`);
    log(`===========================================\n`);

    const allAnime = [];
    let page = 1;
    let hasNext = true;
    let consecutiveFails = 0;

    try {
        while (hasNext && page <= maxPages) {
            const url = page === 1 ? `https://v2.samehadaku.how/daftar-anime-2/` : `https://v2.samehadaku.how/daftar-anime-2/page/${page}/`;
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

                        const rawJudul = titleNode.text().trim();
                        const judul = cleanSeriesTitle(rawJudul);

                        if (judul) {
                            allAnime.push({
                                judul: judul,
                                url: linkNode.attr('href'),
                                gambar: gambarScraper,
                                gambarScraper,
                                tipe: typeNode.length ? typeNode.text().trim().toUpperCase() : 'TV',
                                skor: skorAngka || '-',
                                status: epText || (statusNode.length ? statusNode.text().trim() : 'Completed'),
                            });
                            itemCount++;
                        }
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

            if (!hasNextPage || page >= maxPages) {
                console.log(`[Anime Sync] Batas halaman (${page}/${maxPages}) atau akhir katalog dicapai. Scraping selesai.`);
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

                for (let index = 0; index < allAnime.length; index++) {
                    const anime = allAnime[index];
                    const normTitle = normalizeTitleForMatch(anime.judul);

                    // 1. Cari apakah anime sudah ada berdasarkan URL atau normalizedTitle
                    let existing = await Anime.findOne({
                        $or: [
                            { 'sources.samehadaku.url': anime.url },
                            { normalizedTitle: normTitle }
                        ]
                    });

                    if (existing) {
                        if (!existing.isLocked) {
                            existing.sources.samehadaku = { url: anime.url };
                            existing.status = anime.status || existing.status;
                            if (!existing.image || existing.image.includes('placehold')) {
                                existing.image = anime.gambarScraper;
                            }
                            existing.lastUpdated = new Date(now - index * 1000);
                            await existing.save();
                        } else {
                            // Jika terkunci, hanya update URL sumber dan lastUpdated
                            existing.sources.samehadaku = { url: anime.url };
                            existing.lastUpdated = new Date(now - index * 1000);
                            await existing.save();
                        }
                        updatedCount++;
                    } else {
                        // 2. Jika belum ada, cegah blind insert dengan bertanya ke Jikan/MAL terlebih dahulu
                        const metadata = await searchAnime(anime.judul);
                        if (metadata?.malId) {
                            const existingByMal = await Anime.findOne({ malId: metadata.malId });
                            if (existingByMal) {
                                // Gabungkan ke kartu MAL eksisting (Anti Duplikat!)
                                existingByMal.sources.samehadaku = { url: anime.url };
                                existingByMal.lastUpdated = new Date(now - index * 1000);
                                await existingByMal.save();
                                updatedCount++;
                                continue;
                            }
                        }

                        // Buat dokumen baru dengan metadata resmi jika ada
                        await Anime.create({
                            title: metadata?.title || anime.judul,
                            normalizedTitle: normTitle,
                            malId: metadata?.malId || null,
                            image: metadata?.cover || anime.gambarScraper,
                            type: anime.tipe,
                            score: metadata?.malScore || anime.skor,
                            status: anime.status,
                            sources: { samehadaku: { url: anime.url } },
                            lastUpdated: new Date(now - index * 1000)
                        });
                        createdCount++;
                    }
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
