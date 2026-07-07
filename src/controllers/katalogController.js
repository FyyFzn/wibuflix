import Anime from '../models/Anime.js';
import { getCache } from '../utils/cacheManager.js';
import { KatalogResponseDTO } from '../dtos/KatalogResponseDTO.js';

const cache = getCache('katalog', 3600);

export async function getKatalog(pageParams, searchParam, typeFilter = '', tabParam = 'all', genreFilter = '', sortParam = 'az') {
    const isSearch = searchParam.trim() !== '';
    const cacheKey = `katalog_${pageParams}_${searchParam}_${typeFilter}_${tabParam}_${genreFilter}_${sortParam}`;
    
    const cachedData = cache.get(cacheKey);
    if (cachedData) {
        console.log(`[Katalog Cache Hit] ${cacheKey}`);
        return cachedData;
    }

    // 1. Build Query MongoDB
    const query = {};
    
    // Jika isSearch, kita tidak menaruhnya di query reguler, melainkan di pipeline $search nanti
    
    if (typeFilter && typeFilter !== 'Semua') {
        const tokuFilters = ['kamen rider', 'super sentai', 'power rangers', 'ultraman', 'lainnya'];
        if (tabParam === 'toku' || tokuFilters.includes(typeFilter.toLowerCase())) {
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

    if (genreFilter && genreFilter !== 'Semua') {
        // Query database mengecek apakah array genres memiliki genreFilter ini
        query.genres = { $regex: new RegExp(`^${genreFilter}$`, 'i') };
    }

    // Filter berdasarkan tab (wajib dieksekusi setelah typeFilter)
    if (tabParam === 'anime') {
        // Sembunyikan semua yang merupakan Tokusatsu
        query.isToku = { $ne: true };
        if (!query.type) query.type = { $ne: 'Toku' };
    } else if (tabParam === 'toku') {
        // Wajib Tokusatsu (cek isToku, atau old tag 'Toku', atau punya sumber neosatsu)
        const tokuCondition = [
            { isToku: true },
            { type: 'Toku' },
            { 'sources.neosatsu.url': { $ne: null } }
        ];
        if (query.$or) {
            query.$and = [
                { $or: query.$or },
                { $or: tokuCondition }
            ];
            delete query.$or;
        } else {
            query.$or = tokuCondition;
        }
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
                {
                    $project: {
                        title: 1,
                        image: 1,
                        type: 1,
                        score: 1,
                        status: 1,
                        sources: 1
                    }
                },
                { $skip: skip },
                { $limit: limit + 1 }
            ];
            results = await Anime.aggregate(pipeline);
        } else {
            // Jika bukan pencarian, gunakan query reguler dan sorting
            let dbQuery = Anime.find(query).select('title image type score status sources');
            if (sortParam === 'latest') {
                // Urutkan berdasarkan yang paling baru diupdate (episode baru rilis)
                dbQuery = dbQuery.sort({ lastUpdated: -1, _id: -1 });
            } else {
                // Urutkan A-Z secara alfabetis dengan case-insensitive & numeric ordering (#/0-9 paling depan)
                dbQuery = dbQuery.sort({ title: 1 }).collation({ locale: 'en', strength: 2, numericOrdering: true });
            }

            // Ambil data + 1 untuk mengetahui apakah masih ada halaman selanjutnya
            results = await dbQuery.skip(skip).limit(limit + 1).lean(); 
        }

        const hasNext = results.length > limit;
        const paginated = results.slice(0, limit);

        // 3. Format Response menggunakan DTO
        const formatted = KatalogResponseDTO.fromList(paginated);

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
