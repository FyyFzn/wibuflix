import axios from 'axios';
import { getCache } from '../../utils/cacheManager.js';
import { formatEpisodeTitle, extractEpNumStrict, cleanSeriesTitle } from '../../utils/stringUtils.js';
import Anime from '../../models/Anime.js';
import { assertAndRespondContract } from '../../utils/contractValidator.js';
import { PROVIDER_URLS, getNanimeSeriesUrl } from '../../config/providerUrls.js';

const cache = getCache('nanime', 3600);

let globalInertiaVersion = null;

/**
 * Helper untuk melakukan HTTP GET request ke Nanime ID dengan header X-Inertia
 * dan injeksi Cookie dari environment variable, dilengkapi penanganan 409 Conflict otomatis.
 */
export async function fetchNanimeInertia(url) {
    const cookie = process.env.NANIME_COOKIE || '';
    const headers = {
        'X-Inertia': 'true',
        'X-Requested-With': 'XMLHttpRequest',
        'Cookie': cookie,
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'application/json, text/plain, */*',
        'Referer': `${PROVIDER_URLS.NANIME.BASE_URL}/`
    };
    if (globalInertiaVersion) {
        headers['X-Inertia-Version'] = globalInertiaVersion;
    }

    try {
        const response = await axios.get(url, { headers, timeout: 20000 });
        if (response.data?.version) {
            globalInertiaVersion = response.data.version;
        }
        return response.data;
    } catch (err) {
        // Jika 409 Conflict (Inertia version mismatch/missing), fallback ambil HTML normal
        if (err.response?.status === 409 || !globalInertiaVersion) {
            console.log(`[Inertia 409] Version mismatch/missing pada ${url}. Mengambil HTML untuk membaca data-page & version baru...`);
            const htmlRes = await axios.get(url, {
                headers: {
                    'Cookie': cookie,
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
                    'Referer': `${PROVIDER_URLS.NANIME.BASE_URL}/`
                },
                timeout: 20000
            });
            const html = htmlRes.data;
            const match = html.match(/data-page="([^"]+)"/) || html.match(/data-page='([^']+)'/);
            if (match && match[1]) {
                const decodedJson = match[1].replace(/&quot;/g, '"');
                const parsed = JSON.parse(decodedJson);
                if (parsed.version) {
                    globalInertiaVersion = parsed.version;
                    console.log(`[Inertia Version] Berhasil memperbarui versi Inertia: ${globalInertiaVersion}`);
                }
                return parsed;
            }
        }
        throw err;
    }
}

/**
 * Mengambil daftar episode dari halaman detail anime Nanime ID.
 * @param {string} animeUrl - URL halaman anime, e.g. https://nanimeid.net/anime/re-zero/
 * @returns {object} - { judul_seri, cover_scraper, daftar_episode }
 */
