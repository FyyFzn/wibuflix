export const API_BASE = '';

export const API = {
    katalog: `${API_BASE}/api/katalog`,
    episodes: `${API_BASE}/api/episodes?url=`,
    scrape: `${API_BASE}/api/scrape?url=`,
    resolve: `${API_BASE}/api/resolve`
};

export async function fetchKatalog(page = 1, search = '') {
    let url = `${API.katalog}?page=${page}`;
    if (search) url += `&s=${encodeURIComponent(search)}`;
    const res = await fetch(url);
    return res.json();
}

export async function fetchEpisodes(targetUrl) {
    const res = await fetch(API.episodes + encodeURIComponent(targetUrl));
    return res.json();
}

export async function scrapeVideo(targetUrl) {
    const res = await fetch(API.scrape + encodeURIComponent(targetUrl));
    return res.json();
}

export async function resolveServer(targetUrl, nume) {
    const res = await fetch(`${API.resolve}?url=${encodeURIComponent(targetUrl)}&nume=${nume}`);
    return res.json();
}
