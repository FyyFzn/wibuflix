import axios from 'axios';
import Anime from '../models/Anime.js';
import { normalizeTitleForMatch, isSafeToMerge } from '../utils/stringUtils.js';
import { fetchNanimeInertia } from '../services/scrapers/nanimeScraper.js';
import { PROVIDER_URLS, getProviderSeriesUrl } from '../config/providerUrls.js';

let isNanimeSyncing = false;

const log = (...args) => {
    if (global.forceLog) global.forceLog(...args);
    else console.log(...args);
};

/**
 * Melakukan sinkronisasi katalog A-Z Nanime ID menggunakan endpoint /explore.
 * Menggunakan respons JSON Inertia dan menerapkan 3-Layer Structural Protection.
 */
export async function syncNanimeCatalog() {
    if (isNanimeSyncing) {
        log('[NanimeSync] Proses sinkronisasi sedang berjalan, dilewati...');
        return;
    }

    isNanimeSyncing = true;
    log('\n===========================================');
    log('[NanimeSync] Memulai Sinkronisasi Katalog A-Z (/explore)...');
    log('===========================================\n');

    try {
        let currentPage = 1;
        let lastPage = 1;
        const allAnimes = [];

        do {
            log(`[NanimeSync] Mengambil halaman explore ${currentPage}/${lastPage}...`);
            const url = `${PROVIDER_URLS.NANIME.BASE_URL}/explore?page=${currentPage}`;

            try {
                const data = await fetchNanimeInertia(url);
                const animesProp = data?.props?.animes || {};
                const dataList = animesProp.data || [];
                lastPage = animesProp.last_page || 1;

                if (dataList.length === 0) break;

                for (const item of dataList) {
                    // 3-Layer Structural Protection (Anti-Comic)
                    // Layer 1 & 2: Validasi Tipe & Atribut Fisik
                    const rawType = (item.type || '').toString().toUpperCase();
                    const comicTypes = ['MANGA', 'MANHWA', 'MANHUA', 'COMIC', 'NOVEL', 'DOUJIN', 'ONE-SHOT'];
                    if (comicTypes.includes(rawType) || item.chapters !== undefined || item.chapters_count !== undefined) {
                        continue;
                    }

                    // Mapping format media universal WibuFlix
                    let mediaType = 'TV';
                    if (rawType === 'MOVIE' || rawType === 'FILM') mediaType = 'Movie';
                    else if (rawType === 'OVA') mediaType = 'OVA';
                    else if (rawType === 'ONA') mediaType = 'ONA';
                    else if (rawType === 'SPECIAL' || rawType === 'SP') mediaType = 'Special';
                    else if (rawType === 'BD' || rawType === 'BLU-RAY') mediaType = 'BD';

                    const title = item.title || item.name;
                    const slug = item.slug;
                    if (!title || !slug) continue;

                    const animeUrl = getProviderSeriesUrl('NANIME', slug);


                    allAnimes.push({
                        title: title.trim(),
                        url: animeUrl,
                        id: (item.id || slug).toString(),
                        type: mediaType,
                        poster: item.poster || item.image || '',
                        status: item.status || 'Completed',
                        score: item.rating || item.score || '-',
                        year: item.release_year || item.year || null,
                        genres: item.genres ? item.genres.map(g => (typeof g === 'object' ? g.name : g)) : []
                    });
                }

                // Beri jeda 300ms antar halaman agar ramah server
                await new Promise(r => setTimeout(r, 300));
                currentPage++;
            } catch (err) {
                console.error(`[NanimeSync] Error pada halaman ${currentPage}:`, err.message);
                break;
            }
        } while (currentPage <= lastPage && currentPage <= 100); // Batasi maks 100 halaman sebagai pengaman

        log(`[NanimeSync] Berhasil mengumpulkan ${allAnimes.length} judul anime dari /explore. Melakukan pemetaan ke database...`);

        if (allAnimes.length === 0) {
            log('[NanimeSync] Tidak ada data anime yang terkumpul.');
            return;
        }

        // Pre-fetch database anime existing (kecuali Tokusatsu)
        const existingAnimes = await Anime.find(
            { isToku: { $ne: true }, type: { $ne: 'Toku' } },
            { title: 1, aliases: 1, 'sourceUrls': 1 }
        ).lean();

        const now = Date.now();
        const bulkOps = [];

        for (let i = 0; i < allAnimes.length; i++) {
            // Unblock event loop agar API tidak mati!
            if (i % 25 === 0) await new Promise(r => setImmediate(r));
            
            const anime = allAnimes[i];
            const normTitle = normalizeTitleForMatch(anime.title);

            let matchedId = null;
            let bestScore = 0;

            // Fuzzy matching terhadap database yang sudah ada
            for (const dbAnime of existingAnimes) {
                const { isSafe, score } = isSafeToMerge(anime.title, dbAnime.title, 0.85);
                if (isSafe && score > bestScore) {
                    bestScore = score;
                    matchedId = dbAnime._id;
                }
                // Cek juga array aliases
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
                // Gabungkan ke dokumen existing (tanpa menimpa lastUpdated!)
                bulkOps.push({
                    updateOne: {
                        filter: { _id: matchedId },
                        update: {
                            $addToSet: { sourceUrls: anime.url }
                        }
                    }
                });
            } else {
                // Buat dokumen baru (karena katalog Nanime menyediakan metadata kaya, kita langsung simpan!)
                bulkOps.push({
                    updateOne: {
                        filter: { title: anime.title },
                        update: {
                            $set: {
                                'sources.nanime.url': anime.url,
                                'sources.nanime.id': anime.id,
                                normalizedTitle: normTitle,
                                image: anime.poster || '',
                                score: anime.score || '-',
                                year: anime.year || null,
                                genres: anime.genres || []
                            },
                            $setOnInsert: {
                                title: anime.title,
                                type: anime.type || 'TV',
                                isToku: false,
                                status: anime.status || 'Completed',
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
            log(`[NanimeSync] ✅ Selesai! Modified: ${result.modifiedCount}, Upserted: ${result.upsertedCount}`);
        }
    } catch (err) {
        log(`[NanimeSync] ❌ Error fatal: ${err.message}`);
    } finally {
        isNanimeSyncing = false;
        log('[NanimeSync] Selesai.\n');
    }
}

/**
 * Jalankan sinkronisasi awal jika database Nanime kosong, lalu jadwalkan setiap 7 hari.
 */
export async function startBackgroundNanimeSync() {
    try {
        const count = await Anime.countDocuments({ 'sourceUrls': { $exists: true, $not: { $size: 0 } } });
        if (count === 0) {
            log('[NanimeSync] Database Nanime kosong. Memulai sinkronisasi awal...');
            setTimeout(() => {
                syncNanimeCatalog();
            }, 10000); // Tunggu 10 detik setelah server start
        } else {
            log(`[NanimeSync] Sudah ada ${count} anime Nanime di database. Penjadwalan mingguan aktif.`);
        }
    } catch (err) {
        console.error('[NanimeSync] Error saat pengecekan awal:', err.message);
    }

    // Jadwalkan setiap 7 hari (604.800.000 ms)
    setInterval(() => {
        syncNanimeCatalog();
    }, 604800000);
}