export async function getNanimeEpisodes(animeUrl) {
    const cacheKey = `nanime_eps_${animeUrl}`;
    const cachedData = cache.get(cacheKey);
    if (cachedData && cachedData.daftar_episode && cachedData.daftar_episode.length > 0) {
        console.log(`[Nanime Cache Hit] ${cacheKey}`);
        return cachedData;
    }

    console.log(`[Nanime] Fetching episodes: ${animeUrl}`);

    // Layer 1: Proteksi Struktural Rute URL
    if (animeUrl.includes('/manga/') || animeUrl.includes('/read/') || animeUrl.includes('/chapter/')) {
        console.warn(`[Nanime Protection] URL ditolak karena merupakan rute komik/manga: ${animeUrl}`);
        return { judul_seri: "Rejected (Comic/Manga)", cover_scraper: "", daftar_episode: [] };
    }

    try {
        const data = await fetchNanimeInertia(animeUrl);
        const props = data?.props || {};
        const anime = props.anime || props.show || props.series || props.data || {};

        // Layer 2: Proteksi Struktural Properti Tipe & Atribut Fisik
        const type = (anime.type || '').toString().toUpperCase();
        const comicTypes = ['MANGA', 'MANHWA', 'MANHUA', 'COMIC', 'NOVEL', 'DOUJIN', 'ONE-SHOT'];
        if (comicTypes.includes(type) || anime.chapters !== undefined || anime.chapters_count !== undefined) {
            console.warn(`[Nanime Protection] Item ditolak karena bertipe komik (${type}): ${anime.title || animeUrl}`);
            return { judul_seri: "Rejected (Comic/Manga)", cover_scraper: "", daftar_episode: [] };
        }

        const rawTitle = anime.title || anime.name || "Unknown Title";
        const judul = cleanSeriesTitle(rawTitle.trim());
        const cover = anime.poster || anime.image || anime.cover || '';

        // Ekstraksi daftar episode dari respons Inertia JSON
        const episodesRaw = anime.episodes || anime.episode_list || props.episodes || [];
        const daftar_episode = [];

        for (const ep of episodesRaw) {
            const epNum = ep.number || ep.episode || ep.num;
            const epTitleRaw = ep.title || `Episode ${epNum || ''}`;

            // Abaikan episode Batch
            if (epTitleRaw.toLowerCase().includes('batch') || (ep.slug && ep.slug.includes('batch'))) {
                continue;
            }

            // Bangun URL episode
            let epUrl = ep.url || ep.link;
            if (!epUrl) {
                if (ep.slug) {
                    epUrl = `${getNanimeSeriesUrl(anime.slug || '')}/${ep.slug}`;
                } else if (epNum !== undefined) {
                    epUrl = `${getNanimeSeriesUrl(anime.slug || '')}/episode/${epNum}`;
                }
            }

            if (epUrl) {
                daftar_episode.push({
                    judul: formatEpisodeTitle(epTitleRaw),
                    url: epUrl,
                    num: extractEpNumStrict(epTitleRaw) || (typeof epNum === 'number' ? epNum : null)
                });
            }
        }

        // Urutkan episode secara Ascending (dari episode terlama ke terbaru, e.g., Ep 1 -> Ep 12)
        daftar_episode.sort((a, b) => {
            const numA = a.num !== null ? a.num : 9999;
            const numB = b.num !== null ? b.num : 9999;
            return numA - numB;
        });

        // Hapus properti temporary 'num' sebelum dikembalikan
        const cleanEpisodes = daftar_episode.map(({ judul, url }) => ({ judul, url }));

        const result = { judul_seri: judul, cover_scraper: cover, daftar_episode: cleanEpisodes };
        if (cleanEpisodes.length > 0) {
            cache.set(cacheKey, result);
        }
        return result;
    } catch (err) {
        console.error(`[Nanime Episodes Error] ${animeUrl}:`, err.message);
        return { judul_seri: "Error", cover_scraper: "", daftar_episode: [] };
    }
}

/**
 * Mengambil daftar server streaming/download dari halaman episode Nanime ID.
 * Menggunakan respons JSON Inertia + Cookie (bisa bypass proteksi login).
 * @param {string} episodeUrl - URL halaman episode
 * @returns {object} - { judul, servers, nav_prev, nav_next, debug_info }
 */
