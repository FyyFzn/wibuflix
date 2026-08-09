import { getEpisodeServiceData, sanitizeContaminatedEpisodeCards } from './episodeService.js';
import Anime from '../models/Anime.js';
import { cleanSeriesTitle, formatEpisodeTitle, extractEpNum } from '../utils/stringUtils.js';

// ============================================================================
// IN-MEMORY LRU CACHE (TTL: 1 Jam = 3600000 ms)
// Mengurangi query berulang ke MongoDB dan membatasi beban scraping eksternal
// ============================================================================
class LRUMemoryCache {
    constructor(max = 1500, ttl = 3600000) {
        this.max = max;
        this.ttl = ttl;
        this.cache = new Map();

        this.cleanupInterval = setInterval(() => {
            const now = Date.now();
            for (const [key, item] of this.cache.entries()) {
                if (now - item.timestamp > this.ttl) {
                    this.cache.delete(key);
                }
            }
        }, Math.min(ttl, 300000));
        if (this.cleanupInterval.unref) this.cleanupInterval.unref();
    }

    get(key) {
        const item = this.cache.get(key);
        if (!item) return undefined;
        if (Date.now() - item.timestamp > this.ttl) {
            this.cache.delete(key);
            return undefined;
        }
        this.cache.delete(key);
        this.cache.set(key, item);
        return item.data;
    }

    set(key, data) {
        if (this.cache.has(key)) {
            this.cache.delete(key);
        } else if (this.cache.size >= this.max) {
            const oldestKey = this.cache.keys().next().value;
            if (oldestKey !== undefined) this.cache.delete(oldestKey);
        }
        this.cache.set(key, { timestamp: Date.now(), data });
    }

    invalidate(key) {
        this.cache.delete(key);
    }

    clear() {
        this.cache.clear();
    }
}

export const orchestratorCache = new LRUMemoryCache(1500, 3600000);

/**
 * Service utama untuk arsitektur Thin Client (Server-Driven).
 * Menerima slug/ID atau URL tunggal, mencari di DB, menggabungkan semua provider secara paralel,
 * dan mengembalikan struktur data bersih siap render.
 */
