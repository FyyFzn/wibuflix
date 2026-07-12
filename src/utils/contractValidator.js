/**
 * Scraper Contract Validator & Silent Failure Detection Utility
 * 
 * Menerapkan prinsip zero-trust terhadap output scraper (Samehadaku, Otakudesu, Kuronime,
 * Neosatsu, Oploverz, Nanime, Nimegami, dll.).
 * Mencegah Kegagalan Silent (Silent Failures) di mana scraper mengembalikan HTTP 200 
 * dengan array kosong atau objek Error sewaktu layout/domain web target berubah.
 */

export class ScraperContractError extends Error {
    constructor(message, code = 'ERR_SCRAPER_CONTRACT_VIOLATION', provider = 'unknown', details = null) {
        super(message);
        this.name = 'ScraperContractError';
        this.code = code;
        this.provider = provider;
        this.details = details;
    }
}

export class SilentFailureError extends ScraperContractError {
    constructor(message, provider = 'unknown', details = null) {
        super(
            message,
            'ERR_SILENT_FAILURE_EMPTY_PAYLOAD',
            provider,
            details
        );
        this.name = 'SilentFailureError';
    }
}

/**
 * Validasi Kontrak Katalog / Daftar Episode (Episode List Contract)
 * Memastikan skema mengembalikan Detail Anime dan Array Episode yang tidak kosong & valid.
 * 
 * @param {object} data - Output dari getEpisodes / getEpisodeServiceData
 * @param {string} providerName - Nama penyedia web (contoh: 'otakudesu', 'kuronime')
 * @throws {SilentFailureError|ScraperContractError} Jika terjadi pelanggaran kontrak / silent failure
 */
export function validateEpisodeCatalogContract(data, providerName = 'unknown') {
    if (!data || typeof data !== 'object') {
        throw new ScraperContractError(
            `Output dari ${providerName} bukan objek JSON yang valid.`,
            'ERR_INVALID_SCHEMA',
            providerName
        );
    }

    const seriesTitle = data.judul_seri || data.series_title || data.judul || '';
    if (typeof seriesTitle !== 'string' || !seriesTitle.trim() || seriesTitle === 'Error' || seriesTitle.includes('Rejected')) {
        throw new SilentFailureError(
            `Scraper ${providerName} gagal mendapatkan judul anime yang valid ("${seriesTitle}"). Kemungkinan layout/domain web target berubah atau terblokir Cloudflare.`,
            providerName,
            { seriesTitle }
        );
    }

    const episodes = data.daftar_episode || data.episodes || [];
    if (!Array.isArray(episodes)) {
        throw new ScraperContractError(
            `Properti daftar_episode dari ${providerName} harus berupa array.`,
            'ERR_INVALID_EPISODES_ARRAY',
            providerName
        );
    }

    // Deteksi Kegagalan Silent: array episode kosong
    if (episodes.length === 0) {
        throw new SilentFailureError(
            `Scraper ${providerName} mengembalikan daftar_episode kosong (0 episode). Kemungkinan selektor CSS tidak cocok atau web target menggunakan proteksi bot baru.`,
            providerName,
            { seriesTitle, episodesCount: 0 }
        );
    }

    // Validasi setiap item episode di dalam array
    for (let i = 0; i < episodes.length; i++) {
        const ep = episodes[i];
        if (!ep || typeof ep !== 'object') {
            throw new ScraperContractError(
                `Item episode pada indeks [${i}] di ${providerName} rusak/bukan objek.`,
                'ERR_CORRUPT_EPISODE_ITEM',
                providerName
            );
        }

        const epTitle = ep.judul || ep.title || '';
        if (typeof epTitle !== 'string' || !epTitle.trim()) {
            throw new ScraperContractError(
                `Episode pada indeks [${i}] di ${providerName} tidak memiliki judul yang valid.`,
                'ERR_MISSING_EPISODE_TITLE',
                providerName
            );
        }

        let epUrl = ep.url || ep.slug || '';
        if (!epUrl && ep.urls) {
            if (ep.urls instanceof Map || typeof ep.urls.get === 'function' || typeof ep.urls.values === 'function') {
                const vals = Array.from(typeof ep.urls.values === 'function' ? ep.urls.values() : []);
                epUrl = vals.find(u => Boolean(u)) || '';
            } else if (typeof ep.urls === 'object') {
                epUrl = Object.values(ep.urls).find(u => Boolean(u)) || '';
            }
        }
        if (typeof epUrl !== 'string' || !epUrl.trim()) {
            throw new ScraperContractError(
                `Episode "${epTitle}" pada indeks [${i}] di ${providerName} tidak memiliki URL/ID/Slug yang valid.`,
                'ERR_MISSING_EPISODE_URL',
                providerName
            );
        }
    }

    return true;
}

