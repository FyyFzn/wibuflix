import * as cheerio from 'cheerio';
import axios from 'axios';
import { getCache } from '../../utils/cacheManager.js';
import { cleanSeriesTitle, extractEpNum } from '../../utils/stringUtils.js';
import { fetchWithCF } from '../../utils/scrapeHelper.js';
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
const SCRAPER_BASE = `http://localhost:${process.env.SCRAPER_PORT || 5001}`;

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

    const { data } = await axios.post(`${SCRAPER_BASE}/scrape/ylnime/series`, { url: animeUrl }, { timeout: 35000 });
    if (!data || !data.daftar_episode || data.daftar_episode.length === 0) {
        throw new Error(`Python scraper mengembalikan data kosong untuk ${animeUrl}`);
    }
    cache.set(cacheKey, data);
    return data;
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
        const fetchRes = await fetchWithCF(episodeUrl, { fetchTimeout: 20000 });
        const data = fetchRes.html;
        const $ = fetchRes.$;
        const servers = [];

        // Ambil judul episode dari title atau heading
        let judulEpisode = $('h1, h2').first().text().trim() ||
            $('title').text().replace(/[-|].*$/, '').trim() ||
            'Episode';

        // Ekstrak data streams dari JavaScript (YLnime V2)
        const parseStreams = (htmlText) => {
            const result = [];
            const $html = cheerio.load(htmlText);
            $html('script').each((i, el) => {
                const code = $html(el).html();
                if (code && code.includes('const streams =')) {
                    const match = code.match(/const\s+streams\s*=\s*(\[.*?\]);/s);
                    if (match && match[1]) {
                        try {
                            const streamsJson = JSON.parse(match[1]);
                            streamsJson.forEach((s) => {
                                if (!s.link) return;
                                let type = s.link.includes('.mp4') ? 'mp4' : (s.link.includes('.m3u8') ? 'hls' : 'iframe');
                                let nama = `YLnime ${s.reso || ''}`.trim();
                                let namaHost = 'YLnime Stream';
                                if (s.link.includes('pixeldrain') || s.link.includes('pxl')) {
                                    // Pertahankan resolusi dalam nama (mis. "Pixeldrain 720p") agar ranking service
                                    // dapat menempatkannya dalam bucket resolusi yang benar.
                                    nama = `Pixeldrain ${s.reso || ''}`.trim();
                                    namaHost = 'Pixeldrain';
                                    type = 'iframe';
                                }
                                result.push({
                                    nama: nama,
                                    post: '',
                                    type: type,
                                    tipe: type,
                                    iframeUrl: s.link,
                                    url: s.link,
                                    namaHost: namaHost,
                                    provider: 'ylnime',
                                    source: 'ylnime'
                                });
                            });
                        } catch (err) {}
                    }
                }
            });
            return result;
        };

        const seenUrls = new Set();
        
        // Ekstrak dari halaman utama (biasanya default 720p)
        const defaultStreams = parseStreams(data);
        defaultStreams.forEach(s => {
            if (!seenUrls.has(s.url)) {
                seenUrls.add(s.url);
                servers.push({ ...s, nume: `${servers.length + 1}`, id: `${servers.length + 1}` });
            }
        });

        // Cari tombol resolusi lain dan ambil secara paralel (untuk mendapatkan 1080p, dll)
        const resoLinks = [];
        $('a').each((i, el) => {
            let href = $(el).attr('href');
            if (href && href.includes('reso=')) {
                if (href.startsWith('?')) {
                    href = `index.php${href}`;
                }
                const resoUrl = href.startsWith('http') ? href : `https://ylnime.com/${href.replace(/^\/?/, '')}`;
                resoLinks.push(resoUrl);
            }
        });

        if (resoLinks.length > 0) {
            const promises = resoLinks.map(link => fetchWithCF(link, { fetchTimeout: 15000 }).catch(() => null));
            const results = await Promise.all(promises);
            for (const res of results) {
                if (res && res.html) {
                    const extraStreams = parseStreams(res.html);
                    extraStreams.forEach(s => {
                        if (!seenUrls.has(s.url)) {
                            seenUrls.add(s.url);
                            servers.push({ ...s, nume: `${servers.length + 1}`, id: `${servers.length + 1}` });
                        }
                    });
                }
            }
        }

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

    const { data } = await axios.post(`${SCRAPER_BASE}/scrape/ylnime/latest`, { url: `${BASE_URL}/index.php?terbaru=1` }, { timeout: 35000 });
    if (!Array.isArray(data) || data.length === 0) {
        throw new Error('[YLnime] Python latest scraper mengembalikan data kosong');
    }
    return data;
}

function extractHostname(url) {
    try {
        return new URL(url.startsWith('//') ? `https:${url}` : url).hostname.replace('www.', '');
    } catch {
        return 'Unknown';
    }
}
