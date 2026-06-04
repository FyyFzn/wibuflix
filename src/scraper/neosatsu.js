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
                let thumb = $(el).find('.thumbnail img').attr('src') || $(el).find('.thumbnail img').attr('data-src') || '';
                
                if (thumb) thumb = thumb.replace(/\/w\d+-h\d+(-[c|p|s])?(-[a-zA-Z0-9]+)?\//g, '/s1600/').replace(/\/s\d+-c\//, '/s1600/');

                if (title && url) {
                    animeList.push({
                        title: title.replace(/Subtitle Indonesia.*$/i, '').replace(/Episode.*$/i, '').trim(),
                        thumb: thumb,
                        endpoint: url
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
                        title = title.replace(/Subtitle Indonesia.*$/i, '').replace(/Episode.*$/i, '').trim();
                        animeList.push({
                            title: title,
                            thumb: thumb,
                            endpoint: linkObj.href
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
            
            const resolutions = [];
            
            if (ep.item && Array.isArray(ep.item)) {
                ep.item.forEach(resGroup => {
                    const resolusi = resGroup.label; // "360p", "480p", "720p"
                    if (resolusi.toLowerCase().includes('batch')) return; // Skip Batch resolutions!
                    
                    if (resGroup.link && Array.isArray(resGroup.link)) {
                        resGroup.link.forEach(serverObj => {
                            const serverName = serverObj.name || '';
                            const encryptedId = serverObj.ids; // "3qBczo3qBvL2RyaXZlLmdvb2dsZS5jb20..."
                            
                            if (encryptedId && encryptedId.length > 13) {
                                // Dekripsi: buang 10 char pertama dan 3 char terakhir
                                const b64 = encryptedId.substring(10, encryptedId.length - 3);
                                try {
                                    const decryptedPath = Buffer.from(b64, 'base64').toString('utf8');
                                    const fullUrl = `https:/${decryptedPath}`;
                                    
                                    resolutions.push({
                                        nama: resolusi, // Gunakan 'nama' agar sesuai dengan standar Samehadaku extractor
                                        namaHost: serverName.toLowerCase().includes('drive') ? 'gdrive' : serverName.toLowerCase(),
                                        urlAsli: fullUrl,
                                        iframeUrl: fullUrl
                                    });
                                } catch (e) {
                                    // Abaikan jika gagal decode base64
                                }
                            }
                        });
                    }
                });
            }

            if (resolutions.length > 0) {
                // Di sistem Samehadaku kita, kita butuh "URL" untuk tiap episode yang dipanggil ke API /scrape
                // Karena Neosatsu menyimpan SEMUA server dalam satu tempat, kita simpan datanya ke dalam struktur yang bisa digunakan
                // Untuk kesederhanaan frontend Samehadaku, kita harus menyediakan endpoint fake atau pass datanya.
                // Tapi frontend memanggil GET /api/scrape?url=EPISODE_URL
                
                // KITA AKAN SERIALISASI SELURUH SERVER OBJECT INI KE DALAM PARAMETER URL!
                // Tapi karena terlalu panjang, kita buat parameter url khusus yang menunjuk kembali ke post ini tapi dengan identifier index.
                const fakeEpUrl = `${targetUrl}#neosatsu_ep_${epTitle.replace(/\s+/g, '_')}`;
                
                daftar_episode.push({
                    judul: epTitle,
                    url: fakeEpUrl,
                    _servers: resolutions // Simpan data internal untuk diambil nanti
                });
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
    if (!targetUrl || !epId) return [];

    const titleTarget = epId.replace(/_/g, ' ');

    if (global.neosatsuCache && global.neosatsuCache[targetUrl]) {
        const episodeList = global.neosatsuCache[targetUrl];
        const episode = episodeList.find(e => e.judul === titleTarget);
        if (episode && episode._servers) {
            return episode._servers;
        }
    }
    
    // Fallback jika tidak ada di cache: Panggil getEpisodes secara diam-diam
    console.log("[Neosatsu Servers] Cache tidak ditemukan, mengambil ulang post...");
    const data = await getNeosatsuEpisodes(targetUrl);
    const episode = data.daftar_episode.find(e => e.judul === titleTarget);
    if (episode && episode._servers) {
        return episode._servers;
    }
    
    return [];
}

module.exports = {
    getNeosatsuCatalog,
    getNeosatsuEpisodes,
    getNeosatsuServers
};
