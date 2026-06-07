const { ambilDariPool, kembalikanKePool } = require('../puppeteer/pool');
const cheerio = require('cheerio');
const axios = require('axios');
const { loadLocalDatabase } = require('../sync/anime_sync');
const { loadOtakuDatabase } = require('./otakudesu_sync');
const fs = require('fs');
const path = require('path');
const { searchAnime } = require('../api/jikan');
const { searchTokusatsu } = require('../api/tmdb');

const NodeCache = require('node-cache');
const cache = new NodeCache({ stdTTL: 3600 }); // Cache 1 jam
const jikanCache = new NodeCache({ stdTTL: 86400 }); // Jikan cache 24 jam

async function getKatalog(pageParams, searchParam, typeFilter = '') {
    const isSearch = searchParam.trim() !== '';
    const cacheKey = `katalog_${pageParams}_${searchParam}_${typeFilter}`;
    
    const cachedData = cache.get(cacheKey);
    if (cachedData) {
        console.log(`[Katalog Cache Hit] ${cacheKey}`);
        return cachedData;
    }

    const localDb = loadLocalDatabase();
    
    // Load Otakudesu DB
    const otakuDb = loadOtakuDatabase();

    // Fungsi utilitas untuk mendeteksi tipe dengan pintar (Smart Tagging)
    const fixAnimeType = (item) => {
        let actualType = item.tipe || 'TV';
        const titleUp = item.judul ? item.judul.toUpperCase() : (item.title ? item.title.toUpperCase() : '');
        
        // Coba perbaiki jika tipe masih default/tidak akurat
        if (actualType === 'TV' || actualType === 'OTAKUDESU' || actualType === 'UNKNOWN') {
            if (titleUp.includes('SPECIAL') || titleUp.includes(' SP')) actualType = 'SPECIAL';
            else if (titleUp.includes('OVA')) actualType = 'OVA';
            else if (titleUp.includes('ONA')) actualType = 'ONA';
            else if (titleUp.includes('MOVIE')) actualType = 'MOVIE';
            else if (actualType === 'OTAKUDESU') actualType = 'TV'; // Fallback
        }
        item.tipe = actualType;
        return item;
    };

    // ==========================================
    // LOGIKA PENCARIAN & BROWSE MENGGUNAKAN LOKAL DB
    // ==========================================
    if ((localDb && localDb.length > 0) || otakuDb.length > 0) {
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

            // 2. Pencarian di Database Lokal Samehadaku (UTAMA)
            let samehadakuResults = localDb.filter(item => item.judul.toLowerCase().includes(finalQuery));
            if (samehadakuResults.length === 0 && jikanHit && query !== finalQuery) {
                samehadakuResults = localDb.filter(item => item.judul.toLowerCase().includes(query));
            }
            
            let localResults = samehadakuResults.map(fixAnimeType);

            // 3. Fallback ke Database Lokal Otakudesu JIKA Samehadaku kosong
            if (localResults.length === 0) {
                let otakuResults = otakuDb.filter(item => item.title.toLowerCase().includes(finalQuery));
                if (otakuResults.length === 0 && jikanHit && query !== finalQuery) {
                    otakuResults = otakuDb.filter(item => item.title.toLowerCase().includes(query));
                }

                const otakuFormatted = await Promise.all(otakuResults.map(async item => {
                    // Smart Image Matching: Pinjam gambar dari Samehadaku DB jika judulnya mirip
                    let matchedImg = '';
                    if (localDb && localDb.length > 0) {
                        for (const s of localDb) {
                            const sTitle = s.judul.toLowerCase();
                            const oTitle = item.title.toLowerCase();
                            if (sTitle === oTitle || (oTitle.includes(sTitle) && sTitle.length > 5) || (sTitle.includes(oTitle) && oTitle.length > 5)) {
                                matchedImg = s.gambar;
                                break;
                            }
                        }
                    }

                    // Fallback ke Jikan API atau TMDB API
                    let finalSkor = '-';
                    if (!matchedImg) {
                        try {
                            const titleLow = item.title.toLowerCase();
                            const isToku = ['kamen rider', 'ultraman', 'super sentai', 'garo', 'boonboomger', 'gotchard', 'geats', 'revice'].some(kw => titleLow.includes(kw));
                            
                            if (isToku) {
                                const tmdbData = await searchTokusatsu(item.title);
                                if (tmdbData && tmdbData.image) {
                                    matchedImg = tmdbData.image;
                                    finalSkor = tmdbData.score || '-';
                                }
                            } else {
                                const jikanData = await searchAnime(item.title);
                                if (jikanData && jikanData.cover) {
                                    matchedImg = jikanData.cover;
                                    finalSkor = jikanData.score || '-';
                                }
                            }
                        } catch (e) {
                            console.warn(`[Katalog-API] Gagal mengambil cover untuk ${item.title}:`, e.message);
                        }
                    }

                    // Gunakan placeholder modern jika gambar tidak ditemukan
                    const finalImg = matchedImg || 'https://placehold.co/300x450/1a1a2e/ffffff?text=No+Image';

                    return fixAnimeType({
                        judul: item.title,
                        url: `/anime/${item.id}`,
                        gambar: finalImg,
                        gambarScraper: finalImg,
                        tipe: 'Otakudesu',
                        skor: finalSkor,
                        status: '-',
                        id: item.id
                    });
                }));
                localResults = otakuFormatted;
            }

            if (typeFilter) {
                localResults = localResults.filter(item => item.tipe.toLowerCase() === typeFilter.toLowerCase());
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
            let browseDb = localDb.map(fixAnimeType);
            
            if (typeFilter) {
                browseDb = browseDb.filter(item => item.tipe.toLowerCase() === typeFilter.toLowerCase());
            }

            const startIndex = (pageParams - 1) * 9;
            const endIndex = startIndex + 9;
            
            if (startIndex < browseDb.length) {
                const result = { 
                    list: browseDb.slice(startIndex, endIndex), 
                    hasNext: endIndex < browseDb.length 
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

module.exports = { getKatalog, cache, jikanCache };
