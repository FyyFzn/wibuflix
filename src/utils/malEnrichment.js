import { searchAnime, getAnimeEpisodes } from '../api/jikan.js';
import { searchTokusatsu } from '../api/tmdb.js';

/**
 * Memperkaya daftar episode dengan metadata dari MyAnimeList atau TMDB.
 * @param {string} title - Judul seri anime/tokusatsu
 * @param {Array} episodes - Daftar episode dari scraper [{judul, url, tanggal}]
 * @param {string} defaultCover - Cover URL default jika API tidak mengembalikan cover
 * @returns {Promise<{mal: object, enrichedEpisodes: Array}>}
 */
export async function enrichWithMAL(title, episodes = [], defaultCover = '') {
    let mal = null;
    let malEpisodeMap = {};
    const titleLow = title.toLowerCase();
    
    const isToku = ['kamen rider', 'ultraman', 'super sentai', 'garo', 'boonboomger', 'gotchard', 'geats', 'revice', 'power rangers', 'project red', 'metal hero'].some(kw => titleLow.includes(kw));

    try {
        if (isToku) {
            console.log(`[TMDB] Mencari metadata untuk: "${title}"`);
            const tmdbData = await searchTokusatsu(title);
            if (tmdbData) {
                console.log(`[TMDB] Ketemu: score=${tmdbData.score}`);
                mal = {
                    malScore: tmdbData.score,
                    synopsis: tmdbData.synopsis,
                    cover: tmdbData.image || defaultCover,
                    status: tmdbData.status || 'Unknown',
                    genres: ['Tokusatsu'],
                    source: 'TMDB'
                };
            } else {
                console.log(`[TMDB] Tidak ditemukan untuk: "${title}"`);
            }
        } else {
            console.log(`[MAL] Mencari data untuk: "${title}"`);
            mal = await searchAnime(title);

            if (mal) {
                console.log(`[MAL] Ketemu: score=${mal.malScore}, genres=${mal.genres.join(', ')}`);
                // Ambil judul episode dari MAL
                malEpisodeMap = await getAnimeEpisodes(mal.malId, mal.episodes);
            } else {
                console.log(`[MAL] Tidak ditemukan untuk: "${title}"`);
            }
        }
    } catch (e) {
        console.warn(`[MAL/TMDB Enrichment Error]`, e.message);
    }

    // Inject judul MAL ke tiap episode
    const enrichedEpisodes = episodes.map(ep => {
        const newEp = { ...ep };
        if (Object.keys(malEpisodeMap).length > 0) {
            const match = ep.judul.match(/(?:episode|eps|ep)\s*(\d+(\.\d+)?)/i) || ep.judul.match(/(\d+(\.\d+)?)\s*(?:\(End\))?\s*$/i) || ep.judul.match(/(\d+)$/);
            if (match) {
                const num = String(parseInt(match[1], 10));
                const malTitle = malEpisodeMap[num];
                if (malTitle) newEp.malJudul = malTitle;
            }
        }
        return newEp;
    });

    const malObject = mal ? {
        malId:    mal.malId,
        malUrl:   mal.malUrl,
        malScore: mal.malScore,
        malRank:  mal.malRank,
        genres:   mal.genres,
        synopsis: mal.synopsis,
        episodes: mal.episodes,
        status:   mal.status,
        studios:  mal.studios,
        year:     mal.year,
        rating:   mal.rating,
        cover:    mal.cover || defaultCover,
        coverWebp: mal.coverWebp || null,
    } : null;

    return { mal: malObject, enrichedEpisodes };
}
