import Anime from '../models/Anime.js';
import { getCache } from '../utils/cacheManager.js';

const cache = getCache('katalog', 3600);

export async function getKatalog(pageParams, searchParam, typeFilter = '', tabParam = 'all') {
    const isSearch = searchParam.trim() !== '';
    const cacheKey = `katalog_${pageParams}_${searchParam}_${typeFilter}_${tabParam}`;
    
    const cachedData = cache.get(cacheKey);
    if (cachedData) {
        console.log(`[Katalog Cache Hit] ${cacheKey}`);
        return cachedData;
    }

    // 1. Build Query MongoDB
    const query = {};
    
    if (isSearch) {
        // Menggunakan Regex untuk pencarian fuzzy sederhana
        query.$or = [
            { title: { $regex: searchParam, $options: 'i' } },
            { aliases: { $regex: searchParam, $options: 'i' } }
        ];
    }
    
    if (typeFilter) {
        query.type = { $regex: new RegExp(`^${typeFilter}$`, 'i') };
    }

    // Filter berdasarkan tab
    if (tabParam === 'anime') {
        // Jika sedang di tab Anime, sembunyikan semua yang tipenya Toku
        if (!query.type) query.type = { $ne: 'Toku' };
    } else if (tabParam === 'toku') {
        // Jika sedang di tab Toku, wajib tipenya Toku
        query.type = 'Toku';
    }

    const limit = 9;
    const skip = (pageParams - 1) * limit;

    try {
        let dbQuery = Anime.find(query);
        
        // 2. Sorting
        if (!isSearch) {
             // Urutkan berdasarkan yang paling baru diupdate (episode baru rilis)
             dbQuery = dbQuery.sort({ lastUpdated: -1, _id: -1 });
        }

        // Ambil data + 1 untuk mengetahui apakah masih ada halaman selanjutnya
        const results = await dbQuery.skip(skip).limit(limit + 1).lean(); 

        const hasNext = results.length > limit;
        const paginated = results.slice(0, limit);

        // 3. Format Response agar sama persis dengan yang diharapkan Frontend React Native
        const formatted = paginated.map(item => {
            let finalUrl = '';
            let finalId = '';
            
            if (item.sources?.samehadaku?.url) {
                finalUrl = item.sources.samehadaku.url;
                finalId = item.sources.samehadaku.id || '';
            } else if (item.sources?.otakudesu?.url) {
                finalUrl = `/anime/${item.sources.otakudesu.id || ''}`;
                finalId = item.sources.otakudesu.id || '';
            } else if (item.sources?.neosatsu?.url) {
                finalUrl = item.sources.neosatsu.url;
                finalId = ''; // Neosatsu menggunakan endpoint URL langsung
            }

            return {
                judul: item.title,
                url: finalUrl,
                gambar: item.image,
                gambarScraper: item.image,
                tipe: item.type,
                skor: item.score,
                status: item.status,
                id: finalId,
                sources: item.sources
            };
        });

        const resultObj = { list: formatted, hasNext };
        
        if (formatted.length > 0) {
            cache.set(cacheKey, resultObj);
        }
        
        return resultObj;
    } catch (e) {
        console.error("[Katalog DB] Error mengambil data dari MongoDB:", e.message);
        return { list: [], hasNext: false };
    }
}

export { cache };
