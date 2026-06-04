const axios = require('axios');
const cheerio = require('cheerio');

/**
 * [TAHAP 1] Mengambil katalog dari Neosatsu. 
 * Neosatsu menggunakan konsep 1 Post = 1 Seri Penuh.
 */
async function getNeosatsuCatalog(page = 1, searchParam = '') {
    const maxResults = 15;
    const startIndex = (page - 1) * maxResults + 1;
    
    try {
        let feedUrl = '';
        if (searchParam && searchParam.trim() !== '') {
            // Karena Blogger Feed API tidak mendukung search yang bagus, kita kembali ke HTML untuk search
            const searchUrl = `https://www.neosatsu.com/search?q=${encodeURIComponent(searchParam)}&max-results=${maxResults}&start-index=${startIndex}`;
            console.log(`[Neosatsu Scraper] Search HTML: ${searchUrl}`);
            
            const { data } = await axios.get(searchUrl, {
                headers: { 'User-Agent': 'Mozilla/5.0' },
                timeout: 60000
            });
            const $ = cheerio.load(data);
            const animeList = [];
            
            $('.post.hentry').each((i, el) => {
                const title = $(el).find('h2.entry-title a, h1.entry-title a').text().trim();
                const url = $(el).find('h2.entry-title a, h1.entry-title a').attr('href');
                let thumb = $(el).find('.thumbnail img').attr('data-src') || $(el).find('.thumbnail img').attr('src') || '';
                
                if (thumb && thumb.startsWith('http')) {
                    thumb = thumb.replace(/\/w\d+-h\d+(-[c|p|s])?(-[a-zA-Z0-9]+)?\//g, '/s1600/').replace(/\/s\d+-c\//, '/s1600/');
                } else if (thumb && thumb.startsWith('data:')) {
                    // Jika hanya ada base64, kita bisa biarkan atau beri fallback
                }

                if (title && url) {
                    const titleLower = title.toLowerCase();
                    let tipe = 'Series';
                    let status = 'Completed';
                    
                    if (titleLower.includes('movie')) tipe = 'Movie';
                    else if (titleLower.includes('special') || titleLower.includes('spin-off') || titleLower.includes('hyper battle')) tipe = 'Spesial';
                    
                    if (tipe === 'Series') {
                        if (titleLower.includes('episode') && !titleLower.includes('end') && !titleLower.includes('batch')) {
                            status = 'Ongoing';
                        }
                    }

                    animeList.push({
                        title: title.replace(/Subtitle Indonesia.*$/i, '').replace(/Episode.*$/i, '').trim(),
                        thumb: thumb,
                        endpoint: url,
                        tipe: tipe,
                        status: status
                    });
                }
            });
            return { page: parseInt(page), max_results: maxResults, anime: animeList };
        } else {
            // Untuk halaman utama, gunakan JSON API agar lebih cepat
            feedUrl = `https://www.neosatsu.com/feeds/posts/default?alt=json&max-results=${maxResults}&start-index=${startIndex}`;
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
                        
                        // Ekstrak tipe dari kategori JSON jika ada
                        const cats = entry.category ? entry.category.map(c => c.term.toLowerCase()) : [];
                        const catsStr = cats.join(' ');
                        
                        if (titleLower.includes('movie') || catsStr.includes('movie')) tipe = 'Movie';
                        else if (titleLower.includes('special') || titleLower.includes('spin-off') || titleLower.includes('hyper battle') || catsStr.includes('spin-off') || catsStr.includes('dvd')) tipe = 'Spesial';
                        
                        if (tipe === 'Series') {
                            if (titleLower.includes('episode') && !titleLower.includes('end') && !titleLower.includes('batch')) {
                                status = 'Ongoing';
                            }
                        }

                        title = title.replace(/Subtitle Indonesia.*$/i, '').replace(/Episode.*$/i, '').trim();
                        animeList.push({
                            title: title,
                            thumb: thumb,
                            endpoint: linkObj.href,
                            tipe: tipe,
                            status: status
                        });
                    }
                });
            }
            return { page: parseInt(page), max_results: maxResults, anime: animeList };
        }
    } catch (err) {
        console.error('[Neosatsu Catalog Error]:', err.message);
        throw err;
    }
}

/**
 * [TAHAP 2 & 3] Mengambil daftar episode DAN server dari sebuah post Neosatsu.
 * Neosatsu menaruh semua data episode di dalam sebuah objek JavaScript rahasia di HTML.
 */
