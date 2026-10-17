import Anime from '../models/Anime.js';
import { searchTMDB } from '../services/metadata/tmdb.js';
import { isSafeToMerge, isSafeToMergeById } from '../utils/stringUtils.js';
import { fileURLToPath } from 'url';
import fs from 'fs';

const log = (...args) => {
    if (global.forceLog) {
        global.forceLog(...args);
    } else {
        console.log(...args);
    }
};

export async function syncUnified() {
    log('[UnifiedSync] Memulai Pekerja Pengayaan Data (Enrichment Worker)...');
    try {
        // Cari anime yang belum diperkaya dengan data TMDB (limit 50 per siklus agar tidak kena rate-limit API TMDB)
        const unenrichedAnimes = await Anime.find({ tmdbEnriched: false }).limit(50);

        if (unenrichedAnimes.length === 0) {
            log('[UnifiedSync] Semua anime di database sudah berstatus diperkaya. Tidak ada pekerjaan.');
            return false;
        }

        log(`[UnifiedSync] Ditemukan ${unenrichedAnimes.length} anime baru. Memproses pencarian TMDB...`);

        const bulkOps = [];
        let enrichedCount = 0;
        for (const anime of unenrichedAnimes) {
            try {
                // Bersihkan judul dari karakter aneh untuk pencarian TMDB/AniList
                let cleanTitle = anime.title.replace(/[\[\]【】()]/g, '');
                // JANGAN hapus season/part di sini. Biarkan tmdb.js yang mengatur penghapusan season (jika Toku)
                cleanTitle = cleanTitle.replace(/[-:]\s*$/, '').trim();

                const isToku = anime.type === 'Toku';
                const tmdbData = await searchTMDB(cleanTitle, isToku, anime.malId);


                if (tmdbData) {
                    // =========================================================================
                    // AUTO-MERGE DETECTOR: Mencegah duplikasi dari web yang berbeda penamaan!
                    // =========================================================================
                    if (tmdbData.malId && !isToku) {
                        const existingDuplicate = await Anime.findOne({
                            malId: tmdbData.malId,
                            _id: { $ne: anime._id }
                        });

                        if (existingDuplicate) {
                            // Validasi ekstra:
                            // 1. Anime (AniList): ID sangat akurat, jadi abaikan string similarity (nama JP vs EN bisa beda jauh),
                            //    cukup pastikan Season/Part tidak bertabrakan (isSafeToMergeById).
                            // 2. Tokusatsu (TMDB): TMDB sering menggabungkan banyak judul (misal Power Rangers) ke 1 ID seri TV.
                            //    Maka Toku WAJIB lolos string similarity tinggi (>0.85) agar judul beda tidak melebur.
                            let isSafe = false;
                            
                            if (!isToku) {
                                isSafe = isSafeToMergeById(anime.title, existingDuplicate.title);
                            } else {
                                const safeCheck = isSafeToMerge(anime.title, existingDuplicate.title, 0.85);
                                isSafe = safeCheck.isSafe;
                            }

                            if (isSafe) {
                                log(`[UnifiedSync] 🔗 DUPLIKAT TERDETEKSI! Meleburkan "${anime.title}" ke dalam "${existingDuplicate.title}" (TMDB ID: ${tmdbData.malId})`);

                                // Gabungkan URL dari anime ini ke anime utama tanpa peduli asal provider (Anonymous Array)
                                if (anime.sourceUrls && anime.sourceUrls.length > 0) {
                                    const mergedUrls = new Set([
                                        ...(existingDuplicate.sourceUrls || []),
                                        ...anime.sourceUrls
                                    ]);
                                    existingDuplicate.sourceUrls = Array.from(mergedUrls);
                                }

                                // Gabungkan aliases agar pencarian Atlas Search makin pintar
                                const mergedAliases = new Set([...existingDuplicate.aliases, ...anime.aliases, anime.title]);
                                existingDuplicate.aliases = Array.from(mergedAliases).filter(Boolean);

                                // Gunakan gambar yang lebih baik jika ada
                                if (!existingDuplicate.image || existingDuplicate.image.includes('placehold')) {
                                    if (anime.image && !anime.image.includes('placehold')) {
                                        existingDuplicate.image = anime.image;
                                    } else if (tmdbData.image) {
                                        existingDuplicate.image = tmdbData.image;
                                    }
                                }

                                await existingDuplicate.save();

                                // Hapus dokumen anime yang saat ini sedang diproses karena sudah dilebur
                                await Anime.deleteOne({ _id: anime._id });
                                enrichedCount++;
                                continue; // Lanjut ke anime berikutnya
                            }
                        }
                    }
                    // =========================================================================

                    const updateFields = {
                        tmdbEnriched: true
                    };

                    // Jangan timpa gambar jika gambar asli sudah bagus (kecuali placeholder)
                    if (!anime.image || anime.image.includes('placehold')) {
                        if (tmdbData.image) updateFields.image = tmdbData.image;
                    }

                    if (tmdbData.score && tmdbData.score !== '-') {
                        updateFields.score = tmdbData.score;
                    }

                    // PENTING: Jangan timpa tipe jika itu adalah Tokusatsu
                    if (!anime.isToku && anime.type !== 'Toku') {
                        if (tmdbData.type) updateFields.type = tmdbData.type;
                        if (tmdbData.malId) updateFields.malId = tmdbData.malId;
                    } else {
                        updateFields.malId = null; // Pastikan Tokusatsu tidak memiliki malId
                    }

                    if (tmdbData.status && anime.status === '-') {
                        updateFields.status = tmdbData.status;
                    }

                    // Simpan metadata lanjutan
                    if (tmdbData.synopsis && tmdbData.synopsis !== 'Sinopsis tidak tersedia di TMDB.' && tmdbData.synopsis !== 'Sinopsis tidak tersedia di Jikan.') {
                        updateFields.synopsis = tmdbData.synopsis;
                    }
                    if (tmdbData.genres && tmdbData.genres.length > 0) {
                        updateFields.genres = tmdbData.genres;
                    }
                    if (tmdbData.episodesCount) {
                        updateFields.episodesCount = tmdbData.episodesCount;
                    }
                    if (tmdbData.year) {
                        updateFields.year = tmdbData.year;
                    }
                    if (tmdbData.score !== '-') {
                        updateFields.malScore = tmdbData.score;
                    }

                    // Gabungkan array alias untuk pencarian teks yang lebih tangguh
                    const mergedAliases = new Set([...anime.aliases, ...(tmdbData.aliases || [])]);
                    updateFields.aliases = Array.from(mergedAliases).filter(Boolean);

                    bulkOps.push({
                        updateOne: {
                            filter: { _id: anime._id },
                            update: { $set: updateFields }
                        }
                    });
                    enrichedCount++;
                } else {
                    // Jika tidak ketemu di TMDB, tandai 'true' agar tidak dicek berulang-ulang pada siklus berikutnya
                    bulkOps.push({
                        updateOne: {
                            filter: { _id: anime._id },
                            update: { $set: { tmdbEnriched: true } }
                        }
                    });
                }
            } catch (itemErr) {
                if (itemErr.name === 'DocumentNotFoundError') {
                    // Dokumen dihapus secara concurrent oleh proses lain (misal reset database)
                    log(`[UnifiedSync] Peringatan: Dokumen "${anime.title}" tidak ditemukan saat disave (mungkin telah dihapus/dilebur proses lain).`);
                } else if (itemErr.name === 'VersionError') {
                    // Dokumen diubah oleh proses lain (misal scraper berjalan bersamaan)
                    log(`[UnifiedSync] Peringatan: Race condition pada "${anime.title}". Akan dicoba lagi pada siklus berikutnya.`);
                } else {
                    console.error(`[UnifiedSync] Error pada item "${anime.title}":`, itemErr.message);
                }
            }
        }

        if (bulkOps.length > 0) {
            await Anime.bulkWrite(bulkOps);
        }

        log(`[UnifiedSync] ✅ Berhasil memperbarui metadata ${enrichedCount} anime dari TMDB.`);

        // Bersihkan seluruh cache API (seperti /api/katalog) agar aplikasi frontend langsung menerima pembaruan gambar/skor
        try {
            const { flushAll } = await import('../utils/cacheManager.js');
            flushAll();
            log('[UnifiedSync] Cache API dihapus.');
        } catch (cacheErr) {
            log('[UnifiedSync] Gagal menghapus cache API:', cacheErr.message);
        }

        return unenrichedAnimes.length === 50;

    } catch (err) {
        console.error('[UnifiedSync] Error fatal pada worker:', err.message);
        return false;
    }
}

// Jika dijalankan langsung dari terminal
if (process.argv[1] && fileURLToPath(import.meta.url) === fs.realpathSync(process.argv[1])) {
    import('../config/db.js').then(({ default: connectDB }) => {
        connectDB().then(() => syncUnified().then(() => process.exit(0)));
    });
}
