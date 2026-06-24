import axios from 'axios';
import TMDBCache from '../../models/TMDBCache.js';

// Fallback key, users should ideally set TMDB_API_KEY in .env
const TMDB_API_KEY = process.env.TMDB_API_KEY || '13e71c6778f9fd4a2f67ff77238002df';
const BASE_URL = 'https://api.themoviedb.org/3';

function isJapanese(text) {
    return /[\u3000-\u303f\u3040-\u309f\u30a0-\u30ff\uff00-\uff9f\u4e00-\u9faf\u3400-\u4dbf]/.test(text);
}

/**
 * Normalisasi judul untuk mempermudah pencarian.
 */
export function normalizeTitle(title, isToku = false) {
    if (!title) return '';
    let t = title.toLowerCase();
    // Hapus embel-embel umum tanpa menghapus isi di dalamnya (kasus [Oshi No Ko])
    t = t.replace(/subtitle indonesia|sub indo|batch|bd/gi, '');
    // Ganti kurung menjadi spasi agar isinya tetap bisa dicari TMDB
    t = t.replace(/[\[\]【】()]/g, ' ');
    
    // HANYA hapus kata 'season' untuk Tokusatsu (TMDB), karena di TMDB season digabung.
    // Untuk Anime (AniList), Season sangat penting karena ID-nya berbeda tiap season!
    if (isToku) {
        t = t.replace(/season \d+|s\d+/gi, '');
    }
    
    return t.replace(/\s+/g, ' ').trim();
}

/**
 * Fallback pencarian ke AniList GraphQL API (Lebih lengkap & rate limit 90/menit, jauh lebih baik dari MAL)
 */
async function searchAniList(cleanTitle, retries = 3) {
    // Beri jeda 1000ms (1 detik) agar aman dari limit AniList (90 req/menit = 1.5 req/detik maksimal)
    await new Promise(r => setTimeout(r, 1000));
    try {
        const query = `
        query ($search: String) {
          Media(search: $search, type: ANIME) {
            idMal
            title { romaji english native }
            coverImage { extraLarge large }
            averageScore
            description(asHtml: false)
            genres
            episodes
            seasonYear
            status
          }
        }`;

        const response = await axios.post('https://graphql.anilist.co', {
            query,
            variables: { search: cleanTitle }
        }, { timeout: 15000 });

        const item = response.data.data.Media;
        if (item) {
            const aliases = [];
            const addAlias = (val) => { if (val && !isJapanese(val)) aliases.push(val); };
            
            addAlias(item.title.english);
            addAlias(item.title.romaji);
            addAlias(item.title.native); // Will be skipped by isJapanese

            // Mapping Status
            let mappedStatus = 'Unknown';
            if (item.status === 'FINISHED') mappedStatus = 'Completed';
            else if (item.status === 'RELEASING') mappedStatus = 'Ongoing';

            // Mapping Score dari skala 100 ke skala 10 (seperti TMDB/MAL)
            let mappedScore = '-';
            if (item.averageScore) {
                mappedScore = (item.averageScore / 10).toFixed(2);
            }

            return {
                title: item.title.english || item.title.romaji, 
                image: item.coverImage?.extraLarge || item.coverImage?.large || null,
                score: mappedScore,
                synopsis: item.description ? item.description.replace(/<[^>]*>?/gm, '') : 'Sinopsis tidak tersedia di AniList.',
                status: mappedStatus,
                type: 'Anime',
                aliases: [...new Set(aliases.filter(Boolean))],
                genres: item.genres || [],
                episodesCount: item.episodes || null,
                year: item.seasonYear || null,
                malId: item.idMal || null
            };
        }
        return null;
    } catch (e) {
        if (e.response && e.response.status === 429 && retries > 0) {
            const retryAfter = e.response.headers['retry-after'] 
                ? parseInt(e.response.headers['retry-after']) * 1000 
                : 10000; // Default tunggu 10 detik jika tidak ada header
            console.warn(`[AniList] Terkena Rate Limit (429). Menunggu ${retryAfter/1000} detik sebelum mencoba lagi...`);
            await new Promise(r => setTimeout(r, retryAfter));
            return searchAniList(cleanTitle, retries - 1);
        }
        
        // Abaikan 404 Not Found karena wajar jika anime aneh/sangat baru tidak ada di Anilist
        if (e.response && e.response.status !== 404) {
            console.error('[AniList] Gagal mencari:', cleanTitle, e.response?.data?.errors || e.message);
        }
        return null;
    }
}

/**
 * Mencari data Anime dan Tokusatsu di TMDB berdasarkan judul.
 * Mencari di kategori TV Shows, lalu mencari alternatif di Movies.
 */
