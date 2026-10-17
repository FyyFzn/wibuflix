import axios from 'axios';
import * as cheerio from 'cheerio';
import { getCache } from '../utils/cacheManager.js';
import { cleanSeriesTitle } from '../utils/stringUtils.js';
import { PROVIDER_URLS } from '../config/providerUrls.js';

const cache = getCache('hot', 3600);

export async function getHotAnime() {
    const cacheKey = 'hot_anime_top10';
    
    const cachedData = cache.get(cacheKey);
    if (cachedData) {
        console.log(`[HotAnime Cache Hit]`);
        return cachedData;
    }

    const url = `${PROVIDER_URLS.SAMEHADAKU.BASE_URL}/`;

    console.log(`\n[HotAnime Fetch] ${url}`);

    try {
        const response = await axios.get(url, {
            headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36' },
            timeout: 8000
        });
        const html = response.data;
        const $ = cheerio.load(html);

        if (html === '404_NOT_FOUND') {
            return { list: [] };
        }

        const list = [];

        $('.widgetseries ul li a.series').each((_, el) => {
            const url = $(el).attr('href');
            const judul = cleanSeriesTitle($(el).find('.judul').text() || '');
            const gambar = $(el).find('img').attr('src') || $(el).find('img').attr('data-lazy-src') || '';
            const skorRaw = $(el).find('.rating').text().trim();
            const skor = skorRaw.replace(/[^\d.]/g, '') || '-';
            
            const isTopNode = $(el).find('.is-topten').text().trim();
            const tipe = isTopNode ? isTopNode.replace('TOP', 'TOP ') : 'HOT';

            if (judul && url) {
                list.push({
                    judul,
                    url,
                    gambar,
                    tipe,
                    skor,
                    status: 'Ongoing/Completed'
                });
            }
        });

        // Hapus duplikat karena Samehadaku sering punya widget ganda
        const uniqueList = Array.from(new Map(list.map(item => [item.url, item])).values());
        
        const result = { list: uniqueList };
        
        if (result.list.length > 0) {
            cache.set(cacheKey, result);
        }
        return result;

    } catch (err) {
        throw err;
    } finally {}
}
