import * as cheerio from 'cheerio';
import axios from 'axios';
import { getCache } from '../../utils/cacheManager.js';
import { cleanSeriesTitle, extractEpNum } from '../../utils/stringUtils.js';
import { PROVIDER_URLS } from '../../config/providerUrls.js';

const cache = getCache('episodes', 3600);

export const scraperMeta = {
    id: 'ylnime',
    name: 'YLnime',
    domains: ['ylnime.com', 'ylnime']
};

export const scrapeEpisodes = getYlnimeEpisodes;
export const scrapeServers = getYlnimeServers;
export const scrapeLatestUpdates = getYlnimeLatestUpdates;

const BASE_URL = PROVIDER_URLS.YLNIME.BASE_URL;

const AX_HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
    'Accept-Language': 'id-ID,id;q=0.9,en;q=0.8',
    'Referer': BASE_URL + '/'
};

/**
 * Mengambil daftar episode dari halaman seri YLnime.
 * URL format: https://ylnime.com/index.php?series={slug}
 *             atau https://ylnime.com/?series={slug}
 */
export async function getYlnimeEpisodes(animeUrl) {
    const cacheKey = `ylnime_eps_${animeUrl}`;
    const cached = cache.get(cacheKey);
    if (cached) return cached;

    try {
        const { data } = await axios.get(animeUrl, {
            headers: AX_HEADERS,
            timeout: 20000
        });

        const $ = cheerio.load(data);

        // Judul seri dari title tag atau heading
        let judulSeri = $('h1.anime-title, h2.series-title, .series-header h1, h1').first().text().trim();
        if (!judulSeri) {
            judulSeri = $('title').text().replace(/[-|].*$/, '').trim();
        }
        judulSeri = cleanSeriesTitle(judulSeri);

        // Cover image dari og:image atau gambar pertama
        const coverScraper = $('meta[property="og:image"]').attr('content') ||
            $('.anime-cover img, .poster img, .series-poster img').first().attr('src') || '';

        // Daftar episode — YLnime menggunakan list-group-item atau card per episode
        const episodeList = [];
        const seenNums = new Set();

        // Selector 1: list-group-item (halaman seri yang sudah dirender)
        $('a.list-group-item, .episode-list a, .daftar-eps a, a[href*="&ep="], a[href*="?ep="]').each((_, el) => {
            const href = $(el).attr('href') || '';
            if (!href) return;

            let fullUrl = href.startsWith('http') ? href : `${BASE_URL}/${href.replace(/^\//, '')}`;
            // Fix issue: YLnime requires index.php in episode URL, otherwise it redirects to homepage
            if (fullUrl.includes('?series=') && !fullUrl.includes('index.php')) {
                fullUrl = fullUrl.replace('?', 'index.php?');
            }
            
            let title = $(el).text().trim() || `Episode`;
            
            // Hapus teks setelah baris baru (biasanya berisi tanggal rilis)
            title = title.replace(/\n[\s\S]*/, '').trim();
            const epNum = extractEpNum(title) ?? extractEpNum(href);

            if (epNum != null && seenNums.has(epNum)) return;
            if (epNum != null) seenNums.add(epNum);

            episodeList.push({
                judul: title,
                title,
                num: epNum,
                url: fullUrl,
            });
        });

        // Selector 2: pola URL ?series=SLUG&ep=N (generasi dari jumlah episode di halaman)
        // Coba cari angka total episode dari teks seperti "Total: 12 Episode"
        if (episodeList.length === 0) {
            const bodyText = $('body').text();
            const totalMatch = bodyText.match(/(\d+)\s*[Ee]pisode/);
            const totalEps = totalMatch ? parseInt(totalMatch[1]) : 0;

            // Ekstrak slug dari URL
            const urlObj = new URL(animeUrl.startsWith('http') ? animeUrl : `https://ylnime.com/${animeUrl}`);
            const slug = urlObj.searchParams.get('series') || urlObj.pathname.replace('/', '');

            if (totalEps > 0 && slug) {
                for (let i = 1; i <= totalEps; i++) {
                    episodeList.push({
                        judul: `Episode ${i}`,
                        title: `Episode ${i}`,
                        num: i,
                        url: `${BASE_URL}/index.php?series=${slug}&ep=${i}`,
                    });
                }
            }
        }

        // Urutkan dari terkecil ke terbesar
        episodeList.sort((a, b) => (a.num ?? 0) - (b.num ?? 0));

        const result = {
            judul_seri: judulSeri,
            cover_scraper: coverScraper,
            daftar_episode: episodeList
        };

        if (episodeList.length > 0) {
            cache.set(cacheKey, result);
        }

        return result;
    } catch (err) {
        console.error(`[YlnimeScraper] Error getYlnimeEpisodes(${animeUrl}):`, err.message);
        throw err;
    }
}

/**
 * Mengambil server video dari halaman episode YLnime.
 * URL format: https://ylnime.com/index.php?series={slug}&ep={num}
 */