export async function getNanimeServers(episodeUrl) {
    console.log(`[Nanime] Fetching servers: ${episodeUrl}`);

    let debugInfo = "OK";
    try {
        const data = await fetchNanimeInertia(episodeUrl);
        const props = data?.props || {};
        const episode = props.episode || props.data || props.current_episode || {};
        const anime = props.anime || props.show || {};

        let judul = episode.title || `Episode ${episode.number || ''}`;
        if (anime.title) {
            judul = `${cleanSeriesTitle(anime.title)} - ${formatEpisodeTitle(judul)}`;
        } else {
            judul = formatEpisodeTitle(judul);
        }

        const servers = [];
        let serverIdCounter = 1;

        // 1. Ambil Mirror Streams / Embeds (Filedon, Vidhide, Mega, Updesu, Okru, dll)
        const mirrors = episode.mirror_streams || episode.servers || episode.streams || episode.embeds || props.servers || [];
        for (const m of mirrors) {
            const providerName = m.provider || m.name || m.server || m.host || `Server ${serverIdCounter}`;
            const embedUrl = m.url || m.embed_url || m.link || m.src;
            const quality = m.quality || m.res || '720p';

            if (embedUrl) {
                servers.push({
                    nama: providerName.toUpperCase(),
                    url: embedUrl,
                    aktif: servers.length === 0, // Server pertama aktif
                    id: `nanime-stream-${serverIdCounter++}`,
                    kualitas: quality,
                    tipe: 'embed',
                    provider: providerName.toLowerCase()
                });
            }
        }

        // 2. Ambil Download URLs / VIP Links (Filedon, Pdrain, Acefile, GoFile, Mega, dll)
        const downloads = episode.download_urls || episode.downloads || episode.links || props.downloads || [];
        for (const d of downloads) {
            const providerName = d.provider || d.name || d.host || `Download ${serverIdCounter}`;
            const dlUrl = d.url || d.link || d.href;
            const quality = d.quality || d.res || 'HD';
            const format = d.format || d.ext || 'MP4';

            if (dlUrl) {
                // Tandai provider yang kompatibel dengan VideoExtractor WibuFlix (Mega, Acefile, Filedon, GoFile)
                const provLower = providerName.toLowerCase();
                const isExtractable = provLower.includes('mega') || provLower.includes('acefile') || provLower.includes('filedon') || provLower.includes('gofile') || provLower.includes('pdrain');

                servers.push({
                    nama: `${providerName.toUpperCase()} (${format} ${quality})`,
                    url: dlUrl,
                    aktif: servers.length === 0,
                    id: `nanime-dl-${serverIdCounter++}`,
                    kualitas: quality,
                    tipe: isExtractable ? 'extractable_download' : 'download',
                    provider: provLower
                });
            }
        }

        // Navigasi Prev/Next dari properti JSON
        let nav_prev = null;
        let nav_next = null;
        if (episode.prev_episode || props.prev_episode) {
            const prev = episode.prev_episode || props.prev_episode;
            nav_prev = prev.url || (prev.slug ? `${getNanimeSeriesUrl(anime.slug)}/${prev.slug}` : null);
        }
        if (episode.next_episode || props.next_episode) {
            const next = episode.next_episode || props.next_episode;
            nav_next = next.url || (next.slug ? `${getNanimeSeriesUrl(anime.slug)}/${next.slug}` : null);
        }

        if (servers.length === 0) {
            debugInfo = "No mirror streams or download URLs found in Inertia JSON.";
            console.warn(`[Nanime Servers Warn] ${debugInfo} for ${episodeUrl}`);
        }

        return { judul, servers, nav_prev, nav_next, debug_info: debugInfo };
    } catch (err) {
        console.error(`[Nanime Servers Error] ${episodeUrl}:`, err.message);
        return { judul: "Error", servers: [], nav_prev: null, nav_next: null, debug_info: err.message };
    }
}

/**
 * Handler Express: GET /api/nanime/episodes?url=...
 */
export async function handleGetEpisodes(req, res) {
    try {
        const url = req.query.url;
        if (!url) return res.status(400).json({ error: 'Parameter url wajib diisi' });
        const data = await getNanimeEpisodes(url);
        if (!assertAndRespondContract(res, data, 'episodes', 'Nanime')) return;
        res.json(data);
    } catch (err) {
        console.error('[Nanime Episodes Error]', err.message);
        res.status(500).json({ error: err.message });
    }
}

/**
 * Handler Express: GET /api/nanime/servers?url=...
 */
export async function handleGetServers(req, res) {
    try {
        const url = req.query.url;
        if (!url) return res.status(400).json({ error: 'Parameter url wajib diisi' });
        const data = await getNanimeServers(url);
        if (!assertAndRespondContract(res, data, 'servers', 'Nanime')) return;
        res.json(data);
    } catch (err) {
        console.error('[Nanime Servers Error]', err.message);
        res.status(500).json({ error: err.message });
    }
}
