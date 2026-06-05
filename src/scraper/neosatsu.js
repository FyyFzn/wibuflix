const axios = require('axios');
const cheerio = require('cheerio');

const IGNORED_CATS = ['episode', 'movie', 'batch', 'completed', 'ongoing', 'kamen rider', 'super sentai', 'ultraman', 'metal hero', 'tokusatsu', 'spesial', 'spin-off', 'hyper battle dvd', 'project red', 'dvd', 'tv series', 'series'];

/**
 * [TAHAP 1] Mengambil katalog dari Neosatsu. 
 * Kita akan mengelompokkan post yang memiliki judul seri yang sama.
 */
async function getNeosatsuCatalog(page = 1, searchParam = '', typeFilter = '') {
    const maxResults = 100;
    const startIndex = (page - 1) * maxResults + 1;

    try {
        const cacheKey = 'neosatsu_static_catalog';
        const CACHE_TTL = 3600000; // 1 hour
        let staticAnimeList = [];

        // 1. Pastikan Cache Statis Selalu Terisi
        if (global[cacheKey] && Date.now() - global[cacheKey].timestamp < CACHE_TTL) {
            staticAnimeList = global[cacheKey].data;
        } else {
            console.log(`[Neosatsu Scraper] Fetching Static Catalogs for Cache...`);
            const staticPages = [
                'https://www.neosatsu.com/p/kamen-rider-series.html',
                'https://www.neosatsu.com/p/kamen-rider-movie.html',
                'https://www.neosatsu.com/p/super-sentai-series.html',
                'https://www.neosatsu.com/p/super-sentai-movie.html',
                'https://www.neosatsu.com/p/ultraman-series.html',
                'https://www.neosatsu.com/p/ultraman-movie.html'
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
                        const title = $(el).attr('title') || $(el).text().trim();
                        let img = $(el).find('img').attr('src') || 'https://i.imgur.com/KxJ4L6J.jpeg'; // Default Neosatsu logo if text link

                        if (href && title && href !== 'javascript:void(0)' && title.length > 5) {
                            if (href.includes('/p/')) return; // Abaikan link navigasi page statis
                            const tLower = title.toLowerCase();

                            // Deteksi Special / V-Cinema dari judul
                            let finalTipe = tipe;
                            if (tLower.includes('special') || tLower.includes(' sp')) finalTipe = 'Special';
                            else if (tLower.includes('v-cinema') || tLower.includes('returns')) finalTipe = 'V-Cinema';
                            if (tLower.includes('kamen rider') || tLower.includes('super sentai') || tLower.includes('ultraman')) {
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

                                if (!uniqueCheck.has(endpoint)) {
                                    uniqueCheck.add(endpoint);
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

            global[cacheKey] = {
                timestamp: Date.now(),
                data: staticAnimeList
            };
        }

        // 2. Logika Pencarian
        if (searchParam && searchParam.trim() !== '') {
            const query = searchParam.toLowerCase();

            // Pencarian Lokal (Lebih Cepat dan Bersih)
            let localResults = staticAnimeList.filter(item => item.title.toLowerCase().includes(query));

            if (typeFilter) {
                localResults = localResults.filter(item => item.tipe.toLowerCase() === typeFilter.toLowerCase());
            }

            if (localResults.length > 0) {
                console.log(`[Neosatsu Scraper] Local Search Hit: Ditemukan ${localResults.length} hasil untuk "${searchParam}"`);
                return { page: parseInt(page), max_results: 9, anime: localResults.slice((page - 1) * 9, page * 9) };
            }

            // Jika tidak ada di lokal (misal cari Metal Hero), Fallback ke Pencarian Website (Blogger Feed)
            const feedUrl = `https://www.neosatsu.com/feeds/posts/default?q=${encodeURIComponent(searchParam)}&alt=json&max-results=${maxResults}&start-index=${startIndex}`;
            console.log(`[Neosatsu Scraper] Local Miss. Fallback API (Search): ${feedUrl}`);

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

                        let baseTitle = title.replace(/Subtitle Indonesia.*$/i, '').replace(/Episode.*$/i, '').trim();

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

            let finalAnimeList = animeList;
            if (typeFilter) {
                finalAnimeList = finalAnimeList.filter(item => item.tipe.toLowerCase() === typeFilter.toLowerCase());
            }

            return { page: parseInt(page), max_results: 9, anime: finalAnimeList.slice(0, 9) };

        } else {
            // 3. Mode Browse Biasa
            let browseDb = staticAnimeList;
            if (typeFilter) {
                browseDb = browseDb.filter(item => item.tipe.toLowerCase() === typeFilter.toLowerCase());
            }
            return { page: parseInt(page), max_results: 9, anime: browseDb.slice((page - 1) * 9, page * 9) };
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
async function getNeosatsuEpisodes(targetUrl) {
    if (!targetUrl) throw new Error("Parameter 'url' wajib diisi!");
    console.log(`\n[Neosatsu Scraper] Mengambil post/label dari: ${targetUrl}`);

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

            judulSeri = targetTitle;

            if (label) {
                feedUrl = `https://www.neosatsu.com/feeds/posts/default/-/${encodeURIComponent(label)}?alt=json&max-results=500`;
            } else {
                feedUrl = `https://www.neosatsu.com/feeds/posts/default?q=${encodeURIComponent(targetTitle)}&alt=json&max-results=500`;
            }

            console.log(`[Neosatsu Scraper] Fetching Label/Search Feed: ${feedUrl}`);

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
                console.log(`[Neosatsu Scraper] Fallback Merging via Label: ${feedUrl}`);
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
                                        const encryptedId = serverObj.ids;
                                        if (encryptedId && encryptedId.length > 13) {
                                            const b64 = encryptedId.substring(10, encryptedId.length - 3);
                                            try {
                                                const decryptedPath = Buffer.from(b64, 'base64').toString('utf8');
                                                const fullUrl = `https:/${decryptedPath}`;

                                                let finalIframeUrl = fullUrl;
                                                if (finalIframeUrl.includes('drive.google.com')) {
                                                    finalIframeUrl = finalIframeUrl.replace(/\/view(\?.*)?$/, '/preview');
                                                    try {
                                                        const urlObj = new URL(finalIframeUrl);
                                                        if (urlObj.pathname === '/open' || urlObj.pathname === '/uc') {
                                                            const id = urlObj.searchParams.get('id');
                                                            if (id) finalIframeUrl = `https://drive.google.com/file/d/${id}/preview`;
                                                        }
                                                    } catch (e) { }
                                                }

                                                nestedServers.push({
                                                    nama: `HD ${serverName}`,
                                                    namaHost: serverName.toLowerCase().includes('drive') ? 'gdrive' : serverName.toLowerCase(),
                                                    urlAsli: fullUrl,
                                                    iframeUrl: finalIframeUrl
                                                });
                                            } catch (e) { }
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
                                        const encryptedId = serverObj.ids;
                                        if (encryptedId && encryptedId.length > 13) {
                                            const b64 = encryptedId.substring(10, encryptedId.length - 3);
                                            try {
                                                const decryptedPath = Buffer.from(b64, 'base64').toString('utf8');
                                                const fullUrl = `https:/${decryptedPath}`;

                                                let finalIframeUrl = fullUrl;
                                                if (finalIframeUrl.includes('drive.google.com')) {
                                                    finalIframeUrl = finalIframeUrl.replace(/\/view(\?.*)?$/, '/preview');
                                                    try {
                                                        const urlObj = new URL(finalIframeUrl);
                                                        if (urlObj.pathname === '/open' || urlObj.pathname === '/uc') {
                                                            const id = urlObj.searchParams.get('id');
                                                            if (id) finalIframeUrl = `https://drive.google.com/file/d/${id}/preview`;
                                                        }
                                                    } catch (e) { }
                                                }

                                                resolutions.push({
                                                    nama: `${resolusi} ${serverName}`.trim(),
                                                    namaHost: serverName.toLowerCase().includes('drive') ? 'gdrive' : serverName.toLowerCase(),
                                                    urlAsli: fullUrl,
                                                    iframeUrl: finalIframeUrl
                                                });
                                            } catch (e) { }
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

        // Sorting Pintar: Karena uploader Neosatsu terkadang tidak konsisten (ada yang Ep 1 di atas, ada yang Ep 50 di atas),
        // Kita harus memastikan urutan selalu 1 -> 50 agar tombol Next selalu menuju episode selanjutnya yang benar.
        if (daftar_episode.length > 1) {
            const getEpNum = (title) => {
                const match = title.match(/Episode\s*(\d+)/i) || title.match(/Ep\s*(\d+)/i);
                return match ? parseInt(match[1]) : -1;
            };

            // Deduplikasi: Hapus duplikat jika ada 2 episode dengan nomor yang sama (misal dari post satuan & post batch)
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

            let firstEpNum = -1;
            let lastEpNum = -1;

            for (let i = 0; i < daftar_episode.length; i++) {
                const num = getEpNum(daftar_episode[i].judul);
                if (num !== -1) {
                    if (firstEpNum === -1) firstEpNum = num;
                    lastEpNum = num;
                }
            }

            // Jika episode pertama yang ditemukan lebih besar dari episode terakhir (misal 50 -> 1), kita reverse
            if (firstEpNum !== -1 && lastEpNum !== -1 && firstEpNum > lastEpNum) {
                daftar_episode.reverse();
            }
        }

        // Simpan cache
        global.neosatsuCache = global.neosatsuCache || {};
        global.neosatsuCache[targetUrl] = {
            judul_seri: judulSeri,
            cover_scraper: cover,
            daftar_episode: daftar_episode
        };

        return {
            judul_seri: judulSeri,
            cover_scraper: cover,
            daftar_episode: daftar_episode
        };
    } catch (err) {
        console.error('[Neosatsu Episodes Error]:', err.message);
        throw err;
    }
}

/**
 * [TAHAP 3] Mengambil server dari cache yang sudah di-scrape di Tahap 2
 */
async function getNeosatsuServers(fakeUrl) {
    const [targetUrl, epId] = fakeUrl.split('___neosatsu_ep___');
    if (!targetUrl || !epId) return { judul: '', servers: [], nav_prev: null, nav_next: null };

    const titleTarget = epId.replace(/_/g, ' ');

    if (global.neosatsuCache && global.neosatsuCache[targetUrl]) {
        const cacheData = global.neosatsuCache[targetUrl];
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

    console.log("[Neosatsu Servers] Cache tidak ditemukan, mengambil ulang post...");
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

module.exports = {
    getNeosatsuCatalog,
    getNeosatsuEpisodes,
    getNeosatsuServers
};