export async function getYlnimeServers(episodeUrl) {
    const cacheKey = `ylnime_srv_${episodeUrl}`;
    const cached = cache.get(cacheKey);
    if (cached) return cached;

    try {
        const { data } = await axios.get(episodeUrl, {
            headers: AX_HEADERS,
            timeout: 20000
        });

        const $ = cheerio.load(data);
        const servers = [];

        // Ambil judul episode dari title atau heading
        let judulEpisode = $('h1, h2').first().text().trim() ||
            $('title').text().replace(/[-|].*$/, '').trim() ||
            'Episode';

        // Ekstrak data streams dari JavaScript (YLnime V2)
        $('script').each((i, el) => {
            const code = $(el).html();
            if (code && code.includes('const streams =')) {
                const match = code.match(/const\s+streams\s*=\s*(\[.*?\]);/s);
                if (match && match[1]) {
                    try {
                        const streamsJson = JSON.parse(match[1]);
                        streamsJson.forEach((s) => {
                            if (!s.link) return;
                            let type = s.link.includes('.mp4') ? 'mp4' : (s.link.includes('.m3u8') ? 'hls' : 'iframe');
                            let nama = `YLnime ${s.reso || ''}`.trim();
                            if (s.link.includes('pixeldrain') || s.link.includes('pxl')) {
                                nama = 'Pixeldrain';
                                type = 'iframe';
                            }
                            
                            servers.push({
                                nama: nama,
                                post: '',
                                nume: `${servers.length + 1}`,
                                id: `${servers.length + 1}`,
                                type: type,
                                tipe: type,
                                iframeUrl: s.link,
                                url: s.link,
                                namaHost: 'YLnime Stream',
                                provider: 'ylnime',
                                source: 'ylnime'
                            });
                        });
                    } catch (err) {
                        console.error("[YlnimeScraper] Gagal parse JSON streams:", err.message);
                    }
                }
            }
        });

        // Cari iframe embed (fallback)
        $('iframe').each((idx, el) => {
            const src = $(el).attr('src') || $(el).attr('data-src') || '';
            if (!src) return;
            
            // Cek duplikat dengan hasil streams
            if (servers.some(s => s.url === src)) return;

            servers.push({
                nama: `Server ${servers.length + 1}`,
                post: '',
                nume: `${servers.length + 1}`,
                id: `${servers.length + 1}`,
                type: 'iframe',
                tipe: 'iframe',
                aktif: true,
                iframeUrl: src.startsWith('http') ? src : `https:${src}`,
                url: src.startsWith('http') ? src : `https:${src}`,
                namaHost: extractHostname(src),
                provider: 'ylnime',
                source: 'ylnime',
            });
        });

        // Cari video tag langsung
        $('video source, video').each((idx, el) => {
            const src = $(el).attr('src') || '';
            if (!src) return;

            servers.push({
                nama: `Direct ${idx + 1}`,
                post: '',
                nume: `d${idx + 1}`,
                id: `d${idx + 1}`,
                type: 'direct',
                tipe: 'direct',
                aktif: true,
                iframeUrl: src,
                url: src,
                namaHost: 'Direct',
                provider: 'ylnime',
                source: 'ylnime',
            });
        });

        // Cari link download yang bisa diputar (mp4 / m3u8)
        $('a[href*=".m3u8"], a[href*=".mp4"]').each((idx, el) => {
            const href = $(el).attr('href') || '';
            if (!href) return;

            servers.push({
                nama: `Direct MP4 ${idx + 1}`,
                post: '',
                nume: `mp4_${idx + 1}`,
                id: `mp4_${idx + 1}`,
                type: 'direct',
                tipe: 'direct',
                aktif: true,
                iframeUrl: href,
                url: href,
                namaHost: 'Direct MP4',
                provider: 'ylnime',
                source: 'ylnime',
            });
        });

        const result = { judul: judulEpisode, servers, nav_prev: null, nav_next: null };

        if (servers.length > 0) {
            cache.set(cacheKey, result);
        }

        return result;
    } catch (err) {
        console.error(`[YlnimeScraper] Error getYlnimeServers(${episodeUrl}):`, err.message);
        return { judul: '', servers: [], nav_prev: null, nav_next: null };
    }
}

/**
 * Mengambil daftar anime terbaru dari halaman beranda YLnime.
 */
export async function getYlnimeLatestUpdates() {
    const cacheKey = `ylnime_latest`;
    const cached = cache.get(cacheKey);
    if (cached) return cached;

    try {
        const { data } = await axios.get(`${BASE_URL}/index.php?terbaru=1`, {
            headers: AX_HEADERS,
            timeout: 15000
        });

        const $ = cheerio.load(data);
        const updates = [];

        // Selector untuk card anime terbaru
        $('.card').each((_, el) => {
            const a = $(el).find('a.stretched-link, a[href*="series="]').first();
            const href = a.attr('href') || '';
            if (!href || !href.includes('series=')) return;

            const title = $(el).find('.card-title, h6').first().text().trim();
            const img = $(el).find('img').first().attr('src') || '';
            if (!title || !href) return;

            const fullUrl = href.startsWith('http') ? href : `${BASE_URL}/${href.replace(/^\//, '')}`;
            const slugMatch = href.match(/series=([^&]+)/);
            const slug = slugMatch ? decodeURIComponent(slugMatch[1]) : '';

            updates.push({ title: cleanSeriesTitle(title), url: fullUrl, slug, image: img });
        });

        if (updates.length > 0) cache.set(cacheKey, updates);
        return updates;
    } catch (err) {
        console.error(`[YlnimeScraper] Error getYlnimeLatestUpdates:`, err.message);
        return [];
    }
}

function extractHostname(url) {
    try {
        return new URL(url.startsWith('//') ? `https:${url}` : url).hostname.replace('www.', '');
    } catch {
        return 'Unknown';
    }
}