/**
 * Validasi Kontrak Daftar Server & Stream Link (Servers List Contract)
 * Memastikan skema mengembalikan URL Episode / Stream Link yang benar-benar ada dan dapat diakses.
 * 
 * @param {object} data - Output dari getServers / /api/scrape
 * @param {string} providerName - Nama penyedia web
 * @throws {SilentFailureError|ScraperContractError}
 */
export function validateServersContract(data, providerName = 'unknown') {
    if (!data || typeof data !== 'object') {
        throw new ScraperContractError(
            `Output server dari ${providerName} bukan objek JSON yang valid.`,
            'ERR_INVALID_SCHEMA',
            providerName
        );
    }

    const title = data.judul || data.title || '';
    if (title === 'Error' || (typeof title === 'string' && title.startsWith('Error:'))) {
        throw new SilentFailureError(
            `Scraper ${providerName} menghasilkan status error ("${title}") saat mengambil server video.`,
            providerName,
            { debugInfo: data.debug_info || title }
        );
    }

    const servers = data.servers || [];
    if (!Array.isArray(servers)) {
        throw new ScraperContractError(
            `Properti servers dari ${providerName} harus berupa array.`,
            'ERR_INVALID_SERVERS_ARRAY',
            providerName
        );
    }

    // Deteksi Kegagalan Silent: array servers kosong
    if (servers.length === 0) {
        throw new SilentFailureError(
            `Scraper ${providerName} mengembalikan array servers kosong (0 server tersedia). Kemungkinan iframe/pemutaran video diproteksi atau layout berubah.`,
            providerName,
            { title, serversCount: 0, debugInfo: data.debug_info || 'Empty servers list' }
        );
    }

    // Validasi setiap item server di dalam array
    for (let i = 0; i < servers.length; i++) {
        const srv = servers[i];
        if (!srv || typeof srv !== 'object') {
            throw new ScraperContractError(
                `Item server pada indeks [${i}] di ${providerName} bukan objek yang valid.`,
                'ERR_CORRUPT_SERVER_ITEM',
                providerName
            );
        }

        const nama = srv.nama || srv.provider || srv.namaHost || '';
        if (typeof nama !== 'string' || !nama.trim()) {
            throw new ScraperContractError(
                `Server pada indeks [${i}] di ${providerName} tidak memiliki nama/provider yang valid.`,
                'ERR_MISSING_SERVER_NAME',
                providerName
            );
        }

        const streamUrl = srv.iframeUrl || srv.url || srv.urlAsli || '';
        if (typeof streamUrl !== 'string' || !streamUrl.trim()) {
            throw new ScraperContractError(
                `Server "${nama}" pada indeks [${i}] di ${providerName} tidak memiliki link/URL pemutaran (iframeUrl/url).`,
                'ERR_MISSING_STREAM_URL',
                providerName
            );
        }
    }

    return true;
}

/**
 * Helper middleware/response untuk memverifikasi dan mengelola penanganan error statis HTTP
 * ketika kontrak dilanggar (HTTP 502 Bad Gateway / 500 Internal Server Error).
 * 
 * @param {object} res - Express response object
 * @param {object} data - Hasil scraping dari controller
 * @param {'episodes'|'servers'} contractType - Tipe kontrak ('episodes' atau 'servers')
 * @param {string} providerName - Nama penyedia
 * @returns {boolean} True jika valid (dan siap dikirim via res.json), False jika sudah dikirim status error
 */
export function assertAndRespondContract(res, data, contractType, providerName = 'unknown') {
    try {
        if (contractType === 'episodes') {
            validateEpisodeCatalogContract(data, providerName);
        } else if (contractType === 'servers') {
            validateServersContract(data, providerName);
        }
        return true;
    } catch (err) {
        const isSilentOrContract = err instanceof ScraperContractError || err instanceof SilentFailureError;
        const statusCode = isSilentOrContract ? 502 : 500;
        const errorCode = err.code || 'ERR_INTERNAL_SCRAPER';

        console.warn(`[Contract Validator ${statusCode}] ${providerName} (${contractType}): ${err.message}`);

        if (!res.headersSent) {
            res.status(statusCode).json({
                status: 'error',
                code: errorCode,
                provider: providerName,
                message: err.message,
                details: err.details || undefined,
                error: err.message // Backward compatibility dengan error property lama
            });
        }
        return false;
    }
}
