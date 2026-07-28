/**
 * Single Source of Truth (SSOT) untuk konfigurasi URL Provider di Wibuflix.
 * 
 * Jika ada provider yang mengganti domain atau struktur URL, cukup ubah di file ini saja!
 * Seluruh controller, sync worker, routes, dan test script memanggil konfigurasi ini.
 */

export const PROVIDER_URLS = {
    SAMEHADAKU: {
        NAME: 'Samehadaku',
        BASE_URL: 'https://v2.samehadaku.how',
        CATALOG_URL: 'https://v2.samehadaku.how/daftar-anime-2/',
        SERIES_PATH: '/anime/{slug}/',
        DOMAIN_KEYWORDS: ['samehadaku', 'v2.samehadaku.how']
    },
    OTAKUDESU: {
        NAME: 'Otakudesu',
        BASE_URL: 'https://otakudesu.blog',
        CATALOG_URL: 'https://otakudesu.blog/anime-list/',
        SERIES_PATH: '/anime/{slug}/',
        DOMAIN_KEYWORDS: ['otakudesu']
    },
    KURONIME: {
        NAME: 'Kuronime',
        BASE_URL: 'https://kuronime.sbs',
        CATALOG_URL: 'https://kuronime.sbs/anime/?list',
        SERIES_PATH: '/anime/{slug}/',
        DOMAIN_KEYWORDS: ['kuronime']
    },
    NANIME: {
        NAME: 'Nanime ID',
        BASE_URL: 'https://nanimeid.net',
        CATALOG_URL: 'https://nanimeid.net/explore?page=1',
        SERIES_PATH: '/anime/{slug}',
        DOMAIN_KEYWORDS: ['nanime', 'nanimeid.net']
    },
    NIMEGAMI: {
        NAME: 'Nimegami',
        BASE_URL: 'https://nimegami.id',
        CATALOG_URL: 'https://nimegami.id/anime-list/',
        SERIES_PATH: '/{slug}/',
        DOMAIN_KEYWORDS: ['nimegami']
    },
    OPLOVERZ: {
        NAME: 'Oploverz',
        BASE_URL: 'https://idn.oploverz.site',
        CATALOG_URL: 'https://idn.oploverz.site/series',
        SERIES_PATH: '/series/{slug}',
        DOMAIN_KEYWORDS: ['oploverz']
    },
    NEOSATSU: {
        NAME: 'Neosatsu',
        BASE_URL: 'https://www.neosatsu.com',
        CATALOG_URL: 'https://www.neosatsu.com/p/kamen-rider-series.html',
        SERIES_PATH: '/2024/01/{slug}.html',
        DOMAIN_KEYWORDS: ['neosatsu']
    }
};

export const PROVIDER_LIST = Object.values(PROVIDER_URLS);

/**
 * Mendapatkan URL Series/Anime secara dinamis berdasarkan key provider dan slug
 */
export function getProviderSeriesUrl(providerKey, slug) {
    if (!providerKey || !slug) return null;
    const provider = PROVIDER_URLS[providerKey.toUpperCase()];
    if (!provider || !provider.SERIES_PATH) return null;
    return `${provider.BASE_URL}${provider.SERIES_PATH.replace('{slug}', slug)}`;
}

/**
 * Cek apakah URL atau string adalah milik provider tertentu (menggunakan kunci provider, misal: 'OPLOVERZ')
 */
export function isProviderUrl(url, providerKey) {
    if (!url || typeof url !== 'string') return false;
    const provider = PROVIDER_URLS[providerKey.toUpperCase()];
    if (!provider) return false;
    const lowerUrl = url.toLowerCase();
    return provider.DOMAIN_KEYWORDS.some(kw => lowerUrl.includes(kw.toLowerCase()));
}
