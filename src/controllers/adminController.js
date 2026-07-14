// ============================================================
// CONTROLLER: ADMIN COMMAND CENTER & DIAGNOSTIC TOOLS
// ============================================================

import { flushAll } from '../utils/cacheManager.js';
import { runSync } from '../sync/anime_sync.js';
import { syncUnified } from '../sync/unified_sync.js';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// 1. Render Admin Portal Command Center (`GET /admin` & `GET /api/admin`)
export function renderAdminPortal(req, res) {
    res.sendFile(path.join(__dirname, '../views/admin/portal.html'));
}

// 2. Render Live Log Terminal Stream UI (`GET /api/admin/logs`)
export function renderLiveLogUI(req, res) {
    res.sendFile(path.join(__dirname, '../views/admin/liveLog.html'));
}

// 3. Get Raw Log Text Buffer (`GET /api/admin/logs/raw`)
export function getRawLogs(req, res) {
    res.type('text/plain');
    res.send(global.memLogs ? global.memLogs.join('\n') : 'Menunggu log...');
}

// 4. Clear Memory Cache (`GET /api/cache-clear`)
export function clearMemoryCache(req, res) {
    flushAll();
    res.json({ status: 'ok', message: 'Cache cleared' });
}

// 5. Trigger Force Sync All Providers (`GET /api/force-sync`)
export function triggerForceSync(req, res) {
    res.json({ status: 'ok', message: 'Sinkronisasi paksa (Samehadaku, Otakudesu, Kuronime & Unified DB) sedang dijalankan di latar belakang. Proses ini memakan waktu beberapa menit.' });

    Promise.all([
        import('../sync/otaku_sync.js'),
        import('../sync/kuronime_sync.js')
    ]).then(([ { syncOtakudesu }, { syncKuronime } ]) => {
        Promise.all([
            runSync(true),
            syncOtakudesu(),
            syncKuronime()
        ]).then(() => {
            console.log('[ForceSync] Raw Sync selesai. Memulai Unified Sync...');
            return syncUnified();
        }).catch(err => console.error('[ForceSync] Error:', err.message));
    });
}

// 6. Retry Failed TMDB Enrichment (`GET /api/retry-enrich`)
export async function triggerRetryEnrich(req, res) {
    try {
        const Anime = (await import('../models/Anime.js')).default;
        
        const result = await Anime.updateMany(
            { 
                tmdbEnriched: true, 
                $or: [
                    { score: '-' },
                    { image: { $regex: /placehold/i } },
                    { image: null },
                    { image: '' }
                ]
            },
            { $set: { tmdbEnriched: false } }
        );

        res.json({ 
            status: 'ok', 
            message: `Berhasil mereset status tmdbEnriched untuk ${result.modifiedCount} anime. Proses Unified Sync sedang dijalankan di latar belakang untuk mencoba ulang pencarian TMDB.` 
        });

        console.log(`[RetryEnrich] Mereset ${result.modifiedCount} anime. Memulai ulang Unified Sync...`);
        syncUnified().catch(err => console.error('[RetryEnrich] Error:', err.message));

    } catch (error) {
        console.error('[RetryEnrich] Gagal:', error.message);
        res.status(500).json({ error: error.message });
    }
}

// 7. Hard Factory Reset MongoDB (`GET /api/factory-reset`)
export async function triggerFactoryReset(req, res) {
    try {
        const Anime = (await import('../models/Anime.js')).default;
        const TMDBCache = (await import('../models/TMDBCache.js')).default;
        
        await Anime.deleteMany({});
        await TMDBCache.deleteMany({});

        if (global.anime_db_cache) global.anime_db_cache = null;
        if (global.otaku_db_cache) global.otaku_db_cache = null;
        
        const { syncOtakudesu } = await import('../sync/otaku_sync.js');
        const { syncKuronime } = await import('../sync/kuronime_sync.js');

        res.json({ status: 'ok', message: 'BERHASIL! Semua Database MongoDB (Anime & TMDB Cache) telah DIHANCURKAN. Memulai scraping total dari titik nol...' });

        Promise.all([
            runSync(true),
            syncOtakudesu(),
            syncKuronime()
        ]).then(() => {
            console.log('[FactoryReset] Raw Sync selesai. Memulai Unified Sync...');
            return syncUnified();
        }).catch(err => console.error('[FactoryReset] Error:', err.message));

    } catch (error) {
        console.error('[FactoryReset] Gagal:', error.message);
        res.status(500).json({ error: error.message });
    }
}

