import axios from 'axios';
import * as cheerio from 'cheerio';
import { searchTokusatsu } from '../../metadata/tmdb.js';
import { filterByTokuType } from '../../../utils/neosatsuUtils.js';
import { cache, IGNORED_CATS, cleanTitle } from './neosatsuShared.js';
import { PROVIDER_URLS } from '../../../config/providerUrls.js';

/**
 * [TAHAP 1] Mengambil katalog dari Neosatsu. 
 * Kita akan mengelompokkan post yang memiliki judul seri yang sama.
 */
export async function getNeosatsuCatalog(page = 1, searchParam = '', typeFilter = '') {
    const maxResults = 100;
    const startIndex = (page - 1) * maxResults + 1;

    try {
        const cacheKey = 'neosatsu_static_catalog';
        let staticAnimeList = [];

        // 1. Pastikan Cache Statis Selalu Terisi
        const cachedData = cache.get(cacheKey);
        if (cachedData) {
            staticAnimeList = cachedData;
        } else {
            console.debug(`[Neosatsu Scraper] Fetching Static Catalogs for Cache...`);
            const neosatsuBase = PROVIDER_URLS.NEOSATSU.BASE_URL;
            const staticPages = [
                `${neosatsuBase}/p/kamen-rider-series.html`,
                `${neosatsuBase}/p/kamen-rider-movie.html`,
                `${neosatsuBase}/p/super-sentai-series.html`,
                `${neosatsuBase}/p/super-sentai-movie.html`,
                `${neosatsuBase}/p/ultraman-series.html`,
                `${neosatsuBase}/p/ultraman-movie.html`,
                `${neosatsuBase}/p/power-rangers-series.html`
            ];

            const uniqueCheck = new Set();

            for (const pUrl of staticPages) {
                try {
                    // Delay 2 detik agar tidak terkena 429 (Too Many Requests) dari Neosatsu
                    await new Promise(r => setTimeout(r, 2000));
                    
                    const { data } = await axios.get(pUrl, { headers: { 'User-Agent': 'Mozilla/5.0' }, timeout: 60000 });
                    const $ = cheerio.load(data);

                    let tipe = 'Series';
                    if (pUrl.includes('movie')) tipe = 'Movie';

                    $('a').each((i, el) => {
                        const href = $(el).attr('href');
                        let title = $(el).attr('title') || $(el).text().trim();
                        // Bersihkan judul dari embel-embel batch, eps, tamat, dsb
                        title = cleanTitle(title);
                        let img = $(el).find('img').attr('src') || 'https://i.imgur.com/KxJ4L6J.jpeg'; // Default Neosatsu logo if text link

                        if (href && title && href !== 'javascript:void(0)' && title.length > 5) {
                            if (href.includes('/p/')) return; // Abaikan link navigasi page statis
                            const tLower = title.toLowerCase();

                            // Deteksi Special / V-Cinema dari judul
                            let finalTipe = tipe;
                            if (tLower.includes('special') || tLower.includes(' sp')) finalTipe = 'Special';
                            else if (tLower.includes('v-cinema') || tLower.includes('returns')) finalTipe = 'V-Cinema';
                            // Super Sentai jarang menggunakan kata "Super Sentai" di judulnya, biasanya hanya "Sentai" atau "Ranger"
                            if (tLower.includes('kamen rider') || tLower.includes('sentai') || tLower.includes('ranger') || tLower.includes('ultraman') || tLower.includes('garo') || pUrl.includes('super-sentai')) {
                                let endpoint = href;
                                let status = 'Completed';

                                if (href.startsWith('/search/label/')) {
                                    const match = href.match(/\/search\/label\/([^?&]+)/);
                                    if (match) {
                                        const label = decodeURIComponent(match[1]);
                                        endpoint = `neosatsu-merge:${title}||${label}`;
                                    }
                                    status = 'Ongoing';
                                } else if (href.startsWith('/')) {
                                    endpoint = `${PROVIDER_URLS.NEOSATSU.BASE_URL}${href}`;
                                }

                                img = img.replace(/\/s\d+(-c)?\//, '/s1600/');

                                if (!uniqueCheck.has(tLower)) {
                                    uniqueCheck.add(tLower);
                                    staticAnimeList.push({
                                        title: title,
                                        endpoint: endpoint,
                                        thumb: img,
                                        tipe: finalTipe,
                                        skor: '-',
                                        status: status
                                    });
                                }
                            }
                        }
                    });
                } catch (e) {
                    console.error(`[Neosatsu Scraper] Failed to fetch static page ${pUrl}: ${e.message}`);
                }
            }

            // 1.5 Fetch dari JSON Feed untuk Label tertentu (Project RED, Toku Lain, Movie)
            const labelFeeds = [
                { label: 'Project RED', tipe: 'Series' },
                { label: 'Toku Lain', tipe: 'Series' },
                { label: 'Movie', tipe: 'Movie' }
            ];

            for (const feed of labelFeeds) {
                try {
                    console.debug(`[Neosatsu Scraper] Fetching JSON Feed for Label: ${feed.label}...`);
                    const fUrl = `${PROVIDER_URLS.NEOSATSU.BASE_URL}/feeds/posts/default/-/${encodeURIComponent(feed.label)}?alt=json&max-results=500`;
                    const { data } = await axios.get(fUrl, { headers: { 'User-Agent': 'Mozilla/5.0' }, timeout: 60000 });
                    
                    if (data && data.feed && data.feed.entry) {
                        data.feed.entry.forEach(entry => {
                            let title = entry.title.$t;
                            const linkObj = entry.link.find(l => l.rel === 'alternate');
                            let thumb = '';
                            if (entry.media$thumbnail) {
                                thumb = entry.media$thumbnail.url.replace(/\/s\d+-c\//, '/s1600/');
                            } else {
                                thumb = 'https://i.imgur.com/KxJ4L6J.jpeg';
                            }

                            if (title && linkObj) {
                                let baseTitle = cleanTitle(title);
                                
                                // Deteksi Special / V-Cinema dari judul jika feed tipe bukan Movie
                                let finalTipe = feed.tipe;
                                const tLower = baseTitle.toLowerCase();
                                if (finalTipe !== 'Movie') {
                                    if (tLower.includes('movie')) finalTipe = 'Movie';
                                    else if (tLower.includes('special') || tLower.includes(' sp')) finalTipe = 'Special';
                                    else if (tLower.includes('v-cinema') || tLower.includes('returns')) finalTipe = 'V-Cinema';
                                }

                                let endpoint = linkObj.href;
                                let status = 'Completed';
                                if (tLower.includes('episode') && !tLower.includes('end') && !tLower.includes('batch')) {
                                    status = 'Ongoing';
                                }

                                // Cek deduplikasi: jika judul sudah ada di halaman statis, diabaikan
                                if (!uniqueCheck.has(tLower)) {
                                    uniqueCheck.add(tLower);
                                    staticAnimeList.push({
                                        title: baseTitle,
                                        endpoint: endpoint,
                                        thumb: thumb,
                                        tipe: finalTipe,
                                        skor: '-',
                                        status: status
                                    });
                                }
                            }
                        });
                    }
                } catch (e) {
                    console.error(`[Neosatsu Scraper] Failed to fetch JSON feed for ${feed.label}: ${e.message}`);
                }
            }

            cache.set(cacheKey, staticAnimeList);
        }

        // 2. Logika Pencarian
        if (searchParam && searchParam.trim() !== '') {
            const query = searchParam.toLowerCase();

            // Pencarian Lokal (Lebih Cepat dan Bersih)
            let localResults = staticAnimeList.filter(item => item.title.toLowerCase().includes(query));
            localResults = filterByTokuType(localResults, typeFilter);

            if (localResults.length > 0) {
                console.info(`[Neosatsu Scraper] Local Search Hit: Ditemukan ${localResults.length} hasil untuk "${searchParam}"`);
                
                let pageResults = localResults.slice((page - 1) * 9, page * 9);
                pageResults = await Promise.all(pageResults.map(async (item) => {
                    try {
                        const timeoutTmdb = new Promise((_, rej) => setTimeout(() => rej(new Error('TMDB_TIMEOUT')), 5000));
                        const tmdbData = await Promise.race([searchTokusatsu(item.title), timeoutTmdb]);
                        if (tmdbData && tmdbData.image) {
                            item.thumb = tmdbData.image;
                            item.skor = tmdbData.score;
                        }
                    } catch (e) {}
                    return item;
                }));

                return { page: parseInt(page), max_results: 9, anime: pageResults };
            }

            // Jika tidak ada di lokal (misal cari Metal Hero), Fallback ke Pencarian Website (Blogger Feed)
            const feedUrl = `${PROVIDER_URLS.NEOSATSU.BASE_URL}/feeds/posts/default?q=${encodeURIComponent(searchParam)}&alt=json&max-results=${maxResults}&start-index=${startIndex}`;
            console.info(`[Neosatsu Scraper] Local Miss. Fallback API (Search): ${feedUrl}`);

            const { data } = await axios.get(feedUrl, {
                headers: { 'User-Agent': 'Mozilla/5.0' },
                timeout: 60000
            });

            const animeList = [];
            const uniqueAnimeMap = new Map();

            if (data && data.feed && data.feed.entry) {
                data.feed.entry.forEach(entry => {
                    let title = entry.title.$t;
                    const linkObj = entry.link.find(l => l.rel === 'alternate');
                    let thumb = '';
                    if (entry.media$thumbnail) {
                        thumb = entry.media$thumbnail.url.replace(/\/s\d+-c\//, '/s1600/');
                    }

                    if (title && linkObj) {
                        const titleLower = title.toLowerCase();
                        let tipe = 'Series';
                        let status = 'Completed';

                        const cats = entry.category ? entry.category.map(c => c.term.toLowerCase()) : [];
                        const catsStr = cats.join(' ');

                        if (titleLower.includes('movie') || catsStr.includes('movie')) tipe = 'Movie';
                        else if (titleLower.includes('special') || titleLower.includes('spin-off') || titleLower.includes('hyper battle') || catsStr.includes('spin-off') || catsStr.includes('dvd')) tipe = 'Spesial';

                        if (tipe === 'Series') {
                            if (titleLower.includes('episode') && !titleLower.includes('end') && !titleLower.includes('batch')) {
                                status = 'Ongoing';
                            }
                        }

                        let baseTitle = cleanTitle(title);

                        let seriesLabel = '';
                        if (entry.category) {
                            for (let c of entry.category) {
                                if (!IGNORED_CATS.includes(c.term.toLowerCase())) {
                                    seriesLabel = c.term;
                                    break;
                                }
                            }
                        }

                        const key = baseTitle.toLowerCase();
                        if (!uniqueAnimeMap.has(key)) {
                            let endpointUrl = linkObj.href;
                            if (seriesLabel) {
                                endpointUrl = `neosatsu-merge:${baseTitle}||${seriesLabel}`;
                            } else {
                                endpointUrl = `neosatsu-merge:${baseTitle}`;
                            }

                            uniqueAnimeMap.set(key, {
                                title: baseTitle,
                                thumb: thumb,
                                endpoint: endpointUrl,
                                tipe: tipe,
                                status: status
                            });
                        }
                    }
                });

                uniqueAnimeMap.forEach(anime => animeList.push(anime));
            }

            let finalAnimeList = filterByTokuType(animeList, typeFilter);

            let pageResults = finalAnimeList.slice(0, 9);
            pageResults = await Promise.all(pageResults.map(async (item) => {
                try {
                    const timeoutTmdb = new Promise((_, rej) => setTimeout(() => rej(new Error('TMDB_TIMEOUT')), 5000));
                    const tmdbData = await Promise.race([searchTokusatsu(item.title), timeoutTmdb]);
                    if (tmdbData && tmdbData.image) {
                        item.thumb = tmdbData.image;
                        item.skor = tmdbData.score;
                    }
                } catch (e) {}
                return item;
            }));

            return { page: parseInt(page), max_results: 9, anime: pageResults };

        } else {
            // 3. Mode Browse Biasa
            let browseDb = filterByTokuType(staticAnimeList, typeFilter);
            
            let pageResults = browseDb.slice((page - 1) * 9, page * 9);
            pageResults = await Promise.all(pageResults.map(async (item) => {
                try {
                    const timeoutTmdb = new Promise((_, rej) => setTimeout(() => rej(new Error('TMDB_TIMEOUT')), 5000));
                    const tmdbData = await Promise.race([searchTokusatsu(item.title), timeoutTmdb]);
                    if (tmdbData && tmdbData.image) {
                        item.thumb = tmdbData.image;
                        item.skor = tmdbData.score;
                    }
                } catch (e) {}
                return item;
            }));

            return { page: parseInt(page), max_results: 9, anime: pageResults };
        }

    } catch (err) {
        console.error('[Neosatsu Catalog Error]:', err.message);
        throw err;
    }
}
