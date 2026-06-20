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
export function normalizeTitle(title) {
    if (!title) return '';
    let t = title.toLowerCase();
    // Hapus embel-embel umum tanpa menghapus isi di dalamnya (kasus [Oshi No Ko])
    t = t.replace(/subtitle indonesia|sub indo|batch|bd/gi, '');
    // Ganti kurung menjadi spasi agar isinya tetap bisa dicari TMDB
    t = t.replace(/[\[\]【】()]/g, ' ');
    // Hapus season
    t = t.replace(/season \d+|s\d+/gi, '');
    return t.replace(/\s+/g, ' ').trim();
}

/**
 * Fallback pencarian ke AniList GraphQL API (Lebih lengkap & rate limit 90/menit, jauh lebih baik dari MAL)
 */
async function searchAniList(cleanTitle) {
    // Beri jeda 200ms saja karena limit AniList sangat longgar (90 req/menit)
    await new Promise(r => setTimeout(r, 200));
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
        }, { timeout: 10000 });

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
                title: item.title.english || item.title.romaji, // Prioritaskan judul bahasa Inggris untuk konsistensi
                image: item.coverImage?.extraLarge || item.coverImage?.large || null,
                score: mappedScore,
                synopsis: item.description ? item.description.replace(/<[^>]*>?/gm, '') : 'Sinopsis tidak tersedia di AniList.', // Hapus sisa tag HTML
                status: mappedStatus,
                type: 'Anime', // AniList Media tipe Anime
                aliases: [...new Set(aliases.filter(Boolean))],
                genres: item.genres || [],
                episodesCount: item.episodes || null,
                year: item.seasonYear || null,
                malId: item.idMal || null
            };
        }
        return null;
    } catch (e) {
        console.error('[AniList] Gagal mencari:', cleanTitle, e.response?.data || e.message);
        return null;
    }
}

/**
 * Mencari data Anime dan Tokusatsu di TMDB berdasarkan judul.
 * Mencari di kategori TV Shows, lalu mencari alternatif di Movies.
 */
export async function searchTMDB(title, isToku = false) {
    if (!title) return null;
    
    // Ekstraksi angka Season sebelum dihapus oleh normalizeTitle
    let seasonNumber = null;
    const seasonMatch = title.match(/(?:season|s)\s*(\d+)/i);
    if (seasonMatch) {
        seasonNumber = parseInt(seasonMatch[1]);
    }
    
    const cleanTitle = normalizeTitle(title);
    if (!cleanTitle) return null;

    const cacheKey = `tmdb_${cleanTitle}`;
    
    // 1. Cek Cache di MongoDB
    try {
        const cachedDoc = await TMDBCache.findOne({ key: cacheKey });
        if (cachedDoc) {
            return cachedDoc.data; // Return cached data (even if null)
        }
    } catch(err) {
        console.error("[TMDB] Gagal membaca MongoDB cache:", err.message);
    }

    // Beri jeda HANYA jika tidak ada di cache (mencegah rate limit TMDB: 40 req / 10 sec)
    // 250ms delay = max 4 req/sec = 40 req per 10 detik (Batas Aman)
    await new Promise(r => setTimeout(r, 250));

    let resultData = null;

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
            // Ambil hasil yang paling relevan (mencegah salah pilih sekuel/spinoff)
            let item = results[0];
            try {
                const stringSimilarity = (await import('string-similarity')).default;
                const titles = results.map(r => r.name || r.title || '');
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
            
            // Format skor: TMDB scale is 0-10, Jikan is 0-10
            const score = item.vote_average ? item.vote_average.toFixed(2) : '-';
            
            let finalStatus = 'Unknown';
            let finalType = url.includes('/search/tv') ? 'TV' : 'Movie';
            
            let image = null;
            let synopsis = item.overview || 'Sinopsis tidak tersedia di TMDB.';
            let genres = [];
            let episodesCount = null;
            let year = null;
            let tmdbId = item.id;
            
            // Ekstrak tahun dari first_air_date atau release_date
            const releaseDate = item.first_air_date || item.release_date;
            if (releaseDate) {
                year = parseInt(releaseDate.split('-')[0]);
            }
            
            // Coba ambil detail spesifik untuk Season jika ini adalah TV Show dan kita memiliki seasonNumber
            let specificSeasonFound = false;
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
                            // Timpa tahun dengan tahun rilis season ini jika ada
                            if (seasonData.air_date) {
                                year = parseInt(seasonData.air_date.split('-')[0]);
                            }
                            specificSeasonFound = true;
                        }
                    }
                } catch(e) {
                    // Ignore detail errors
                }
            } else {
                finalStatus = 'Completed';
                try {
                    const detailRes = await axios.get(`${BASE_URL}/movie/${item.id}?api_key=${TMDB_API_KEY}`);
                    if (detailRes.data.genres) {
                        genres = detailRes.data.genres.map(g => g.name);
                    }
                } catch(e) {}
            }

            // Thumbnail poster fallback jika spesifik season tidak ditemukan
            if (!image) {
                if (item.poster_path) {
                    image = `https://image.tmdb.org/t/p/w500${item.poster_path}`;
                } else if (!isToku) {
                    // Fallback to AniList just for the image if TMDB lacks a poster (DILARANG UNTUK TOKU)
                    try {
                        const anilistFallback = await searchAniList(cleanTitle);
                        if (anilistFallback && anilistFallback.image) {
                            image = anilistFallback.image;
                        }
                        if (anilistFallback && anilistFallback.aliases) {
                            aliases.push(...anilistFallback.aliases);
                        }
                        if (anilistFallback) {
                            genres = genres.length > 0 ? genres : (anilistFallback.genres || []);
                            episodesCount = episodesCount || anilistFallback.episodesCount;
                            year = year || anilistFallback.year;
                            tmdbId = anilistFallback.malId || tmdbId;
                        }
                    } catch(e) {}
                }
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
                malId: tmdbId, // For Tokusatsu, use TMDB ID as malId
                source: 'TMDB'
            };

        } else if (!isToku) {
            // Fallback ke AniList API (DILARANG UNTUK TOKU)
            const anilistData = await searchAniList(cleanTitle);
            if (anilistData) {
                anilistData.source = 'AniList';
                resultData = anilistData;
            }
        }

    } catch (err) {
        console.error(`[TMDB API] Error searching "${cleanTitle}":`, err.message);
        // Fallback jika network TMDB error
        if (!isToku) {
            const anilistData = await searchAniList(cleanTitle);
            if (anilistData) {
                anilistData.source = 'AniList';
                resultData = anilistData;
            }
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