// 8. Search Catalog Cards for Manual Merge (`GET /api/admin/catalog-search`)
export async function searchCatalogCards(req, res) {
    try {
        const Anime = (await import('../models/Anime.js')).default;
        const query = (req.query.q || '').trim();
        let filter = {};
        if (query) {
            filter = {
                $or: [
                    { title: { $regex: query, $options: 'i' } },
                    { aliases: { $regex: query, $options: 'i' } }
                ]
            };
        }
        const list = await Anime.find(filter)
            .sort({ updatedAt: -1 })
            .limit(40)
            .select('title aliases image type score status isLocked malId tmdbId sources updatedAt');
        res.json({ status: 'ok', data: list });
    } catch (error) {
        console.error('[Admin CatalogSearch] Error:', error.message);
        res.status(500).json({ status: 'error', message: error.message });
    }
}

// 9. Manual Merge Duplicate Anime Cards (`POST /api/admin/merge-anime`)
export async function mergeAnimeCards(req, res) {
    try {
        const { primaryId, targetIds } = req.body;
        if (!primaryId || !Array.isArray(targetIds) || targetIds.length === 0) {
            return res.status(400).json({ status: 'error', message: 'primaryId dan targetIds wajib diisi!' });
        }

        const Anime = (await import('../models/Anime.js')).default;
        const primary = await Anime.findById(primaryId);
        if (!primary) {
            return res.status(404).json({ status: 'error', message: 'Kartu utama tidak ditemukan di database.' });
        }

        const targets = await Anime.find({ _id: { $in: targetIds } });
        if (targets.length === 0) {
            return res.status(404).json({ status: 'error', message: 'Kartu duplikat yang akan digabung tidak ditemukan.' });
        }

        for (const dup of targets) {
            const providerKeys = ['samehadaku', 'otakudesu', 'kuronime', 'neosatsu', 'nanime', 'nimegami', 'oploverz'];
            for (const key of providerKeys) {
                if (dup.sources?.[key]?.url && !primary.sources?.[key]?.url) {
                    if (!primary.sources) primary.sources = {};
                    primary.sources[key] = { ...dup.sources[key] };
                }
            }

            const aliasesSet = new Set([
                ...(primary.aliases || []),
                ...(dup.aliases || []),
                dup.title
            ].filter(Boolean));
            primary.aliases = Array.from(aliasesSet);

            if (!primary.malId && dup.malId) primary.malId = dup.malId;
            if (!primary.tmdbId && dup.tmdbId) primary.tmdbId = dup.tmdbId;
            if ((!primary.image || primary.image.includes('placehold')) && dup.image) {
                primary.image = dup.image;
            }
        }

        primary.isLocked = true;
        await primary.save();

        await Anime.deleteMany({ _id: { $in: targetIds } });

        flushAll();
        if (global.anime_db_cache) global.anime_db_cache = null;
        if (global.otaku_db_cache) global.otaku_db_cache = null;

        res.json({
            status: 'ok',
            message: `Berhasil menggabungkan ${targets.length} kartu ke dalam "${primary.title}" dan mengunci metadatanya!`,
            data: primary
        });
    } catch (error) {
        console.error('[Admin MergeAnime] Error:', error.message);
        res.status(500).json({ status: 'error', message: error.message });
    }
}

// 10. Force / Lock MyAnimeList ID on Card (`POST /api/admin/force-mal-id`)
export async function forceMalIdOnCard(req, res) {
    try {
        const { animeId, malId } = req.body;
        if (!animeId || malId === undefined) {
            return res.status(400).json({ status: 'error', message: 'animeId dan malId wajib diisi!' });
        }

        const Anime = (await import('../models/Anime.js')).default;
        const anime = await Anime.findById(animeId);
        if (!anime) {
            return res.status(404).json({ status: 'error', message: 'Kartu anime tidak ditemukan.' });
        }

        const numericMalId = Number(malId);
        anime.malId = isNaN(numericMalId) || numericMalId <= 0 ? null : numericMalId;
        anime.isLocked = true;
        anime.tmdbEnriched = false;
        await anime.save();

        flushAll();
        if (global.anime_db_cache) global.anime_db_cache = null;
        if (global.otaku_db_cache) global.otaku_db_cache = null;

        syncUnified().catch(err => console.error('[ForceMalId Sync] Error:', err.message));

        res.json({
            status: 'ok',
            message: `Berhasil mengunci MAL ID "${anime.malId || 'Kosong'}" untuk "${anime.title}". Pencarian metadata baru sedang diproses di background!`,
            data: anime
        });
    } catch (error) {
        console.error('[Admin ForceMalId] Error:', error.message);
        res.status(500).json({ status: 'error', message: error.message });
    }
}

