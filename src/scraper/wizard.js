const axios = require('axios');
const cheerio = require('cheerio');

/**
 * [TAHAP 1] Mengekstrak halaman katalog WizardSubs (Dikelompokkan berdasarkan Seri)
 */
async function getWizardCatalog(page = 1, searchParam = '') {
    const maxResults = 15;
    const startIndex = (page - 1) * maxResults + 1;
    
    let targetUrl = '';
    if (searchParam && searchParam.trim() !== '') {
        targetUrl = `https://www.wizardsubs.my.id/search?q=${encodeURIComponent(searchParam)}&max-results=${maxResults}&start-index=${startIndex}`;
    } else {
        targetUrl = `https://www.wizardsubs.my.id/search/label/Tokusatsu?max-results=${maxResults}&start-index=${startIndex}`;
    }
    
    console.log(`\n[Wizard Scraper] Mengambil katalog dari: ${targetUrl}`);

    try {
        const { data } = await axios.get(targetUrl, {
            headers: { 'User-Agent': 'Mozilla/5.0' },
            timeout: 15000
        });
        
        const $ = cheerio.load(data);
        const animeList = [];
        const seenSeries = new Set(); // Agar tidak duplikat seri di halaman yang sama

        $('.post.hentry').each((i, el) => {
            let thumb = $(el).find('img.post-thumbnail').attr('src') || $(el).find('meta[itemprop="image"]').attr('content') || '';
            if (thumb) thumb = thumb.replace(/\/w\d+-h\d+(-[c|p|s])?(-[a-zA-Z0-9]+)?\//g, '/s1600/');

            let seriesName = '';
            let seriesUrl = '';
            
            // Keyword utama Tokusatsu
            const keywords = ['kamen rider', 'ultraman', 'sentai', 'ranger', 'garo', 'hero', 'metal hero', 'ultra'];
            // Blacklist label yang sifatnya metadata/generik
            const generic = ['bd', 'bluray', 'movie', 'tokusatsu', 'action', 'drama', 'comedy', 'special', 'sub indo', 'raw', 'adventure', 'sci-fi', 'science fiction', 'super hero', 'survival', 'sports', 'mystery', 'kaiju', 'fiction', 'battle royal', 'ongoing', 'completed', 'batch', 'pc games', 'game', 'games', 'extra', 'software'];

            let bestLabel = null;
            let bestScore = -1;
            const postTitle = $(el).find('h2.entry-title a').length ? $(el).find('h2.entry-title a').text().trim() : $(el).find('h1.entry-title a').text().trim();

            $(el).find('a[href*="/search/label/"]').each((j, a) => {
                const labelName = $(a).text().trim();
                const lower = labelName.toLowerCase();
                
                if (generic.includes(lower)) return; // Skip label generik
                
                let score = 0;
                // Jika label mengandung keyword (Kamen Rider, dll), kasih poin besar
                if (keywords.some(k => lower.includes(k))) score += 10;
                
                // Jika judul post benar-benar mengandung kata dari label ini secara persis, poin super besar
                if (postTitle.toLowerCase().includes(lower)) score += 20;
                
                // Label spesifik yang lebih panjang sedikit lebih bagus (menghindari "Kamen Rider" kalah dengan "Kamen Rider Geats")
                score += (labelName.length * 0.1);

                if (score > bestScore) {
                    bestScore = score;
                    bestLabel = { name: labelName, url: $(a).attr('href') };
                }
            });

            // Fallback ke judul post (dibersihkan) jika tetap tidak ada label
            if (bestLabel) {
                seriesName = bestLabel.name;
                seriesUrl = bestLabel.url;
            } else {
                seriesName = postTitle.replace(/\[.*?\]/g, '').replace(/(Episode|Sub|Subtitle).*$/i, '').trim();
                seriesUrl = $(el).find('a[href*="/search/label/"]').first().attr('href') || $(el).find('.entry-title a').attr('href');
            }

            if (seriesName && seriesUrl && !seenSeries.has(seriesName)) {
                seenSeries.add(seriesName);
                animeList.push({
                    title: seriesName,
                    thumb: thumb,
                    endpoint: seriesUrl // URL ini bisa berupa URL Label atau URL Post tunggal
                });
            }
        });

        return { page: parseInt(page), max_results: maxResults, anime: animeList };
    } catch (err) {
        console.error('[Wizard Catalog Error]:', err.message);
        throw err;
    }
}

/**
 * [TAHAP 2] Mengekstrak daftar episode dari halaman Seri/Label
 * Jika target berupa Label, ekstrak list post. Jika target berupa Post, kembalikan dirinya sendiri.
 */
async function getWizardEpisodes(targetUrl) {
    if (!targetUrl) throw new Error("Parameter 'url' wajib diisi!");
    console.log(`\n[Wizard Scraper] Mengambil daftar episode dari: ${targetUrl}`);

    try {
        const daftar_episode = [];
        let judulSeri = 'Tokusatsu Series';
        let cover = '';

        // Jika ini adalah halaman Label (Kumpulan Post)
        if (targetUrl.includes('/search/label/')) {
            const labelRaw = targetUrl.split('/search/label/')[1].split('?')[0];
            // Decode url encode
            const labelDecoded = decodeURIComponent(labelRaw);
            judulSeri = labelDecoded;
            
            // Menggunakan API JSON bawaan Blogger untuk bypass limit pagination HTML 
            // Blogger JSON Feed bisa mengambil hingga 500 post sekaligus tanpa potong!
            const feedUrl = `https://www.wizardsubs.my.id/feeds/posts/default/-/${labelRaw}?alt=json&max-results=500`;
            
            const { data } = await axios.get(feedUrl, {
                headers: { 'User-Agent': 'Mozilla/5.0' },
                timeout: 15000
            });
            
            if (data && data.feed && data.feed.entry) {
                data.feed.entry.forEach(entry => {
                    const epTitle = entry.title.$t;
                    const linkObj = entry.link.find(l => l.rel === 'alternate');
                    if (linkObj && linkObj.href) {
                        daftar_episode.push({
                            judul: epTitle,
                            url: linkObj.href
                        });
                    }
                    
                    // Ambil thumbnail pertama yang ditemukan untuk cover seri
                    if (!cover && entry.media$thumbnail) {
                        cover = entry.media$thumbnail.url.replace(/\/s\d+-c\//, '/s1600/');
                    }
                });
            }
        } else {
            // Jika ini halaman Post tunggal
            const { data } = await axios.get(targetUrl, {
                headers: { 'User-Agent': 'Mozilla/5.0' },
                timeout: 15000
            });
            const $ = cheerio.load(data);
            judulSeri = $('h1.entry-title').text().trim() || 'Tokusatsu Series';
            cover = $('.post-thumbnail').first().attr('src') || $('meta[property="og:image"]').attr('content') || '';
            
            daftar_episode.push({
                judul: judulSeri,
                url: targetUrl
            });
        }

        return {
            judul_seri: judulSeri,
            cover_scraper: cover,
            daftar_episode: daftar_episode
        };
    } catch (err) {
        console.error('[Wizard Episodes Error]:', err.message);
        throw err;
    }
}

/**
 * [TAHAP 3] Mengekstrak link download/streaming dari halaman 1 episode (Post)
 */
async function getWizardServers(targetUrl) {
    if (!targetUrl) throw new Error("Parameter 'url' wajib diisi!");
    console.log(`\n[Wizard Scraper] Mengambil tautan video dari: ${targetUrl}`);

    try {
        const { data } = await axios.get(targetUrl, {
            headers: { 'User-Agent': 'Mozilla/5.0' },
            timeout: 15000
        });
        
        const $ = cheerio.load(data);
        const servers = [];
        
        $('.smokeddl .smokeurl').each((i, el) => {
            const resolution = $(el).find('strong').text().trim();
            $(el).find('a').each((j, a) => {
                const hostRaw = $(a).text().trim();
                const href = $(a).attr('href');
                
                let hostNameFull = hostRaw;
                if (hostRaw.toLowerCase().includes('google drive')) hostNameFull = 'gdrive';
                if (hostRaw.toLowerCase().includes('mega')) hostNameFull = 'mega';
                
                servers.push({
                    resolusi: resolution,
                    namaHost: hostNameFull,
                    urlAsli: href,
                    iframeUrl: href
                });
            });
        });

        return servers;
    } catch (err) {
        console.error('[Wizard Servers Error]:', err.message);
        throw err;
    }
}

module.exports = {
    getWizardCatalog,
    getWizardEpisodes,
    getWizardServers
};
