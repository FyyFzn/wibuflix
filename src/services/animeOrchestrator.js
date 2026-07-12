import { getEpisodeServiceData } from './episodeService.js';
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
export async function getUnifiedAnimeEpisodes({ targetUrl, slug, id, forceRefresh = false }) {
    let queryUrl = targetUrl;

    // 1. Jika diberikan slug atau id, cari dokumen di MongoDB untuk mendapatkan URL utama
    if (!queryUrl && (slug || id)) {
        let dbAnime = null;
        if (id && id.match(/^[0-9a-fA-F]{24}$/)) {
            dbAnime = await Anime.findById(id);
        } else if (slug) {
            // Cek apakah slug adalah angka murni (MAL ID dari uniqueId mal-XXXXX)
            const isNumericMalId = /^\d+$/.test(slug.trim());
            const queryConditions = [
                { slug: slug },
                { url: { $regex: slug, $options: 'i' } },
                { "sources.samehadaku.url": { $regex: slug, $options: 'i' } },
                { "sources.otakudesu.id": slug },
                { "sources.kuronime.url": { $regex: slug, $options: 'i' } },
                { "sources.nanime.url": { $regex: slug, $options: 'i' } },
                { "sources.nimegami.url": { $regex: slug, $options: 'i' } },
                { "sources.oploverz.url": { $regex: slug, $options: 'i' } }
            ];
            if (isNumericMalId) {
                queryConditions.unshift({ malId: parseInt(slug, 10) });
            }
            dbAnime = await Anime.findOne({ $or: queryConditions });
        }

        if (dbAnime) {
            queryUrl = dbAnime.url || 
                       dbAnime.sources?.samehadaku?.url || 
                       dbAnime.sources?.kuronime?.url || 
                       dbAnime.sources?.nanime?.url || 
                       dbAnime.sources?.nimegami?.url || 
                       dbAnime.sources?.oploverz?.url || 
                       (dbAnime.sources?.otakudesu?.id ? `/anime/${dbAnime.sources.otakudesu.id}` : null);
        }
    }

    if (!queryUrl) {
        throw new Error("Anime tidak ditemukan atau parameter pencarian (url/slug/id) tidak valid.");
    }

    const cacheKey = `v2_episodes_${queryUrl}`;

    // 2. Cek In-Memory Cache (jika tidak dipaksa refresh)
    if (!forceRefresh) {
        const cachedData = orchestratorCache.get(cacheKey);
        if (cachedData && cachedData.episodes && cachedData.episodes.length > 0) {
            console.log(`[Orchestrator] Menggunakan LRU Cache untuk: ${queryUrl}`);
            return cachedData;
        }
    }

    // 3. Panggil pipeline penggabungan multi-sumber dari episodeService
    // Backend secara otomatis membaca dbAnime.sources dan mengikis Samehadaku, Otakudesu, Kuronime, Nanime ID!
    console.log(`[Orchestrator] Memproses dan menggabungkan episode multi-sumber untuk: ${queryUrl}`);
    const rawResult = await getEpisodeServiceData({ targetUrl: queryUrl, forceRefresh });

    if (!rawResult || rawResult.status === 'error') {
        throw new Error(rawResult?.message || "Gagal mengambil daftar episode dari sumber.");
    }

    const rawData = rawResult.data || {};
    const daftarEpisode = rawData.daftar_episode || [];

    // 4. Transformasi ke format Unified Thin Client
    const unifiedEpisodes = daftarEpisode.map((ep, idx) => {
        const epNum = ep.num != null ? ep.num : extractEpNum(ep.judul);
        const epId = epNum != null ? `ep_${epNum}` : `idx_${idx}`;
        
        const urlsObj = (ep.urls && (ep.urls instanceof Map || typeof ep.urls.entries === 'function'))
            ? Object.fromEntries(ep.urls)
            : (ep.urls || {});

        // Kumpulkan daftar provider yang tersedia untuk episode ini
        const availableSources = [];
        if (urlsObj.samehadaku) availableSources.push('samehadaku');
        if (urlsObj.otakudesu) availableSources.push('otakudesu');
        if (urlsObj.kuronime) availableSources.push('kuronime');
        if (urlsObj.nanime) availableSources.push('nanime');
        if (urlsObj.neosatsu) availableSources.push('neosatsu');
        if (urlsObj.nimegami) availableSources.push('nimegami');
        if (urlsObj.oploverz) availableSources.push('oploverz');

        // Pilih URL representatif (prioritas: Samehadaku -> Otakudesu -> Nanime -> Neosatsu -> Nimegami -> Oploverz -> Kuronime)
        const representativeUrl = urlsObj.samehadaku ||
                                  urlsObj.otakudesu ||
                                  urlsObj.nanime ||
                                  urlsObj.neosatsu ||
                                  urlsObj.nimegami ||
                                  urlsObj.oploverz ||
                                  ep.url ||
                                  urlsObj.kuronime || '';

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
