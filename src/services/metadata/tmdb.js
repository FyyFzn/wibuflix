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
 * Fallback pencarian ke Jikan API (MyAnimeList)
 */
async function searchJikan(cleanTitle) {
    // Beri jeda 1 detik khusus untuk Jikan agar tidak terkena limit (maks 3 req/detik)
    await new Promise(r => setTimeout(r, 1000));
    try {
        const url = `https://api.jikan.moe/v4/anime?q=${encodeURIComponent(cleanTitle)}&limit=1`;
        const response = await axios.get(url, { timeout: 10000 });
        const results = response.data.data;
        if (results && results.length > 0) {
            const item = results[0];
            
            const aliases = [];
            const addAlias = (val) => { if (val && !isJapanese(val)) aliases.push(val); };
            
            addAlias(item.title);
            addAlias(item.title_english);
            addAlias(item.title_japanese); // Will be skipped by isJapanese
            if (item.title_synonyms && Array.isArray(item.title_synonyms)) {
                item.title_synonyms.forEach(addAlias);
            }

            return {
                title: item.title_english || item.title, // Prioritaskan judul bahasa Inggris untuk konsistensi
                image: item.images?.jpg?.large_image_url || item.images?.jpg?.image_url || null,
                score: item.score ? item.score.toString() : '-',
                synopsis: item.synopsis || 'Sinopsis tidak tersedia di Jikan.',
                status: item.status === 'Finished Airing' ? 'Completed' : (item.status === 'Currently Airing' ? 'Ongoing' : 'Unknown'),
                type: item.type || 'Anime',
                aliases: [...new Set(aliases.filter(Boolean))]
            };
        }
        return null;
    } catch (e) {
        console.error('[Jikan] Gagal mencari:', cleanTitle, e.message);
        return null;
    }
}

/**
 * Mencari data Anime dan Tokusatsu di TMDB berdasarkan judul.
 * Mencari di kategori TV Shows, lalu mencari alternatif di Movies.
 */
export async function searchTMDB(title, isToku = false) {
    if (!title) return null;
    
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
            // Ambil hasil pertama yang paling relevan
            const item = results[0];
            
            const aliases = [];
            const addAlias = (val) => { if (val && !isJapanese(val)) aliases.push(val); };
            
            addAlias(item.name);
            addAlias(item.original_name);
            addAlias(item.title);
            addAlias(item.original_title);
            
            // Format skor: TMDB scale is 0-10, Jikan is 0-10
            const score = item.vote_average ? item.vote_average.toFixed(2) : '-';
            
            // Thumbnail poster
            let image = null;
            if (item.poster_path) {
                image = `https://image.tmdb.org/t/p/w500${item.poster_path}`;
            } else if (!isToku) {
                // Fallback to Jikan just for the image if TMDB lacks a poster (DILARANG UNTUK TOKU)
                try {
                    const jikanFallback = await searchJikan(cleanTitle);
                    if (jikanFallback && jikanFallback.image) {
                        image = jikanFallback.image;
                    }
                    if (jikanFallback && jikanFallback.aliases) {
                        aliases.push(...jikanFallback.aliases);
                    }
                } catch(e) {}
            }

            // Overview/Synopsis
            const synopsis = item.overview || 'Sinopsis tidak tersedia di TMDB.';
            
            let finalStatus = 'Unknown';
            let finalType = url.includes('/search/tv') ? 'TV' : 'Movie';

            try {
                if (finalType === 'TV') {
                    const detailRes = await axios.get(`${BASE_URL}/tv/${item.id}?api_key=${TMDB_API_KEY}`);
                    if (detailRes.data.status === 'Ended' || detailRes.data.status === 'Canceled') {
                        finalStatus = 'Completed';
                    } else if (detailRes.data.status === 'Returning Series') {
                        finalStatus = 'Ongoing';
                    }
                } else {
                    finalStatus = 'Completed';
                }
            } catch(e) {
                // Ignore detail errors
            }

            resultData = {
                title: item.name || item.title,
                image,
                score,
                synopsis,
                status: finalStatus,
                tipe: finalType,
                aliases: [...new Set(aliases.filter(Boolean))],
                source: 'TMDB'
            };

        } else if (!isToku) {
            // Fallback ke Jikan API (DILARANG UNTUK TOKU)
            const jikanData = await searchJikan(cleanTitle);
            if (jikanData) {
                jikanData.source = 'Jikan';
                resultData = jikanData;
            }
        }

    } catch (err) {
        console.error(`[TMDB API] Error searching "${cleanTitle}":`, err.message);
        // Fallback jika network TMDB error
        if (!isToku) {
            const jikanData = await searchJikan(cleanTitle);
            if (jikanData) {
                jikanData.source = 'Jikan';
                resultData = jikanData;
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
