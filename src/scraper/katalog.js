const { ambilDariPool, kembalikanKePool } = require('../puppeteer/pool');
const cheerio = require('cheerio');
const axios = require('axios');
const { loadLocalDatabase } = require('../sync/anime_sync');
const { loadOtakuDatabase } = require('./otakudesu_sync');
const { loadUnifiedDatabase } = require('../sync/unified_sync');
const fs = require('fs');
const path = require('path');
const NodeCache = require('node-cache');
const cache = new NodeCache({ stdTTL: 3600 }); // Cache 1 jam

async function getKatalog(pageParams, searchParam, typeFilter = '') {
    const isSearch = searchParam.trim() !== '';
    const cacheKey = `katalog_${pageParams}_${searchParam}_${typeFilter}`;
    
    const cachedData = cache.get(cacheKey);
    if (cachedData) {
        console.log(`[Katalog Cache Hit] ${cacheKey}`);
        return cachedData;
    }

    const unifiedDb = loadUnifiedDatabase();

    // ==========================================
    // LOGIKA PENCARIAN & BROWSE MENGGUNAKAN UNIFIED DB
    // ==========================================
    if (unifiedDb && unifiedDb.length > 0) {
        let results = unifiedDb;

        // 1. Pencarian
        if (isSearch) {
            const query = searchParam.toLowerCase().trim();
            results = results.filter(item => item.title.toLowerCase().includes(query));
        }

        // 2. Filter Tipe
        if (typeFilter) {
            results = results.filter(item => item.type.toLowerCase() === typeFilter.toLowerCase());
        }

        // 3. Sortir A-Z (Hanya untuk mode Browse, tidak untuk Search agar relevansi terjaga)
        if (!isSearch) {
            results.sort((a, b) => a.title.localeCompare(b.title));
        }

        // 4. Paginasi
        const startIndex = (pageParams - 1) * 9;
        const endIndex = startIndex + 9;

        if (startIndex < results.length) {
            let paginated = results.slice(startIndex, endIndex);

            // Format ke skema frontend
            const formatted = paginated.map(item => {
                let finalUrl = '';
                let finalId = '';
                
                // Prioritaskan source Samehadaku jika ada
                if (item.sources.samehadaku) {
                    finalUrl = item.sources.samehadaku.url;
                    finalId = item.sources.samehadaku.id;
                } else if (item.sources.otakudesu) {
                    finalUrl = `/anime/${item.sources.otakudesu.id}`;
                    finalId = item.sources.otakudesu.id;
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
                    sources: item.sources // Opsional, dikirim agar frontend bisa multi-server
                };
            });

            const resultObj = { 
                list: formatted, 
                hasNext: endIndex < results.length 
            };
            cache.set(cacheKey, resultObj);
            return resultObj;
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

        const isCloudflare = html.includes('Just a moment') || html.includes('cloudflare') || html.includes('cf-browser-verification') || html.includes('Ray ID:');
        if (!html || html.trim() === '' || isCloudflare) {
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

                    let actualType = typeNode.length ? typeNode.text().trim().toUpperCase() : 'TV';
                    const titleUp = titleNode.text().trim().toUpperCase();
                    if (actualType === 'TV' || actualType === 'UNKNOWN') {
                        if (titleUp.includes('SPECIAL') || titleUp.includes(' SP')) actualType = 'SPECIAL';
                        else if (titleUp.includes('OVA')) actualType = 'OVA';
                        else if (titleUp.includes('ONA')) actualType = 'ONA';
                        else if (titleUp.includes('MOVIE')) actualType = 'MOVIE';
                    }

                    list.push({
                        judul: titleNode.text().trim(),
                        url: linkNode.attr('href'),
                        gambar: gambarScraper,
                        gambarScraper,
                        tipe: actualType,
                        skor: skorAngka || '-',
                        status: epText || (statusNode.length ? statusNode.text().trim() : 'Ongoing'),
                    });
                }
            });
        } else {
            $('.pagination a, .pagination-id a').each((_, el) => {
                const txt = $(el).text();
                const hasNextIcon = $(el).find('#nextpagination, .fa-caret-right').length > 0;
                if (txt.includes('Next') || $(el).hasClass('next') || $(el).hasClass('arrow_pag') || hasNextIcon) {
                    hasNext = true;
                }
            });
        }

        if (list.length > 0 && !hasNext) {
            hasNext = true; 
        }

        let finalFilteredList = list;
        if (typeFilter) {
            finalFilteredList = list.filter(item => item.tipe.toLowerCase() === typeFilter.toLowerCase());
        }

        const result = { list: finalFilteredList.slice(0, 9), hasNext };

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

module.exports = { getKatalog, cache };
