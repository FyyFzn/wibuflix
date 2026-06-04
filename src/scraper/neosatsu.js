const axios = require('axios');
const cheerio = require('cheerio');

const IGNORED_CATS = ['episode', 'movie', 'batch', 'completed', 'ongoing', 'kamen rider', 'super sentai', 'ultraman', 'metal hero', 'tokusatsu', 'spesial', 'spin-off', 'hyper battle dvd', 'project red', 'dvd', 'tv series', 'series'];

/**
 * [TAHAP 1] Mengambil katalog dari Neosatsu. 
 * Kita akan mengelompokkan post yang memiliki judul seri yang sama.
 */
async function getNeosatsuCatalog(page = 1, searchParam = '') {
    const maxResults = 50; // Perbesar fetch untuk memudahkan penggabungan di halaman yang sama
    const startIndex = (page - 1) * maxResults + 1;
    
    try {
        let feedUrl = '';
        const uniqueAnimeMap = new Map();
        
        if (searchParam && searchParam.trim() !== '') {
            feedUrl = `https://www.neosatsu.com/feeds/posts/default?q=${encodeURIComponent(searchParam)}&alt=json&max-results=${maxResults}&start-index=${startIndex}`;
        } else {
            feedUrl = `https://www.neosatsu.com/feeds/posts/default?alt=json&max-results=${maxResults}&start-index=${startIndex}`;
        }
        
        console.log(`[Neosatsu Scraper] Katalog API: ${feedUrl}`);
        
        const { data } = await axios.get(feedUrl, {
            headers: { 'User-Agent': 'Mozilla/5.0' },
            timeout: 60000
        });
        
        const animeList = [];
        
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

                    // Bersihkan judul untuk penggabungan (Grouping)
                    let baseTitle = title.replace(/Subtitle Indonesia.*$/i, '').replace(/Episode.*$/i, '').trim();
                    
                    // Ekstrak Label Spesifik Seri (Misal: Gotchard, Zeztz)
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
                        // Gunakan special endpoint untuk merge dengan menyertakan judul dasar
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
        
        // Paginasi mungkin butuh disesuaikan karena kita menggabungkan hasil,
        // namun 15 item unik biasanya cukup untuk 1 halaman.
        return { page: parseInt(page), max_results: 15, anime: animeList.slice(0, 15) };
        
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
                } catch(e) {
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
                                                    if (finalIframeUrl.includes('/open?id=')) {
                                                        const id = new URL(finalIframeUrl).searchParams.get('id');
                                                        if (id) finalIframeUrl = `https://drive.google.com/file/d/${id}/preview`;
                                                    }
                                                }
                                                
                                                nestedServers.push({
                                                    nama: serverName.toLowerCase().includes('drive') ? 'gdrive' : serverName.toLowerCase(),
                                                    namaHost: serverName.toLowerCase().includes('drive') ? 'gdrive' : serverName.toLowerCase(),
                                                    urlAsli: fullUrl,
                                                    iframeUrl: finalIframeUrl
                                                });
                                            } catch (e) {}
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
                                    const fakeEpUrl = `${targetUrl}#neosatsu_ep_${nestedEpTitle.replace(/\s+/g, '_')}`;
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
                                                    if (finalIframeUrl.includes('/open?id=')) {
                                                        const id = new URL(finalIframeUrl).searchParams.get('id');
                                                        if (id) finalIframeUrl = `https://drive.google.com/file/d/${id}/preview`;
                                                    }
                                                }

                                                resolutions.push({
                                                    nama: resolusi,
                                                    namaHost: serverName.toLowerCase().includes('drive') ? 'gdrive' : serverName.toLowerCase(),
                                                    urlAsli: fullUrl,
                                                    iframeUrl: finalIframeUrl
                                                });
                                            } catch (e) {}
                                        }
                                    });
                                }
                            });
                        }

                        if (resolutions.length > 0) {
                            const fakeEpUrl = `${targetUrl}#neosatsu_ep_${epTitle.replace(/\s+/g, '_')}`;
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
        
        // Sorting: Biasanya API Blogger return dari yang terbaru, jadi daftar episode terbalik (Ep 50, 49, 48)
        // Kita reverse agar Episode 1 berada di awal (atau biarkan sesuai selera UI)
        daftar_episode.reverse();

        // Simpan cache
        global.neosatsuCache = global.neosatsuCache || {};
        global.neosatsuCache[targetUrl] = daftar_episode;

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
    const [targetUrl, epId] = fakeUrl.split('#neosatsu_ep_');
    if (!targetUrl || !epId) return { judul: '', servers: [], nav_prev: null, nav_next: null };

    const titleTarget = epId.replace(/_/g, ' ');

    if (global.neosatsuCache && global.neosatsuCache[targetUrl]) {
        const episodeList = global.neosatsuCache[targetUrl];
        const idx = episodeList.findIndex(e => e.judul === titleTarget);
        if (idx !== -1) {
            const episode = episodeList[idx];
            return {
                judul: episode.judul,
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
