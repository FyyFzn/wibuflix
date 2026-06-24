import axios from 'axios';
import * as cheerio from 'cheerio';
import { searchTokusatsu } from '../services/metadata/tmdb.js';
import { filterByTokuType, decryptNeosatsuLink, normalizeGDriveUrl } from '../utils/neosatsuUtils.js';
import { getCache } from '../utils/cacheManager.js';

export const cache = getCache('neosatsu', 3600); // 1 jam TTL
const IGNORED_CATS = ['episode', 'movie', 'batch', 'completed', 'ongoing', 'kamen rider', 'super sentai', 'ultraman', 'metal hero', 'tokusatsu', 'spesial', 'spin-off', 'hyper battle dvd', 'project red', 'dvd', 'tv series', 'series'];

function cleanTitle(title) {
    if (!title) return '';
    let t = title;
    // Hapus Subtitle Indonesia
    t = t.replace(/Subtitle Indonesia.*$/i, '');
    t = t.replace(/Sub Indo.*$/i, '');
    // Hapus Episode XX - XX Tamat / Eps XX - XX
    t = t.replace(/(?:Episode|Eps)\s*\d+\s*-\s*\d+.*$/i, '');
    t = t.replace(/(?:Episode|Eps)\s*\d+.*$/i, '');
    // Hapus 1 - 49 Tamat (tanpa kata Episode)
    t = t.replace(/\s*\d+\s*-\s*\d+\s*(?:Tamat|End)?.*$/i, '');
    // Hapus (Batch), [Batch], BD Batch, dll
    t = t.replace(/(?:\s*[\(\[]?BD[\)\]]?\s*)?(?:\s*[\(\[]?Batch[\)\]]?\s*)/gi, '');
    // Hapus (End), [End], Tamat
    t = t.replace(/\s*[\(\[]?(?:End|Tamat)[\)\]]?\s*/gi, '');
    // Hapus karakter non-alfanumerik di ujung
    return t.replace(/[-\s]+$/, '').trim();
}
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
            console.info(`[Neosatsu Scraper] Fetching Static Catalogs for Cache...`);
            const staticPages = [
                'https://www.neosatsu.com/p/kamen-rider-series.html',
                'https://www.neosatsu.com/p/kamen-rider-movie.html',
                'https://www.neosatsu.com/p/super-sentai-series.html',
                'https://www.neosatsu.com/p/super-sentai-movie.html',
                'https://www.neosatsu.com/p/ultraman-series.html',
                'https://www.neosatsu.com/p/ultraman-movie.html',
                'https://www.neosatsu.com/p/power-rangers-series.html'
            ];

            const uniqueCheck = new Set();

            for (const pUrl of staticPages) {
                try {
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
                                    endpoint = `https://www.neosatsu.com${href}`;
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
                    console.info(`[Neosatsu Scraper] Fetching JSON Feed for Label: ${feed.label}...`);
                    const fUrl = `https://www.neosatsu.com/feeds/posts/default/-/${encodeURIComponent(feed.label)}?alt=json&max-results=500`;
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
                        const tmdbData = await searchTokusatsu(item.title);
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
            const feedUrl = `https://www.neosatsu.com/feeds/posts/default?q=${encodeURIComponent(searchParam)}&alt=json&max-results=${maxResults}&start-index=${startIndex}`;
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
                    const tmdbData = await searchTokusatsu(item.title);
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
                    const tmdbData = await searchTokusatsu(item.title);
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

/**
 * [TAHAP 2 & 3] Mengambil daftar episode DAN server.
 * Mendukung ekstraksi dari Label Feed (menggabungkan semua episode & movie) ATAU URL satuan.
 */
export async function getNeosatsuEpisodes(targetUrl) {
    if (!targetUrl) throw new Error("Parameter 'url' wajib diisi!");
    console.info(`\n[Neosatsu Scraper] Mengambil post/label dari: ${targetUrl}`);

    try {
        let feedUrl = '';
        let judulSeri = 'Tokusatsu Series';
        let cover = '';
        let allEntries = [];

        // Jika endpoint berasal dari label (Auto-Merge Backend)
        if (targetUrl.startsWith('neosatsu-merge:')) {
            const dataStr = targetUrl.split('neosatsu-merge:')[1];
            let targetTitle = '';
            let label = '';

            if (dataStr.includes('||')) {
                const parts = dataStr.split('||');
                targetTitle = parts[0];
                label = parts[1];
            } else {
                targetTitle = dataStr;
            }

            judulSeri = cleanTitle(targetTitle);

            if (label) {
                feedUrl = `https://www.neosatsu.com/feeds/posts/default/-/${encodeURIComponent(label)}?alt=json&max-results=500`;
            } else {
                feedUrl = `https://www.neosatsu.com/feeds/posts/default?q=${encodeURIComponent(targetTitle)}&alt=json&max-results=500`;
            }

            console.info(`[Neosatsu Scraper] Fetching Label/Search Feed: ${feedUrl}`);

            const { data: feedData } = await axios.get(feedUrl, { headers: { 'User-Agent': 'Mozilla/5.0' }, timeout: 60000 });
            if (feedData && feedData.feed && feedData.feed.entry) {
                // FILTER HANYA YANG COCOK DENGAN TARGET TITLE! (Memisahkan Series dan Movie)
                allEntries = feedData.feed.entry.filter(entry => {
                    const entryTitle = entry.title.$t.replace(/Subtitle Indonesia.*$/i, '').replace(/Episode.*$/i, '').trim();
                    return entryTitle.toLowerCase() === targetTitle.toLowerCase();
                });

                // Ambil cover dari entri pertama
                if (allEntries[0] && allEntries[0].media$thumbnail) {
                    cover = allEntries[0].media$thumbnail.url.replace(/\/s\d+-c\//, '/s1600/');
                }
            }
        }
        // Fallback untuk URL lama yang sudah tersimpan di database/bookmark
        else {
            const { data: html } = await axios.get(targetUrl, { headers: { 'User-Agent': 'Mozilla/5.0' }, timeout: 60000 });
            const $ = cheerio.load(html);
            judulSeri = $('h1.entry-title').text().trim().replace(/Subtitle Indonesia.*$/i, '').trim() || 'Tokusatsu Series';
            cover = $('.thumbnail img').first().attr('src') || $('meta[property="og:image"]').attr('content') || '';
            if (cover) cover = cover.replace(/\/w\d+-h\d+(-[c|p|s])?(-[a-zA-Z0-9]+)?\//g, '/s1600/');

            // Coba cari label dari HTML untuk fallback merging
            let seriesLabel = '';
            $('a[rel="tag"]').each((i, el) => {
                const tag = $(el).text().trim();
                if (tag && !IGNORED_CATS.includes(tag.toLowerCase())) {
                    seriesLabel = tag;
                }
            });

            if (seriesLabel) {
                feedUrl = `https://www.neosatsu.com/feeds/posts/default/-/${encodeURIComponent(seriesLabel)}?alt=json&max-results=500`;
                console.info(`[Neosatsu Scraper] Fallback Merging via Label: ${feedUrl}`);
                const { data } = await axios.get(feedUrl, { headers: { 'User-Agent': 'Mozilla/5.0' }, timeout: 60000 });
                if (data && data.feed && data.feed.entry) {
                    allEntries = data.feed.entry;
                }
            } else {
                // Jika tidak ada label, buat dummy entry dari HTML ini saja
                allEntries = [{
                    title: { $t: judulSeri },
                    content: { $t: html }
                }];
            }
        }

        const daftar_episode = [];

        // Loop setiap post yang berhubungan dengan seri ini
        for (const entry of allEntries) {
            const postTitle = entry.title.$t;
            const content = entry.content ? entry.content.$t : '';
            if (!content) continue;

            let isMovieOrSpecial = false;
            if (postTitle.toLowerCase().includes('movie') || postTitle.toLowerCase().includes('spin-off') || postTitle.toLowerCase().includes('hyper battle') || postTitle.toLowerCase().includes('vs')) {
                isMovieOrSpecial = true;
            }

            const match = content.match(/var dlItem\s*=\s*(\[.*?\]);/s);
            if (match && match[1]) {
                let parsedData = [];
                try {
                    const parseFunc = new Function(`return ${match[1]};`);
                    parsedData = parseFunc();
                } catch (e) {
                    console.error("Gagal parse array JS Neosatsu:", e.message);
                }

                parsedData.forEach(ep => {
                    let epTitle = ep.name.trim(); // "Kamen Rider Zeztz Episode 37" atau sekedar "Link Download"
                    if (epTitle.toLowerCase().includes('batch')) return;

                    // Jika epTitle hanya "Link Download", kita harus pakai postTitle untuk menamainya
                    const lowerName = epTitle.toLowerCase();
                    if (lowerName.includes('link download') || lowerName.includes('download episode') || lowerName.includes('download batch') || lowerName === 'download') {
                        let extractedName = postTitle.replace(/Subtitle Indonesia.*$/i, '').trim();
                        const epMatch = extractedName.match(/Episode\s*\d+.*?$/i);
                        if (epMatch) {
                            epTitle = epMatch[0]; // misal "Episode 45"
                        } else {
                            // Coba hapus nama franchise agar lebih pendek
                            const franchiseStrip = extractedName.replace(new RegExp(`.*?${judulSeri}`, 'i'), '').replace(/^[:\-\s]+/, '');
                            epTitle = franchiseStrip || extractedName;
                        }
                    }

                    if (isMovieOrSpecial && !epTitle.toLowerCase().includes('movie') && !epTitle.toLowerCase().includes('special') && !epTitle.toLowerCase().includes('spin-off')) {
                        epTitle = `[Spesial/Movie] ${epTitle}`;
                    }

                    // CLEAN EPISODE TITLE
                    let cleanTitle = epTitle;
                    
                    const isBatchMatch = cleanTitle.match(/Episode\s*\d+\s*(?:[\-\~]|s\/d|sampai|to)\s*\d+/i);
                    if (isBatchMatch) {
                        cleanTitle = judulSeri || 'Full Series';
                    } else {
                        if (judulSeri && judulSeri.length > 2) {
                            const regexFranchise = new RegExp(judulSeri.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
                            cleanTitle = cleanTitle.replace(regexFranchise, '').trim();
                        }

                        cleanTitle = cleanTitle.replace(/\s*(-|~)?\s*(Tamat|End|Subtitle Indonesia|Sub Indo|Subtitle|Indonesia)\s*/gi, '').trim();

                        if (!isMovieOrSpecial) {
                            const epMatch = cleanTitle.match(/Episode\s*\d+/i);
                            if (epMatch) {
                                cleanTitle = epMatch[0]; 
                            } else {
                                const numMatch = cleanTitle.match(/^\s*\d+\s*$/);
                                if (numMatch) {
                                    cleanTitle = `Episode ${numMatch[0].trim()}`;
                                }
                            }
                        }

                        cleanTitle = cleanTitle.replace(/^[\-\:\s]+|[\-\:\s]+$/g, '');
                        if (!cleanTitle) cleanTitle = judulSeri || 'Full Series';
                    }

                    epTitle = cleanTitle;

                    // Logika Ekstrak Server
                    let hasNestedEpisodes = false;
                    if (ep.item && Array.isArray(ep.item)) {
                        ep.item.forEach(resGroup => {
                            const resolusi = resGroup.label;
                            if (resolusi.toLowerCase().includes('batch')) return;

                            if (resolusi.toLowerCase().includes('episode') || (!resolusi.toLowerCase().includes('p') && resolusi.match(/^[0-9\-\s]+$/))) {
                                hasNestedEpisodes = true;
                                const nestedServers = [];
                                if (resGroup.link && Array.isArray(resGroup.link)) {
                                    resGroup.link.forEach(serverObj => {
                                        const serverName = serverObj.name || '';
                                        const fullUrl = decryptNeosatsuLink(serverObj.ids);
                                        if (fullUrl) {
                                            const finalIframeUrl = normalizeGDriveUrl(fullUrl);
                                            nestedServers.push({
                                                nama: `HD ${serverName}`,
                                                namaHost: serverName.toLowerCase().includes('drive') ? 'gdrive' : serverName.toLowerCase(),
                                                urlAsli: fullUrl,
                                                iframeUrl: finalIframeUrl
                                            });
                                        }
                                    });
                                }

                                if (nestedServers.length > 0) {
                                    let nestedEpTitle = resolusi.trim();
                                    // Movie name separation
                                    if (judulSeri.toLowerCase().includes('movie') || judulSeri.toLowerCase().includes('spesial')) {
                                        // It's a separated movie card, no need to add [Movie] tag
                                    } else if (isMovieOrSpecial) {
                                        nestedEpTitle = `[Spesial/Movie] ${nestedEpTitle}`;
                                    }
                                    const fakeEpUrl = `${targetUrl}___neosatsu_ep___${nestedEpTitle.replace(/\s+/g, '_')}`;
                                    daftar_episode.push({
                                        judul: nestedEpTitle,
                                        url: fakeEpUrl,
                                        _servers: nestedServers
                                    });
                                }
                            }
                        });
                    }

                    if (!hasNestedEpisodes) {
                        const resolutions = [];
                        if (ep.item && Array.isArray(ep.item)) {
                            ep.item.forEach(resGroup => {
                                const resolusi = resGroup.label;
                                if (resolusi.toLowerCase().includes('batch')) return;

                                if (resGroup.link && Array.isArray(resGroup.link)) {
                                    resGroup.link.forEach(serverObj => {
                                        const serverName = serverObj.name || '';
                                        const fullUrl = decryptNeosatsuLink(serverObj.ids);
                                        if (fullUrl) {
                                            const finalIframeUrl = normalizeGDriveUrl(fullUrl);
                                            resolutions.push({
                                                nama: `${resolusi} ${serverName}`.trim(),
                                                namaHost: serverName.toLowerCase().includes('drive') ? 'gdrive' : serverName.toLowerCase(),
                                                urlAsli: fullUrl,
                                                iframeUrl: finalIframeUrl
                                            });
                                        }
                                    });
                                }
                            });
                        }

                        if (resolutions.length > 0) {
                            const fakeEpUrl = `${targetUrl}___neosatsu_ep___${epTitle.replace(/\s+/g, '_')}`;
                            daftar_episode.push({
                                    judul: epTitle,
                                    url: fakeEpUrl,
                                    _servers: resolutions
                            });
                        }
                    }
                });
            }
        }

        // Sorting Pintar
        if (daftar_episode.length > 1) {
            const getEpNum = (title) => {
                const match = title.match(/Episode\s*(\d+)/i) || title.match(/Ep\s*(\d+)/i);
                return match ? parseInt(match[1]) : -1;
            };

            // Deduplikasi
            const seenEpNums = new Set();
            const seenTitles = new Set();
            const uniqueEpisodes = [];

            for (let i = 0; i < daftar_episode.length; i++) {
                const ep = daftar_episode[i];
                const num = getEpNum(ep.judul);
                if (num !== -1) {
                    if (!seenEpNums.has(num)) {
                        seenEpNums.add(num);
                        uniqueEpisodes.push(ep);
                    }
                } else {
                    const lowerTitle = ep.judul.toLowerCase();
                    if (!seenTitles.has(lowerTitle)) {
                        seenTitles.add(lowerTitle);
                        uniqueEpisodes.push(ep);
                    }
                }
            }

            // Timpa array asli dengan array yang sudah unik
            daftar_episode.splice(0, daftar_episode.length, ...uniqueEpisodes);

            // Mengurutkan secara numerik agar Episode 1 selalu di atas
            daftar_episode.sort((a, b) => {
                const numA = getEpNum(a.judul);
                const numB = getEpNum(b.judul);
                
                if (numA !== -1 && numB !== -1) return numA - numB;
                if (numA !== -1 && numB === -1) return -1;
                if (numB !== -1 && numA === -1) return 1;
                return 0;
            });
        }

        // Simpan cache (MAL akan diurus oleh rute episodes.js menggunakan DB lokal)
        const finalResult = {
            judul_seri: judulSeri,
            cover_scraper: cover,
            daftar_episode: daftar_episode
        };
        cache.set(targetUrl, finalResult);

        return finalResult;
    } catch (err) {
        console.error('[Neosatsu Episodes Error]:', err.message);
        throw err;
    }
}

/**
 * [TAHAP 3] Mengambil server dari cache yang sudah di-scrape di Tahap 2
 */
export async function getNeosatsuServers(fakeUrl) {
    const [targetUrl, epId] = fakeUrl.split('___neosatsu_ep___');
    if (!targetUrl || !epId) return { judul: '', servers: [], nav_prev: null, nav_next: null };

    const titleTarget = epId.replace(/_/g, ' ');

    const cacheData = cache.get(targetUrl);
    if (cacheData) {
        const episodeList = cacheData.daftar_episode;
        const idx = episodeList.findIndex(e => e.judul === titleTarget);
        if (idx !== -1) {
            const episode = episodeList[idx];
            return {
                judul: episode.judul,
                judul_seri: cacheData.judul_seri,
                cover_scraper: cacheData.cover_scraper,
                servers: episode._servers || [],
                nav_prev: idx > 0 ? episodeList[idx - 1].url : null,
                nav_next: idx < episodeList.length - 1 ? episodeList[idx + 1].url : null
            };
        }
    }

    console.info("[Neosatsu Servers] Cache tidak ditemukan, mengambil ulang post...");
    const data = await getNeosatsuEpisodes(targetUrl);
    const episodeList = data.daftar_episode;
    const idx = episodeList.findIndex(e => e.judul === titleTarget);
    if (idx !== -1) {
        const episode = episodeList[idx];
        return {
            judul: episode.judul,
            judul_seri: data.judul_seri,
            cover_scraper: data.cover_scraper,
            servers: episode._servers || [],
            nav_prev: idx > 0 ? episodeList[idx - 1].url : null,
            nav_next: idx < episodeList.length - 1 ? episodeList[idx + 1].url : null
        };
    }

    return { judul: titleTarget, servers: [], nav_prev: null, nav_next: null };
}
