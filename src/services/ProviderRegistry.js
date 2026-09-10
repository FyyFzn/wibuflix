import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Helper to standardize server schema so there are no property name discrepancies (id vs nume, tipe vs type)
export function standardizeServers(servers = [], defaultSource = 'Unknown') {
    if (!Array.isArray(servers)) return [];
    return servers.map(s => {
        const idOrNume = s.id || s.nume || '';
        const tipeOrType = s.tipe || s.type || 'direct';
        const urlOrIframe = s.url || s.iframeUrl || '';
        const providerOrHost = s.provider || s.namaHost || 'Direct';

        return {
            ...s,
            nama: s.nama || 'Server Stream',
            post: s.post || '',
            nume: idOrNume,
            id: idOrNume,
            type: tipeOrType,
            tipe: tipeOrType,
            aktif: s.aktif !== undefined ? s.aktif : true,
            iframeUrl: urlOrIframe,
            url: urlOrIframe,
            namaHost: providerOrHost,
            provider: providerOrHost,
            source: s.source || defaultSource,
            headers: s.headers || {}
        };
    });
}

const plugins = [];
let initialized = false;

async function ensurePluginsLoaded() {
    if (initialized) return;
    initialized = true;

    const scrapersDir = path.join(__dirname, 'scrapers');
    const files = fs.readdirSync(scrapersDir).filter(file =>
        file.endsWith('Scraper.js') || file.endsWith('ScraperService.js')
    );

    for (const file of files) {
        try {
            const module = await import(`./scrapers/${file}`);
            if (module.scraperMeta) {
                plugins.push({
                    id: module.scraperMeta.id,
                    name: module.scraperMeta.name,
                    meta: module.scraperMeta,
                    scrapeEpisodes: module.scrapeEpisodes || null,
                    scrapeServers: module.scrapeServers || null,
                    scrapeLatestUpdates: module.scrapeLatestUpdates || null
                });
                console.log(`[Provider Registry] 🔌 Plugin dimuat: ${module.scraperMeta.name}`);
            }
        } catch (err) {
            console.error(`[Provider Registry] Gagal memuat plugin ${file}:`, err.message);
        }
    }
}

function findPluginForUrl(url) {
    if (!url) return null;
    const lowerUrl = url.toString().toLowerCase();

    if (lowerUrl.startsWith('/anime/') && !lowerUrl.includes('samehadaku')) {
        return plugins.find(p => p.id === 'otakudesu') || null;
    }
    if (lowerUrl.startsWith('neosatsu-label:') || lowerUrl.startsWith('neosatsu-merge:')) {
        return plugins.find(p => p.id === 'neosatsu') || null;
    }

    return plugins.find(p =>
        p.meta.domains && p.meta.domains.some(domain => lowerUrl.includes(domain))
    ) || null;
}

export class ProviderRegistry {
    static async getAllProviderIds() {
        await ensurePluginsLoaded();
        return plugins.map(p => p.id);
    }

    /**
     * Returns the provider ID string for a given URL.
     */
    static async getProviderIdForUrl(url) {
        await ensurePluginsLoaded();
        if (!url) return 'unknown';
        const plugin = findPluginForUrl(url);
        return plugin ? plugin.id : 'unknown';
    }

    /**
     * Finds a wrapped provider for a given URL.
     */
    static async getProviderForUrl(url) {
        await ensurePluginsLoaded();
        const plugin = findPluginForUrl(url);
        return plugin ? ProviderRegistry._wrapPlugin(plugin) : null;
    }

    /**
     * Finds a wrapped provider by provider ID.
     */
    static async getProviderById(providerId) {
        await ensurePluginsLoaded();
        if (!providerId) return null;
        const plugin = plugins.find(p => p.id === providerId);
        return plugin ? ProviderRegistry._wrapPlugin(plugin) : null;
    }

    static _wrapPlugin(p) {
        return {
            id: p.id,
            name: p.name,
            getServers: async (url) => {
                const realUrl = url?.includes('?url=') ? decodeURIComponent(url.split('?url=')[1]) : url;
                const data = await p.scrapeServers(realUrl);
                return { ...data, servers: standardizeServers(data?.servers || [], p.name) };
            },
            getEpisodes: async (url) => p.scrapeEpisodes(url)
        };
    }

    static async fetchEpisodes(url, timeoutMs = 20000) {
        await ensurePluginsLoaded();
        const plugin = findPluginForUrl(url);
        if (plugin?.scrapeEpisodes) {
            const timeout = new Promise((_, reject) =>
                setTimeout(() => reject(new Error(`[${plugin.name}] Scrape timeout setelah ${timeoutMs / 1000}s untuk: ${url}`)), timeoutMs)
            );
            return await Promise.race([plugin.scrapeEpisodes(url), timeout]);
        }
        console.warn(`[Registry] Tidak ada plugin yang bisa mengekstrak episode untuk URL: ${url}`);
        return null;
    }

    static async fetchServers(url) {
        await ensurePluginsLoaded();
        const plugin = findPluginForUrl(url);
        if (plugin?.scrapeServers) {
            const realUrl = url?.includes('?url=') ? decodeURIComponent(url.split('?url=')[1]) : url;
            const data = await plugin.scrapeServers(realUrl);
            return { ...data, servers: standardizeServers(data?.servers || [], plugin.name) };
        }
        console.warn(`[Registry] Tidak ada plugin yang bisa mengekstrak server untuk URL: ${url}`);
        return { servers: [] };
    }

    static async fetchLatestUpdates(providerId) {
        await ensurePluginsLoaded();
        const plugin = plugins.find(p => p.id === providerId);
        if (plugin?.scrapeLatestUpdates) {
            return await plugin.scrapeLatestUpdates();
        }
        return [];
    }

    /**
     * Ensures all scraper plugins are loaded. Call this before using sync methods
     * (getProviderForUrl, getProviderById, getProviderIdForUrl).
     */
    static async init() {
        await ensurePluginsLoaded();
    }
}