export async function searchTMDB(title, isToku = false) {
    if (!title) return null;
    
    // Ekstraksi angka Season sebelum dihapus (jika isToku=true)
    let seasonNumber = null;
    const seasonMatch = title.match(/(?:season|s)\s*(\d+)/i);
    if (seasonMatch) {
        seasonNumber = parseInt(seasonMatch[1]);
    }
    
    const cleanTitle = normalizeTitle(title, isToku);
    if (!cleanTitle) return null;

    const cacheKey = `meta_${cleanTitle}_${isToku ? 'toku' : 'anime'}`;
    
    // 1. Cek Cache di MongoDB
    try {
        const cachedDoc = await TMDBCache.findOne({ key: cacheKey });
        if (cachedDoc) {
            return cachedDoc.data; // Return cached data (even if null)
        }
    } catch(err) {
        console.error("[Metadata Cache] Gagal membaca MongoDB cache:", err.message);
    }

    let resultData = null;

    if (!isToku) {
        // ==========================================
        // JALUR ANIME: FULL ANILIST (Kualitas Tinggi)
        // ==========================================
        resultData = await searchAniList(cleanTitle);
        if (resultData) {
            resultData.source = 'AniList';
        }
    } else {
        // ==========================================
        // JALUR TOKUSATSU: FULL TMDB
        // ==========================================
        // Beri jeda mencegah rate limit TMDB
        await new Promise(r => setTimeout(r, 250));

        try {
            let results = [];
            // Coba cari di TV Shows terlebih dahulu
            let url = `${BASE_URL}/search/tv?api_key=${TMDB_API_KEY}&query=${encodeURIComponent(cleanTitle)}&language=en-US&page=1`;
            
            const fetchWithRetry = async (targetUrl, retries = 3) => {
                for (let i = 0; i < retries; i++) {
                    try {
                        const response = await axios.get(targetUrl, { timeout: 10000 });
                        return response.data.results;
                    } catch (err) {
                        if (err.response && err.response.status === 429) {
                            console.warn(`[TMDB] Terkena Rate Limit (429 Too Many Requests). Menunggu 3 detik... (Percobaan ${i+1}/${retries})`);
                            await new Promise(r => setTimeout(r, 3000));
                        } else {
                            throw err;
                        }
                    }
                }
                return [];
            };

            results = await fetchWithRetry(url);

            // Jika tidak ketemu, coba di Movies
            if (!results || results.length === 0) {
                url = `${BASE_URL}/search/movie?api_key=${TMDB_API_KEY}&query=${encodeURIComponent(cleanTitle)}&language=en-US&page=1`;
                results = await fetchWithRetry(url);
            }

            if (results && results.length > 0) {
                let item = results[0];
                try {
                    const stringSimilarity = (await import('string-similarity')).default;
                    const titles = results.map(r => (r.name || r.title || '').toLowerCase());
                    const bestMatch = stringSimilarity.findBestMatch(cleanTitle, titles);
                    if (bestMatch.bestMatch.rating > 0.6) {
                        item = results[bestMatch.bestMatchIndex];
                    }
                } catch (e) {
                    console.warn('[TMDB] Gagal import string-similarity, fallback ke hasil pertama.');
                }
                
                const aliases = [];
                const addAlias = (val) => { if (val && !isJapanese(val)) aliases.push(val); };
                
                addAlias(item.name);
                addAlias(item.original_name);
                addAlias(item.title);
                addAlias(item.original_title);
                
                const score = item.vote_average ? item.vote_average.toFixed(2) : '-';
                let finalStatus = 'Unknown';
                let finalType = url.includes('/search/tv') ? 'TV' : 'Movie';
                
                let image = null;
                let synopsis = item.overview || 'Sinopsis tidak tersedia di TMDB.';
                let genres = [];
                let episodesCount = null;
                let year = null;
                let tmdbId = item.id;
                
                const releaseDate = item.first_air_date || item.release_date;
                if (releaseDate) {
                    year = parseInt(releaseDate.split('-')[0]);
                }
                
                if (finalType === 'TV') {
                    try {
                        const detailRes = await axios.get(`${BASE_URL}/tv/${item.id}?api_key=${TMDB_API_KEY}`);
                        if (detailRes.data.status === 'Ended' || detailRes.data.status === 'Canceled') {
                            finalStatus = 'Completed';
                        } else if (detailRes.data.status === 'Returning Series') {
                            finalStatus = 'Ongoing';
                        }
                        
                        if (detailRes.data.genres) {
                            genres = detailRes.data.genres.map(g => g.name);
                        }
                        if (detailRes.data.number_of_episodes) {
                            episodesCount = detailRes.data.number_of_episodes;
                        }
                        
                        if (seasonNumber && detailRes.data.seasons) {
                            const seasonData = detailRes.data.seasons.find(s => s.season_number === seasonNumber);
                            if (seasonData) {
                                if (seasonData.poster_path) {
                                    image = `https://image.tmdb.org/t/p/w500${seasonData.poster_path}`;
                                }
                                if (seasonData.overview) {
                                    synopsis = seasonData.overview;
                                }
                                if (seasonData.episode_count) {
                                    episodesCount = seasonData.episode_count;
                                }
                                if (seasonData.air_date) {
                                    year = parseInt(seasonData.air_date.split('-')[0]);
                                }
                            }
                        }
                    } catch(e) {}
                } else {
                    finalStatus = 'Completed';
                    try {
                        const detailRes = await axios.get(`${BASE_URL}/movie/${item.id}?api_key=${TMDB_API_KEY}`);
                        if (detailRes.data.genres) {
                            genres = detailRes.data.genres.map(g => g.name);
                        }
                    } catch(e) {}
                }

                if (!image && item.poster_path) {
                    image = `https://image.tmdb.org/t/p/w500${item.poster_path}`;
                }

                resultData = {
                    title: item.name || item.title,
                    image,
                    score,
                    synopsis,
                    status: finalStatus,
                    tipe: finalType,
                    aliases: [...new Set(aliases.filter(Boolean))],
                    genres,
                    episodesCount,
                    year,
                    malId: tmdbId, // TMDB ID for Toku
                    source: 'TMDB'
                };
            }
        } catch (err) {
            console.error(`[TMDB API] Error searching Tokusatsu "${cleanTitle}":`, err.message);
        }
    }

    // 2. Simpan hasil (bahkan jika null) ke MongoDB Cache
    try {
        await TMDBCache.findOneAndUpdate(
            { key: cacheKey },
            { data: resultData },
            { upsert: true }
        );
    } catch(err) {
        console.error("[TMDB] Gagal menyimpan MongoDB cache:", err.message);
    }

    return resultData;
}

export const searchTokusatsu = (title) => searchTMDB(title, true);
