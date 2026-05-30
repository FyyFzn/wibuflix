const { ambilDariPool, kembalikanKePool } = require('../puppeteer/pool');
const cheerio = require('cheerio');
const NodeCache = require('node-cache');
const cache = new NodeCache({ stdTTL: 3600 }); // Cache 1 jam

async function getHotAnime() {
    const cacheKey = 'hot_anime_top10';
    
    const cachedData = cache.get(cacheKey);
    if (cachedData) {
        console.log(`[HotAnime Cache Hit]`);
        return cachedData;
    }

    const url = 'https://v2.samehadaku.how/';
    console.log(`\n[HotAnime Fetch] ${url}`);

    let slot;
    try {
        slot = await ambilDariPool();
        const page = slot.page;

        // Fetch HTML of homepage
        const html = await page.evaluate(async (targetUrl) => {
            try {
                const res = await fetch(targetUrl);
                return await res.text();
            } catch(e) {
                return '';
            }
        }, url);

        if (!html) throw new Error("Gagal mengambil HTML dari target");

        const $ = cheerio.load(html);
        const list = [];

        $('.widgetseries ul li a.series').each((_, el) => {
            const url = $(el).attr('href');
            const judul = $(el).find('.judul').text().trim();
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
    } finally {
        if (slot) kembalikanKePool(slot);
    }
}

module.exports = {
    getHotAnime
};
