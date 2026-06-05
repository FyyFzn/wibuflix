const { ambilDariPool, kembalikanKePool } = require('../puppeteer/pool');
const cheerio = require('cheerio');
const axios = require('axios');
const { loadLocalDatabase } = require('../sync/anime_sync');

const NodeCache = require('node-cache');
const cache = new NodeCache({ stdTTL: 3600 }); // Cache 1 jam
const jikanCache = new NodeCache({ stdTTL: 86400 }); // Jikan cache 24 jam

async function getKatalog(pageParams, searchParam) {
    const isSearch = searchParam.trim() !== '';
    const cacheKey = `katalog_${pageParams}_${searchParam}`;
    
    const cachedData = cache.get(cacheKey);
    if (cachedData) {
        console.log(`[Katalog Cache Hit] ${cacheKey}`);
        return cachedData;
    }

    const localDb = loadLocalDatabase();

    // ==========================================
    // LOGIKA PENCARIAN & BROWSE MENGGUNAKAN LOKAL DB
    // ==========================================
    if (localDb && localDb.length > 0) {
        if (isSearch) {
            const query = searchParam.toLowerCase().trim();
            let finalQuery = query;
            let jikanHit = false;
            
            // 1. Tanya Jikan API (Smart Alias)
            const jikanCacheKey = `jikan_${query}`;
            let jikanTitle = jikanCache.get(jikanCacheKey);
            
            if (!jikanTitle) {
                try {
                    console.log(`[Jikan API] Mencari alias untuk: "${query}"`);
                    const jikanRes = await axios.get(`https://api.jikan.moe/v4/anime?q=${encodeURIComponent(query)}&limit=1`, { timeout: 10000 });
                    if (jikanRes.data && jikanRes.data.data && jikanRes.data.data.length > 0) {
                        jikanTitle = jikanRes.data.data[0].title.toLowerCase();
                        jikanCache.set(jikanCacheKey, jikanTitle);
                        console.log(`[Jikan API] Ditemukan judul asli: "${jikanTitle}"`);
                    }
                } catch (e) {
                    console.error(`[Jikan API Error]`, e.message);
                }
            } else {
                console.log(`[Jikan Cache] Alias ditemukan: "${jikanTitle}"`);
            }
            
            if (jikanTitle) {
                finalQuery = jikanTitle;
                jikanHit = true;
            }

            // 2. Pencarian di Database Lokal
            let localResults = localDb.filter(item => item.judul.toLowerCase().includes(finalQuery));
            
            // Fallback: Jika Jikan title tidak ketemu di DB kita, coba query asli user
            if (localResults.length === 0 && jikanHit && query !== finalQuery) {
                localResults = localDb.filter(item => item.judul.toLowerCase().includes(query));
            }

            if (localResults.length > 0) {
                console.log(`[Katalog Local Search] Ditemukan ${localResults.length} hasil untuk "${finalQuery}"`);
                const startIndex = (pageParams - 1) * 9;
                const endIndex = startIndex + 9;
                const result = { 
                    list: localResults.slice(startIndex, endIndex), 
                    hasNext: endIndex < localResults.length 
                };
                cache.set(cacheKey, result);
                return result;
            } else {
                console.log(`[Katalog Local Search] Tidak ada hasil untuk "${finalQuery}". Fallback ke Live Scrape...`);
            }
        } else {
            // Mode Browse A-Z menggunakan Lokal DB (Lebih Cepat!)
            const startIndex = (pageParams - 1) * 9;
            const endIndex = startIndex + 9;
            
            if (startIndex < localDb.length) {
                const result = { 
                    list: localDb.slice(startIndex, endIndex), 
                    hasNext: endIndex < localDb.length 
                };
                cache.set(cacheKey, result);
                return result;
            }
        }
    }

    // ==========================================
    // FALLBACK LIVE SCRAPE (PUPPETEER)
    // ==========================================
    let url = 'https://v2.samehadaku.how/';
    if (isSearch) {
        url += `page/${pageParams}/?s=${encodeURIComponent(searchParam)}`;
    } else {
        url += `daftar-anime-2/`;
        if (pageParams > 1) url += `page/${pageParams}/`;
    }

    console.log(`\n[Katalog Live Fetch] ${url}`);

    let slot;
    try {
        slot = await ambilDariPool();
        const page = slot.page;

        let html = await page.evaluate(async (targetUrl) => {
            try {
                const controller = new AbortController();
                const timeoutId = setTimeout(() => controller.abort(), 6000);
                const res = await fetch(targetUrl, { signal: controller.signal });
                clearTimeout(timeoutId);
                return await res.text();
            } catch(e) {
                return '';
            }
        }, url);

        if (!html || html.trim() === '') {
            console.log(`[Katalog] Fetch gagal/terblokir Cloudflare. Fallback ke page.goto...`);
            await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
            html = await page.content();
        }

        if (!html) throw new Error("Gagal mengambil HTML dari target");

        const $ = cheerio.load(html);
        const list = [];
        let hasNext = false;
        
        const isDaftarAnime = url.includes('daftar-anime');

        if (isSearch || isDaftarAnime) {
            hasNext = !!$('.pagination .next').length;
            $('.animepost').each((_, el) => {
                const titleNode = $(el).find('.title, .tt h2, .entry-title').first();
                const linkNode = $(el).find('a').first();
                const imgNode = $(el).find('img').first();
                const typeNode = $(el).find('.content-thumb .type, .typez, .bt span.type').first();
                const scoreNode = $(el).find('.score, .numscore, .rating').first();
                const statusNode = $(el).find('.data .type, .status, .epx, .sb, .bt span:not(.type)').first();
                
                if (titleNode.length && linkNode.length && imgNode.length) {
                    const skorRaw = scoreNode.length ? scoreNode.text().trim() : '';
                    const skorAngka = skorRaw.replace(/[^\d.]/g, '');
                    
                    let epText = '';
                    if (!isSearch) {
                        const epNode = $(el).find('author[itemprop="name"]').first();
                        if (epNode.length) epText = 'Eps ' + epNode.text().trim();
                    }

                    const gambarScraper = 
                        imgNode.attr('data-src') || 
                        imgNode.attr('data-lazy-src') || 
                        imgNode.attr('data-original') || 
                        (imgNode.attr('srcset') ? imgNode.attr('srcset').split(' ')[0] : null) || 
                        imgNode.attr('src') || '';

                    list.push({
                        judul: titleNode.text().trim(),
                        url: linkNode.attr('href'),
                        gambar: gambarScraper,
                        gambarScraper,
                        tipe: typeNode.length ? typeNode.text().trim().toUpperCase() : 'TV',
                        skor: skorAngka || '-',
                        status: epText || (statusNode.length ? statusNode.text().trim() : 'Ongoing'),
                    });
                }
            });
        } else {
            $('.pagination a').each((_, el) => {
                const txt = $(el).text();
                if (txt.includes('Next') || $(el).hasClass('next')) hasNext = true;
            });
        }

        if (list.length > 0 && !hasNext) {
            hasNext = true; 
        }

        const result = { list: list.slice(0, 9), hasNext };

        if (result.list.length === 0) {
            result.hasNext = false;
        }

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

module.exports = { getKatalog, cache, jikanCache };
