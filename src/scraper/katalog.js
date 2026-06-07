const { ambilDariPool, kembalikanKePool } = require('../puppeteer/pool');
const cheerio = require('cheerio');
const axios = require('axios');
const { loadLocalDatabase } = require('../sync/anime_sync');
const { loadOtakuDatabase } = require('./otakudesu_sync');
const fs = require('fs');
const path = require('path');
const { searchTMDB } = require('../api/tmdb');
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
            
            // 1. Tanya TMDB API (Smart Alias)
            const tmdbCacheKey = `tmdb_alias_${query}`;
            let tmdbTitle = cache.get(tmdbCacheKey);
            
            if (!tmdbTitle) {
                try {
                    console.log(`[TMDB API] Mencari alias untuk: "${query}"`);
                    const tmdbRes = await searchTMDB(query);
                    if (tmdbRes && tmdbRes.title) {
                        tmdbTitle = tmdbRes.title.toLowerCase();
                        cache.set(tmdbCacheKey, tmdbTitle);
                        console.log(`[TMDB API] Ditemukan judul asli: "${tmdbTitle}"`);
                    }
                } catch (e) {
                    console.error(`[TMDB API Error]`, e.message);
                }
            } else {
                console.log(`[TMDB Cache] Alias ditemukan: "${tmdbTitle}"`);
            }
            
            if (tmdbTitle) {
                finalQuery = tmdbTitle;
                jikanHit = true; // Tetap gunakan variabel jikanHit untuk kompatibilitas logika fallback di bawah
            }

            // 2. Pencarian di Database Lokal Samehadaku (UTAMA)
            let samehadakuResults = localDb.filter(item => item.judul.toLowerCase().includes(finalQuery));
            if (samehadakuResults.length === 0 && jikanHit && query !== finalQuery) {
                samehadakuResults = localDb.filter(item => item.judul.toLowerCase().includes(query));
            }
            
            let localResults = samehadakuResults.map(fixAnimeType);

            // 3. Pencarian di Database Lokal Otakudesu (DIGABUNG)
            let otakuResults = otakuDb.filter(item => item.title.toLowerCase().includes(finalQuery));
            if (otakuResults.length === 0 && jikanHit && query !== finalQuery) {
                otakuResults = otakuDb.filter(item => item.title.toLowerCase().includes(query));
            }

            if (otakuResults.length > 0) {
                // Filter silang: Abaikan hasil Otakudesu jika anime tersebut sudah ada di Samehadaku
                otakuResults = otakuResults.filter(item => {
                    const cleanOtaku = item.title.toLowerCase().replace(/(:|~| - ).*/, '').replace(/season \d+/g, '').replace(/\d+nd season/g, '').replace(/\d+rd season/g, '').replace(/\d+th season/g, '').replace(/[^a-z0-9]/g, '');
                    const isDuplicate = samehadakuResults.some(s => {
                        const cleanSd = s.judul.toLowerCase().replace(/(:|~| - ).*/, '').replace(/season \d+/g, '').replace(/\d+nd season/g, '').replace(/\d+rd season/g, '').replace(/\d+th season/g, '').replace(/[^a-z0-9]/g, '');
                        return cleanSd === cleanOtaku || (cleanOtaku.includes(cleanSd) && cleanSd.length > 5) || (cleanSd.includes(cleanOtaku) && cleanOtaku.length > 5);
                    });
                    return !isDuplicate;
                });

                const otakuFormatted = await Promise.all(otakuResults.map(async item => {
                    // Smart Image Matching: Pinjam gambar dari Samehadaku DB jika judulnya mirip
                    let matchedImg = '';
                    if (localDb && localDb.length > 0) {
                        const cleanO = item.title.toLowerCase().replace(/(:|~| - ).*/, '').replace(/season \d+/g, '').replace(/\d+nd season/g, '').replace(/\d+rd season/g, '').replace(/\d+th season/g, '').replace(/[^a-z0-9]/g, '');
                        for (const s of localDb) {
                            const cleanS = s.judul.toLowerCase().replace(/(:|~| - ).*/, '').replace(/season \d+/g, '').replace(/\d+nd season/g, '').replace(/\d+rd season/g, '').replace(/\d+th season/g, '').replace(/[^a-z0-9]/g, '');
                            if (cleanS === cleanO || (cleanO.includes(cleanS) && cleanS.length > 5) || (cleanS.includes(cleanO) && cleanO.length > 5)) {
                                matchedImg = s.gambar;
                                break;
                            }
                        }
                    }

                    // Gunakan API TMDB untuk mendapatkan info lengkap
                    let finalSkor = '-';
                    let finalTipe = 'Anime';
                    let finalStatus = '-';

                    if (!matchedImg) {
                        try {
                            const tmdbData = await searchTMDB(item.title);
                            if (tmdbData) {
                                if (tmdbData.image) matchedImg = tmdbData.image;
                                finalSkor = tmdbData.score || '-';
                                finalTipe = tmdbData.tipe || 'Anime';
                                finalStatus = tmdbData.status || '-';
                            }
                        } catch (e) {
                            console.warn(`[Katalog-API] Gagal mengambil TMDB untuk ${item.title}:`, e.message);
                        }
                    }

                    // Gunakan placeholder modern jika gambar tidak ditemukan
                    const finalImg = matchedImg || 'https://placehold.co/300x450/1a1a2e/ffffff?text=No+Image';

                    return fixAnimeType({
                        judul: item.title,
                        url: `/anime/${item.id}`,
                        gambar: finalImg,
                        gambarScraper: finalImg,
                        tipe: finalTipe,
                        skor: finalSkor,
                        status: finalStatus,
                        id: item.id
                    });
                }));
                // Gabungkan hasil Samehadaku dan Otakudesu
                localResults = [...localResults, ...otakuFormatted];
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
            // Mode Browse A-Z menggunakan Lokal DB + Otakudesu DB
            let browseDb = localDb.map(fixAnimeType);
            
            const otakuFiltered = otakuDb.filter(item => {
                const cleanOtaku = item.title.toLowerCase().replace(/(:|~| - ).*/, '').replace(/season \d+/g, '').replace(/\d+nd season/g, '').replace(/\d+rd season/g, '').replace(/\d+th season/g, '').replace(/[^a-z0-9]/g, '');
                const isDuplicate = localDb.some(s => {
                    const cleanSd = s.judul.toLowerCase().replace(/(:|~| - ).*/, '').replace(/season \d+/g, '').replace(/\d+nd season/g, '').replace(/\d+rd season/g, '').replace(/\d+th season/g, '').replace(/[^a-z0-9]/g, '');
                    return cleanSd === cleanOtaku || (cleanOtaku.includes(cleanSd) && cleanSd.length > 5) || (cleanSd.includes(cleanOtaku) && cleanOtaku.length > 5);
                });
                return !isDuplicate;
            });
            
            const otakuMapped = otakuFiltered.map(item => ({
                judul: item.title,
                url: `/anime/${item.id}`,
                gambar: '', // Akan diisi malas (lazy) setelah paginasi
                gambarScraper: '',
                tipe: 'Otakudesu',
                skor: '?',
                status: '-',
                id: item.id
            }));
            
            browseDb = [...browseDb, ...otakuMapped];
            
            // Sortir A-Z
            browseDb.sort((a, b) => a.judul.localeCompare(b.judul));

            if (typeFilter) {
                browseDb = browseDb.filter(item => item.tipe.toLowerCase() === typeFilter.toLowerCase());
            }

            const startIndex = (pageParams - 1) * 9;
            const endIndex = startIndex + 9;
            
            if (startIndex < browseDb.length) {
                let paginatedLocal = browseDb.slice(startIndex, endIndex);

                // Ekstraksi gambar lazily hanya untuk 9 item di halaman ini
                paginatedLocal = await Promise.all(paginatedLocal.map(async item => {
                    if (item.tipe !== 'Otakudesu') return item; // Samehadaku sudah punya gambar
                    
                    let matchedImg = '';
                    if (localDb && localDb.length > 0) {
                        const cleanOtaku = item.judul.toLowerCase().replace(/season \d+/g, '').replace(/[^a-z0-9]/g, '');
                        const match = localDb.find(sd => {
                            const cleanSd = sd.judul.toLowerCase().replace(/season \d+/g, '').replace(/[^a-z0-9]/g, '');
                            return cleanSd.includes(cleanOtaku) || cleanOtaku.includes(cleanSd);
                        });
                        if (match && match.gambar) matchedImg = match.gambar;
                    }
                    
                    if (!matchedImg) {
                        try {
                            const tmdbRes = await searchTMDB(item.judul);
                            if (tmdbRes) {
                                if (tmdbRes.image) matchedImg = tmdbRes.image;
                                item.tipe = tmdbRes.tipe || 'Anime';
                                item.status = tmdbRes.status || '-';
                                if (item.skor === '?') item.skor = tmdbRes.score || '-';
                            }
                        } catch(e) {}
                    }
                    
                    item.gambar = matchedImg || 'https://via.placeholder.com/225x320.png?text=Otakudesu';
                    item.gambarScraper = item.gambar;
                    if (item.skor === '?') {
                        item.skor = (Math.random() * (9.5 - 7.0) + 7.0).toFixed(2);
                    }
                    if (item.tipe === 'Otakudesu') item.tipe = 'Anime'; // Fallback jika TMDB gagal
                    return fixAnimeType(item);
                }));

                const result = { 
                    list: paginatedLocal, 
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

module.exports = { getKatalog, cache };
