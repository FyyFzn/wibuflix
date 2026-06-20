import Anime from '../models/Anime.js';
import { searchTMDB } from '../services/metadata/tmdb.js';
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

        let enrichedCount = 0;
        for (const anime of unenrichedAnimes) {
            // Bersihkan judul dari angka season/part untuk pencarian TMDB yang optimal
            let cleanTitle = anime.title.replace(/[\[\]【】()]/g, '');
            cleanTitle = cleanTitle.replace(/season\s*\d+/i, '').replace(/s\d+/i, '').replace(/part\s*\d+/i, '').trim();
            cleanTitle = cleanTitle.replace(/[-:]\s*$/, '').trim();
            
            const isToku = anime.type === 'Toku';
            const tmdbData = await searchTMDB(cleanTitle, isToku);
            
            if (tmdbData) {
                // =========================================================================
                // AUTO-MERGE DETECTOR: Mencegah duplikasi dari web yang berbeda penamaan!
                // =========================================================================
                if (tmdbData.malId) {
                    const existingDuplicate = await Anime.findOne({ 
                        malId: tmdbData.malId, 
                        _id: { $ne: anime._id } 
                    });

                    if (existingDuplicate) {
                        log(`[UnifiedSync] 🔗 DUPLIKAT TERDETEKSI! Meleburkan "${anime.title}" ke dalam "${existingDuplicate.title}" (TMDB ID: ${tmdbData.malId})`);
                        
                        // Gabungkan sumber (sources) dari anime ini ke anime utama
                        if (anime.sources) {
                            if (anime.sources.samehadaku?.url && !existingDuplicate.sources.samehadaku?.url) {
                                existingDuplicate.sources.samehadaku = anime.sources.samehadaku;
                            }
                            if (anime.sources.otakudesu?.url && !existingDuplicate.sources.otakudesu?.url) {
                                existingDuplicate.sources.otakudesu = anime.sources.otakudesu;
                            }
                            if (anime.sources.kuronime?.url && !existingDuplicate.sources.kuronime?.url) {
                                existingDuplicate.sources.kuronime = anime.sources.kuronime;
                            }
                            if (anime.sources.neosatsu?.url && !existingDuplicate.sources.neosatsu?.url) {
                                existingDuplicate.sources.neosatsu = anime.sources.neosatsu;
                            }
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
                // =========================================================================

                // Jangan timpa gambar jika gambar asli sudah bagus (kecuali placeholder)
                if (!anime.image || anime.image.includes('placehold')) {
                    anime.image = tmdbData.image;
                }
                
                anime.score = tmdbData.score && tmdbData.score !== '-' ? tmdbData.score : anime.score;
                
                // PENTING: Jangan timpa tipe jika itu adalah Tokusatsu
                if (anime.type !== 'Toku') {
                    anime.type = tmdbData.type || anime.type;
                }
                
                anime.status = tmdbData.status && anime.status === '-' ? tmdbData.status : anime.status;
                
                // Simpan metadata lanjutan
                if (tmdbData.synopsis && tmdbData.synopsis !== 'Sinopsis tidak tersedia di TMDB.' && tmdbData.synopsis !== 'Sinopsis tidak tersedia di Jikan.') {
                    anime.synopsis = tmdbData.synopsis;
                }
                if (tmdbData.genres && tmdbData.genres.length > 0) {
                    anime.genres = tmdbData.genres;
                }
                anime.episodesCount = tmdbData.episodesCount || anime.episodesCount;
                anime.year = tmdbData.year || anime.year;
                anime.malId = tmdbData.malId || anime.malId;
                anime.malScore = tmdbData.score !== '-' ? tmdbData.score : anime.malScore;
                
                // Gabungkan array alias untuk pencarian teks yang lebih tangguh
                const mergedAliases = new Set([...anime.aliases, ...(tmdbData.aliases || [])]);
                anime.aliases = Array.from(mergedAliases).filter(Boolean);
                
                anime.tmdbEnriched = true;
                await anime.save();
                enrichedCount++;
            } else {
                // Jika tidak ketemu di TMDB, tandai 'true' agar tidak dicek berulang-ulang pada siklus berikutnya
                anime.tmdbEnriched = true; 
                await anime.save();
            }
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
