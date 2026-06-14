import axios from 'axios';
import NodeCache from 'node-cache';
import fs from 'fs';
import path from 'path';
import { getDataDir } from '../../utils/pathUtils.js';

// TMDB API Cache (24 hours)
const tmdbCache = new NodeCache({ stdTTL: 86400 });
const CACHE_FILE = path.join(getDataDir(), 'tmdb_cache.json');

// Muat cache dari disk jika ada
if (fs.existsSync(CACHE_FILE)) {
    try {
        const raw = fs.readFileSync(CACHE_FILE, 'utf-8');
        const data = JSON.parse(raw);
        for (const key of Object.keys(data)) {
            tmdbCache.set(key, data[key]);
        }
        console.log(`[TMDB] Berhasil memuat ${Object.keys(data).length} entri cache dari disk.`);
    } catch(e) {
        console.error('[TMDB] Gagal memuat cache dari disk:', e.message);
    }
}

export function saveTMDBCache() {
    try {
        const dir = path.dirname(CACHE_FILE);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        
        const keys = tmdbCache.keys();
        const dataToSave = {};
        for (const key of keys) {
            dataToSave[key] = tmdbCache.get(key);
        }
        fs.writeFileSync(CACHE_FILE, JSON.stringify(dataToSave, null, 2));
    } catch (e) {
        console.error('[TMDB] Gagal menyimpan cache ke disk:', e.message);
    }
}

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
    const cached = tmdbCache.get(cacheKey);
    if (cached !== undefined) return cached; // Returns null if previously not found

    // Beri jeda HANYA jika tidak ada di cache (mencegah rate limit TMDB)
    await new Promise(r => setTimeout(r, 50));

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

            const data = {
                title: item.name || item.title,
                image,
                score,
                synopsis,
                status: finalStatus,
                tipe: finalType,
                aliases: [...new Set(aliases.filter(Boolean))],
                source: 'TMDB'
            };

            tmdbCache.set(cacheKey, data);
            return data;
        } else if (!isToku) {
            // Fallback ke Jikan API (DILARANG UNTUK TOKU)
            const jikanData = await searchJikan(cleanTitle);
            if (jikanData) {
                jikanData.source = 'Jikan';
                tmdbCache.set(cacheKey, jikanData);
                return jikanData;
            }
        }

        // Simpan cache kosong agar tidak request terus-terusan
        tmdbCache.set(cacheKey, null);
        return null;

    } catch (err) {
        console.error(`[TMDB API] Error searching "${cleanTitle}":`, err.message);
        // Fallback jika network TMDB error
        if (!isToku) {
            const jikanData = await searchJikan(cleanTitle);
            if (jikanData) {
                jikanData.source = 'Jikan';
                tmdbCache.set(cacheKey, jikanData);
                return jikanData;
            }
        }
        return null;
    }
}

export const searchTokusatsu = (title) => searchTMDB(title, true);