export async function getUnifiedAnimeEpisodes({ targetUrl, slug, id, forceRefresh = false, providerUrls = {} }) {
    let queryUrl = targetUrl;
    if (typeof queryUrl === 'string' && queryUrl.includes('___neosatsu_ep___')) {
        queryUrl = queryUrl.split('___neosatsu_ep___')[0];
    }

    // 1. Jika diberikan slug atau id, cari dokumen di MongoDB untuk mendapatkan URL utama
    let dbAnime = null;
    if (!queryUrl && (slug || id)) {
        if (id && id.match(/^[0-9a-fA-F]{24}$/)) {
            dbAnime = await Anime.findById(id);
        } else if (slug) {
            // Cek apakah slug adalah angka murni (MAL ID dari uniqueId mal-XXXXX)
            const isNumericMalId = /^\d+$/.test(slug.trim());
            const queryConditions = [
                { slug: slug },
                { url: { $regex: slug, $options: 'i' } },
                { sourceUrls: { $regex: slug, $options: 'i' } }
            ];
            if (isNumericMalId) {
                queryConditions.unshift({ malId: parseInt(slug, 10) });
            }
            dbAnime = await Anime.findOne({ $or: queryConditions });
        }

        if (dbAnime) {
            queryUrl = dbAnime.url || (dbAnime.sourceUrls && dbAnime.sourceUrls.length > 0 ? dbAnime.sourceUrls[0] : null);
        }
    }

    if (!queryUrl && Object.keys(providerUrls).length === 0) {
        throw new Error("Anime tidak ditemukan atau parameter pencarian (url/slug/id/urls) tidak valid.");
    }

    // Jika queryUrl kosong tapi ada providerUrls, pakai providerUrls pertama sebagai key cache dan fallback url
    const firstUrl = Object.values(providerUrls)[0];
    if (!queryUrl && firstUrl) {
        queryUrl = firstUrl;
    }

    const cacheKey = `v2_episodes_${queryUrl}`;

    // 2. Cek In-Memory Cache (jika tidak dipaksa refresh)
    if (!forceRefresh) {
        const cachedData = orchestratorCache.get(cacheKey);
        if (cachedData && cachedData.episodes && cachedData.episodes.length > 0) {
            const expectedCount = dbAnime ? (dbAnime.episodesCount || 0) : 0;
            if (expectedCount <= cachedData.total_episodes) {
                console.log(`[Orchestrator] Menggunakan LRU Cache untuk: ${queryUrl}`);
                return cachedData;
            } else {
                console.log(`[Orchestrator] LRU Cache bypass (DB: ${expectedCount} vs Cache: ${cachedData.total_episodes}) untuk: ${queryUrl}`);
            }
        }
    }

    // 3. Panggil pipeline penggabungan multi-sumber dari episodeService
    // Backend secara otomatis membaca dbAnime.sources dan mengikis Samehadaku, Otakudesu, Kuronime, Nanime ID!
    console.log(`[Orchestrator] Memproses dan menggabungkan episode multi-sumber untuk: ${queryUrl}`);
    const rawResult = await getEpisodeServiceData({ targetUrl: queryUrl, providerUrls, forceRefresh });

    if (!rawResult || rawResult.status === 'error') {
        throw new Error(rawResult?.message || "Gagal mengambil daftar episode dari sumber.");
    }

    const rawData = rawResult.data || {};
    const daftarEpisode = rawData.daftar_episode || [];
    const sanitizedDaftarEpisode = sanitizeContaminatedEpisodeCards(daftarEpisode);

    // 4. Transformasi ke format Unified Thin Client
    const unifiedEpisodes = sanitizedDaftarEpisode.map((ep, idx) => {
        const titleLower = (ep.judul || '').toLowerCase().trim();
        const isOvaTitle = /\b(?:ova|oad|special|sp|ex|bonus|nced|ncop)[\s-_]*\d+/i.test(titleLower) ||
            /\b(?:ova|oad|batch|nced|ncop|movie|film)\b/i.test(titleLower) ||
            /\((?:ova|oad|special|sp|ex|bonus|nced|ncop)\)|\b(?:ova|oad|special|sp|ex|bonus|nced|ncop)\b\s*$/i.test(titleLower);
        const epNum = isOvaTitle ? null : (ep.num != null ? ep.num : extractEpNum(ep.judul));
        const epId = epNum != null ? `ep_${epNum}` : `idx_${idx}`;

        let urlsObj = ep.urls || {};
        if (urlsObj instanceof Map || typeof urlsObj.entries === 'function') {
            urlsObj = Object.fromEntries(urlsObj);
        }

        // Kumpulkan daftar URL sumber secara murni (Zero-Compromise Anonymous Array)
        const urlList = Array.isArray(urlsObj) ? urlsObj : Object.values(urlsObj);
        const availableSources = Array.from(new Set(urlList)).filter(Boolean);

        // Pilih URL representatif
        const representativeUrl = urlList[0] || ep.url || '';

        return {
            id: epId,
            num: epNum,
            title: formatEpisodeTitle(ep.judul),
            url: representativeUrl,
            urls: urlsObj,
            available_sources: availableSources
        };
    });

    const finalPayload = {
        series_title: cleanSeriesTitle(rawData.judul_seri || 'Unknown Series'),
        judul_seri: cleanSeriesTitle(rawData.judul_seri || 'Unknown Series'),
        cover: rawData.mal?.cover || rawData.cover_scraper || '',
        cover_scraper: rawData.cover_scraper || '',
        mal_info: rawData.mal || null,
        mal: rawData.mal || null,
        total_episodes: unifiedEpisodes.length,
        episodes: unifiedEpisodes,
        daftar_episode: unifiedEpisodes.map(ep => ({
            ...ep,
            judul: ep.title
        })),
        source_type: rawResult.source || 'orchestrator'
    };

    // 5. Simpan ke LRU Cache (hanya jika data valid & tidak kosong)
    if (unifiedEpisodes.length > 0) {
        orchestratorCache.set(cacheKey, finalPayload);
    }

    return finalPayload;
}
