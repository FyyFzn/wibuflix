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
    
    // Jika isSearch, kita tidak menaruhnya di query reguler, melainkan di pipeline $search nanti
    
    if (typeFilter && typeFilter !== 'Semua') {
        if (tabParam === 'toku') {
            // Tokusatsu tidak punya kolom tipe spesifik (semuanya 'Toku'), jadi filternya dicari di Judul
            if (typeFilter.toLowerCase() === 'lainnya') {
                // Yang bukan kamen rider, super sentai, power rangers, ultraman
                query.title = { 
                    $not: /kamen rider|super sentai|power rangers|ultraman/i 
                };
            } else {
                if (!query.$or) query.$or = [];
                // Push regex untuk mencari di judul
                query.$or.push(
                    { title: { $regex: typeFilter, $options: 'i' } },
                    { aliases: { $regex: typeFilter, $options: 'i' } }
                );
            }
        } else {
            // Anime menggunakan tipe yang spesifik (TV, OVA, Movie, dll)
            query.type = { $regex: new RegExp(`^${typeFilter}$`, 'i') };
        }
    }

    // Filter berdasarkan tab (wajib dieksekusi setelah typeFilter)
    if (tabParam === 'anime') {
        // Sembunyikan semua yang tipenya Toku
        if (!query.type) query.type = { $ne: 'Toku' };
    } else if (tabParam === 'toku') {
        // Wajib tipenya Toku
        query.type = 'Toku';
    }

    const limit = 9;
    const skip = (pageParams - 1) * limit;

    try {
        let results = [];
        if (isSearch) {
            // Gunakan MongoDB Atlas Search untuk performa dan fuzzy matching yang jauh lebih pintar
            const pipeline = [
                {
                    $search: {
                        index: 'default', // Pastikan index ini dibuat di Atlas UI
                        text: {
                            query: searchParam,
                            path: ['title', 'aliases'],
                            fuzzy: {
                                maxEdits: 2,
                                prefixLength: 2
                            }
                        }
                    }
                },
                { $match: query },
                { $skip: skip },
                { $limit: limit + 1 }
            ];
            results = await Anime.aggregate(pipeline);
        } else {
            // Jika bukan pencarian, gunakan query reguler dan sorting
            let dbQuery = Anime.find(query);
             // Urutkan berdasarkan yang paling baru diupdate (episode baru rilis)
             dbQuery = dbQuery.sort({ lastUpdated: -1, _id: -1 });

            // Ambil data + 1 untuk mengetahui apakah masih ada halaman selanjutnya
            results = await dbQuery.skip(skip).limit(limit + 1).lean(); 
        }

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
            } else if (item.sources?.kuronime?.url) {
                finalUrl = item.sources.kuronime.url;
                finalId = item.sources.kuronime.id || '';
            }

            let displayType = item.type;
            if (item.type === 'Toku') {
                const lowerTitle = item.title.toLowerCase();
                if (lowerTitle.includes('kamen rider')) displayType = 'Kamen Rider';
                else if (lowerTitle.includes('ultraman')) displayType = 'Ultraman';
                else if (lowerTitle.includes('sentai')) displayType = 'Super Sentai';
                else if (lowerTitle.includes('power rangers')) displayType = 'Power Rangers';
                else if (lowerTitle.includes('garo')) displayType = 'Garo';
                else if (lowerTitle.includes('metal hero') || lowerTitle.includes('gavan')) displayType = 'Metal Hero';
            }

            return {
                judul: item.title,
                url: finalUrl,
                gambar: item.image,
                gambarScraper: item.image,
                tipe: displayType,
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
