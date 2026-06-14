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
            return;
        }

        log(`[UnifiedSync] Ditemukan ${unenrichedAnimes.length} anime baru. Memproses pencarian TMDB...`);

        let enrichedCount = 0;
        for (const anime of unenrichedAnimes) {
            // Bersihkan judul dari angka season/part untuk pencarian TMDB yang optimal
            let cleanTitle = anime.title.replace(/[\[\]【】()]/g, '');
            cleanTitle = cleanTitle.replace(/season\s*\d+/i, '').replace(/part\s*\d+/i, '').trim();
            cleanTitle = cleanTitle.replace(/[-:]\s*$/, '').trim();
            
            const isToku = anime.type === 'Toku';
            const tmdbData = await searchTMDB(cleanTitle, isToku);
            
            if (tmdbData) {
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

    } catch (err) {
        console.error('[UnifiedSync] Error fatal pada worker:', err.message);
    }
}

// Jika dijalankan langsung dari terminal
if (process.argv[1] && fileURLToPath(import.meta.url) === fs.realpathSync(process.argv[1])) {
    import('../config/db.js').then(({ default: connectDB }) => {
        connectDB().then(() => syncUnified().then(() => process.exit(0)));
    });
}
