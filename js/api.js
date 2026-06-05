export const API_BASE = '';

export const API = {
    katalog: `${API_BASE}/api/katalog`,
    episodes: `${API_BASE}/api/episodes?url=`,
    scrape: `${API_BASE}/api/scrape?url=`,
    resolve: `${API_BASE}/api/resolve`
};

export async function fetchKatalog(page = 1, search = '', tab = 'anime') {
    const url = `${API_BASE}/api/katalog?page=${page}&s=${encodeURIComponent(search)}&tab=${tab}`;
    const res = await fetch(url);
    return res.json();
}

export async function fetchEpisodes(targetUrl) {
    if (targetUrl.includes('otakudesu:')) {
        const slug = targetUrl.split('otakudesu:')[1];
        const res = await fetch(`/api/otakudesu/episodes/${slug}`);
        return res.json();
    }
    const res = await fetch(API.episodes + encodeURIComponent(targetUrl));
    return res.json();
}

export async function scrapeVideo(targetUrl, seriesTitle = '', episodeTitle = '') {
    if (targetUrl.startsWith('/api/otakudesu/servers')) {
        const res = await fetch(targetUrl);
        return res.json();
    }
    const res = await fetch(`${API.scrape}${encodeURIComponent(targetUrl)}&series=${seriesTitle}&episode=${episodeTitle}`);
    return res.json();
}

export async function resolveServer(targetUrl, nume) {
    const res = await fetch(`${API.resolve}?url=${encodeURIComponent(targetUrl)}&nume=${nume}`);
    return res.json();
}