// 11. Rename / Edit Anime Card Title (`POST /api/admin/rename-anime`)
export async function renameAnimeCard(req, res) {
    try {
        const { animeId, newTitle } = req.body;
        if (!animeId || !newTitle || !newTitle.trim()) {
            return res.status(400).json({ status: 'error', message: 'animeId dan newTitle wajib diisi!' });
        }

        const Anime = (await import('../models/Anime.js')).default;
        const anime = await Anime.findById(animeId);
        if (!anime) {
            return res.status(404).json({ status: 'error', message: 'Kartu anime tidak ditemukan.' });
        }

        const cleanNewTitle = newTitle.trim();
        const oldTitle = anime.title;

        // Simpan judul lama ke dalam aliases agar pencarian dengan judul lama tetap bekerja
        const aliasesSet = new Set([
            ...(anime.aliases || []),
            oldTitle,
            cleanNewTitle
        ].filter(Boolean));
        anime.aliases = Array.from(aliasesSet);

        anime.title = cleanNewTitle;
        anime.isLocked = true; // Kunci agar tidak tertimpa ulang oleh Scraper
        await anime.save();

        flushAll();
        if (global.anime_db_cache) global.anime_db_cache = null;
        if (global.otaku_db_cache) global.otaku_db_cache = null;

        res.json({
            status: 'ok',
            message: `Berhasil mengubah judul kartu dari "${oldTitle}" menjadi "${cleanNewTitle}" dan mengunci metadatanya!`,
            data: anime
        });
    } catch (error) {
        console.error('[Admin RenameAnime] Error:', error.message);
        res.status(500).json({ status: 'error', message: error.message });
    }
}

// 12. Force Enrich Specific Card(s) immediately (`POST /api/admin/force-enrich-card`)
export async function forceEnrichCards(req, res) {
    try {
        const rawIds = req.body.animeIds || (req.body.animeId ? [req.body.animeId] : []);
        const targetIds = rawIds.filter(Boolean);
        if (targetIds.length === 0) {
            return res.status(400).json({ status: 'error', message: 'animeId atau animeIds wajib diisi!' });
        }

        const Anime = (await import('../models/Anime.js')).default;
        const TMDBCache = (await import('../models/TMDBCache.js')).default;
        const { searchTMDB, normalizeTitle } = await import('../services/metadata/tmdb.js');

        const cards = await Anime.find({ _id: { $in: targetIds } });
        if (cards.length === 0) {
            return res.status(404).json({ status: 'error', message: 'Kartu anime tidak ditemukan di database.' });
        }

        let successCount = 0;
        for (const anime of cards) {
            try {
                const isToku = anime.type === 'Toku';
                let cleanTitle = anime.title.replace(/[\[\]【】()]/g, '').replace(/[-:]\s*$/, '').trim();
                const norm = normalizeTitle(cleanTitle, isToku);
                const cacheKey = `meta_${norm}_${isToku ? 'toku' : 'anime'}`;
                const cacheMalKey = anime.malId ? `meta_mal_${anime.malId}_${isToku ? 'toku' : 'anime'}` : null;

                // Hapus cache MongoDB lama agar benar-benar force fetch data terbaru dari AniList/TMDB
                await TMDBCache.deleteOne({ key: cacheKey });
                if (cacheMalKey) {
                    await TMDBCache.deleteOne({ key: cacheMalKey });
                }

                const tmdbData = await searchTMDB(cleanTitle, isToku, anime.malId);

                if (tmdbData) {
                    if (!anime.image || anime.image.includes('placehold') || req.body.forceOverwriteImage) {
                        anime.image = tmdbData.image || anime.image;
                    }
                    anime.score = tmdbData.score && tmdbData.score !== '-' ? tmdbData.score : anime.score;
                    if (!isToku && anime.type !== 'Toku') {
                        anime.type = tmdbData.type || anime.type;
                        if (!anime.isLocked) anime.malId = tmdbData.malId || anime.malId;
                    }
                    anime.status = tmdbData.status && anime.status === '-' ? tmdbData.status : anime.status;
                    if (tmdbData.synopsis && !tmdbData.synopsis.includes('tidak tersedia')) {
                        anime.synopsis = tmdbData.synopsis;
                    }
                    if (tmdbData.genres && tmdbData.genres.length > 0) {
                        anime.genres = tmdbData.genres;
                    }
                    anime.episodesCount = tmdbData.episodesCount || anime.episodesCount;
                    anime.year = tmdbData.year || anime.year;

                    const mergedAliases = new Set([...(anime.aliases || []), ...(tmdbData.aliases || [])]);
                    anime.aliases = Array.from(mergedAliases).filter(Boolean);

                    anime.tmdbEnriched = true;
                    await anime.save();
                    successCount++;
                } else {
                    anime.tmdbEnriched = false;
                    await anime.save();
                }
            } catch (cardErr) {
                console.error(`[ForceEnrichCard] Error pada kartu "${anime.title}":`, cardErr.message);
            }
        }

        flushAll();
        if (global.anime_db_cache) global.anime_db_cache = null;
        if (global.otaku_db_cache) global.otaku_db_cache = null;

        res.json({
            status: 'ok',
            message: `Berhasil melakukan Force Enrich pada ${successCount} dari ${cards.length} kartu anime yang dipilih!`,
            data: cards
        });
    } catch (error) {
        console.error('[Admin ForceEnrichCard] Error:', error.message);
        res.status(500).json({ status: 'error', message: error.message });
    }
}


