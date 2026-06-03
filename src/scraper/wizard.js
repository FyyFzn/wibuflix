const axios = require('axios');
const cheerio = require('cheerio');

/**
 * [TAHAP 1] Mengekstrak halaman katalog WizardSubs (Dikelompokkan berdasarkan Seri)
 */
async function getWizardCatalog(page = 1) {
    const maxResults = 15;
    const startIndex = (page - 1) * maxResults + 1;
    const targetUrl = `https://www.wizardsubs.my.id/search/label/Tokusatsu?max-results=${maxResults}&start-index=${startIndex}`;
    
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

            // Filter label untuk mencari nama Seri (Mengabaikan label generik)
            const genericLabels = ['BD', 'Movie', 'Tokusatsu', 'sub indo', 'Action', 'Drama', 'Comedy', 'Special', 'Super Sentai', 'Kamen Rider', 'Metal Heroes'];
            let seriesName = '';
            let seriesUrl = '';

            $(el).find('a[href*="/search/label/"]').each((j, a) => {
                const labelName = $(a).text().trim();
                if (!genericLabels.includes(labelName) && !seriesName) {
                    seriesName = labelName;
                    seriesUrl = $(a).attr('href');
                }
            });

            // Jika label spesifik tidak ditemukan, gunakan judul post sebagai nama
            if (!seriesName) {
                const titleNode = $(el).find('h2.entry-title a').length ? $(el).find('h2.entry-title a') : $(el).find('h1.entry-title a');
                seriesName = titleNode.text().trim();
                seriesUrl = titleNode.attr('href');
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
        // Agar mengambil semua episode dalam satu page label, set max-results tinggi
        const fetchUrl = targetUrl.includes('/search/label/') ? (targetUrl.includes('?') ? `${targetUrl}&max-results=100` : `${targetUrl}?max-results=100`) : targetUrl;
        
        const { data } = await axios.get(fetchUrl, {
            headers: { 'User-Agent': 'Mozilla/5.0' },
            timeout: 15000
        });
        
        const $ = cheerio.load(data);
        
        const judulSeri = $('h1.entry-title').text().trim() || 'Tokusatsu Series';
        const cover = $('.post-thumbnail').first().attr('src') || $('meta[property="og:image"]').attr('content') || '';
        const daftar_episode = [];

        // Jika ini adalah halaman Label (Kumpulan Post)
        if ($('.post.hentry').length > 0 && targetUrl.includes('/search/label/')) {
            $('.post.hentry').each((i, el) => {
                const titleNode = $(el).find('h2.entry-title a').length ? $(el).find('h2.entry-title a') : $(el).find('h1.entry-title a');
                const epTitle = titleNode.text().trim();
                const epUrl = titleNode.attr('href');
                if (epTitle && epUrl) {
                    daftar_episode.push({
                        judul: epTitle,
                        url: epUrl
                    });
                }
            });
        } else {
            // Jika ini halaman Post tunggal
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
