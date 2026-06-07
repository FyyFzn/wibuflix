const axios = require('axios');
const NodeCache = require('node-cache');

// TMDB API Cache (24 hours)
const tmdbCache = new NodeCache({ stdTTL: 86400 });

// Fallback key, users should ideally set TMDB_API_KEY in .env
const TMDB_API_KEY = process.env.TMDB_API_KEY || '13e71c6778f9fd4a2f67ff77238002df';
const BASE_URL = 'https://api.themoviedb.org/3';

/**
 * Normalisasi judul untuk mempermudah pencarian.
 */
function normalizeTitle(title) {
    if (!title) return '';
    let t = title.toLowerCase();
    // Hapus tag seperti [Batch], (BD), dll
    t = t.replace(/\[.*?\]|\(.*?\)/g, '');
    // Hapus embel-embel umum
    t = t.replace(/subtitle indonesia|sub indo/gi, '');
    // Hapus season
    t = t.replace(/season \d+|s\d+/gi, '');
    return t.trim();
}

/**
 * Mencari data Anime dan Tokusatsu di TMDB berdasarkan judul.
 * Mencari di kategori TV Shows, lalu mencari alternatif di Movies.
 */
async function searchTMDB(title) {
    if (!title) return null;
    
    const cleanTitle = normalizeTitle(title);
    if (!cleanTitle) return null;

    const cacheKey = `tmdb_${cleanTitle}`;
    const cached = tmdbCache.get(cacheKey);
    if (cached !== undefined) return cached; // Returns null if previously not found

    try {
        // Coba cari di TV Shows terlebih dahulu
        let url = `${BASE_URL}/search/tv?api_key=${TMDB_API_KEY}&query=${encodeURIComponent(cleanTitle)}&language=en-US&page=1`;
        let response = await axios.get(url, { timeout: 10000 });
        let results = response.data.results;

        // Jika tidak ketemu, coba di Movies
        if (!results || results.length === 0) {
            url = `${BASE_URL}/search/movie?api_key=${TMDB_API_KEY}&query=${encodeURIComponent(cleanTitle)}&language=en-US&page=1`;
            response = await axios.get(url, { timeout: 10000 });
            results = response.data.results;
        }

        if (results && results.length > 0) {
            // Ambil hasil pertama yang paling relevan
            const item = results[0];
            
            // Format skor: TMDB scale is 0-10, Jikan is 0-10
            const score = item.vote_average ? item.vote_average.toFixed(2) : '-';
            
            // Thumbnail poster
            let image = null;
            if (item.poster_path) {
                image = `https://image.tmdb.org/t/p/w500${item.poster_path}`;
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
                    const detailRes = await axios.get(`${BASE_URL}/movie/${item.id}?api_key=${TMDB_API_KEY}`);
                    if (detailRes.data.status === 'Released') {
                        finalStatus = 'Completed';
                    } else if (detailRes.data.status === 'In Production' || detailRes.data.status === 'Post Production') {
                        finalStatus = 'Ongoing';
                    }
                }
            } catch (detailErr) {
                console.warn(`[TMDB API] Gagal fetch detail untuk ${item.id}:`, detailErr.message);
            }
            
            const result = {
                title: item.name || item.title,
                score: score,
                image: image,
                synopsis: synopsis,
                status: finalStatus,
                tipe: finalType,
                source: 'TMDB'
            };

            tmdbCache.set(cacheKey, result);
            return result;
        }

        // Simpan cache kosong agar tidak request terus-terusan
        tmdbCache.set(cacheKey, null);
        return null;

    } catch (err) {
        console.error(`[TMDB API] Error searching "${cleanTitle}":`, err.message);
        return null;
    }
}

module.exports = { searchTMDB, normalizeTitle };