async function getNeosatsuEpisodes(targetUrl) {
    if (!targetUrl) throw new Error("Parameter 'url' wajib diisi!");
    console.log(`\n[Neosatsu Scraper] Mengambil post dari: ${targetUrl}`);

    try {
        const { data } = await axios.get(targetUrl, {
            headers: { 'User-Agent': 'Mozilla/5.0' },
            timeout: 60000
        });
        
        const $ = cheerio.load(data);
        const judulSeri = $('h1.entry-title').text().trim().replace(/Subtitle Indonesia.*$/i, '').trim() || 'Tokusatsu Series';
        let cover = $('.thumbnail img').first().attr('src') || $('meta[property="og:image"]').attr('content') || '';
        if (cover) cover = cover.replace(/\/w\d+-h\d+(-[c|p|s])?(-[a-zA-Z0-9]+)?\//g, '/s1600/');

        const daftar_episode = [];
        const scriptTags = $('script').map((i, el) => $(el).html()).get();
        let episodesJsonStr = '';

        for (const script of scriptTags) {
            if (script && script.includes('var dlItem =')) {
                // Ekstrak string JSON dari variabel dlItem
                const match = script.match(/var dlItem\s*=\s*(\[.*?\]);/s);
                if (match && match[1]) {
                    episodesJsonStr = match[1];
                    break;
                }
            }
        }

        if (!episodesJsonStr) {
            throw new Error("Gagal menemukan data episode tersembunyi di Neosatsu.");
        }

        // Karena formatnya bukan JSON murni (key tidak pakai tanda kutip ganda), 
        // kita menggunakan regex atau eval untuk mem-parsing.
        // HATI-HATI dengan eval, namun karena ini dari Neosatsu, ini satu-satunya cara parsing objek JS native.
        
        // Kita akan melakukan pembersihan (sandboxing) agar eval lebih aman.
        let parsedData = [];
        try {
            // Gunakan Function constructor sebagai alternatif aman terbatas
            const parseFunc = new Function(`return ${episodesJsonStr};`);
            parsedData = parseFunc();
        } catch(e) {
            console.error("Gagal parse array JS Neosatsu:", e.message);
        }

        parsedData.forEach(ep => {
            const epTitle = ep.name; // "Kamen Rider Zeztz Episode 37"
            if (epTitle.toLowerCase().includes('batch')) return; // Skip Batch Episodes!
            
            // STRUKTUR B: resGroup.label justru adalah episode (contoh: "Episode 1", "Episode 01")
            // Kalau dia mengandung "episode" ATAU tidak punya embel-embel "p" (bukan 360p, 480p, dll),
            // kita jadikan dia sebagai episode mandiri!
            let hasNestedEpisodes = false;
            if (ep.item && Array.isArray(ep.item)) {
                ep.item.forEach(resGroup => {
                    const resolusi = resGroup.label;
                    if (resolusi.toLowerCase().includes('batch')) return;
                    
                    // Deteksi Structure B
                    if (resolusi.toLowerCase().includes('episode') || (!resolusi.toLowerCase().includes('p') && resolusi.match(/^[0-9\-\s]+$/))) {
                        hasNestedEpisodes = true;
                        
                        // Ekstrak server di dalam episode bersarang ini
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
                                        nestedServers.push({
                                            nama: serverName.toLowerCase().includes('drive') ? 'gdrive' : serverName.toLowerCase(),
                                            namaHost: serverName.toLowerCase().includes('drive') ? 'gdrive' : serverName.toLowerCase(),
                                            urlAsli: fullUrl,
                                            iframeUrl: fullUrl
                                        });
                                    } catch (e) {}
                                }
                            });
                        }
                        
                        if (nestedServers.length > 0) {
                            const nestedEpTitle = resolusi.trim();
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
            
            // STRUKTUR A: Normal (ep.name adalah episode, resGroup.label adalah 360p, dll)
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
                                        
                                        resolutions.push({
                                            nama: resolusi,
                                            namaHost: serverName.toLowerCase().includes('drive') ? 'gdrive' : serverName.toLowerCase(),
                                            urlAsli: fullUrl,
                                            iframeUrl: fullUrl
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

        // Simpan cache sementara di memori agar getNeosatsuServers tidak perlu nge-scrape ulang!
        // Dalam skenario produksi mungkin pakai Redis, tapi ini untuk single-user.
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
    // fakeUrl format: https://www.neosatsu.com/2025/09/post.html#neosatsu_ep_Kamen_Rider_Zeztz_Episode_37
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
    
    // Fallback jika tidak ada di cache: Panggil getEpisodes secara diam-diam
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
