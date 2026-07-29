import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Helper untuk menstandarkan skema server agar tidak ada perbedaan nama properti (id vs nume, tipe vs type)
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

export async function initPlugins() {
    if (initialized) return;
    initialized = true;
    
    // Temukan semua file scraper di folder scrapers/
    const scrapersDir = path.join(__dirname, 'scrapers');
    const files = fs.readdirSync(scrapersDir).filter(file => 
        (file.endsWith('Scraper.js') || file.endsWith('ScraperService.js'))
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

export async function getPluginForUrl(url) {
    if (!url) return null;
    await initPlugins();
    
    const lowerUrl = url.toString().toLowerCase();
    
    // Manual fallback handling untuk format API lokal (/api/...)
    if (lowerUrl.startsWith('/anime/') && !lowerUrl.includes('samehadaku')) {
        return plugins.find(p => p.id === 'otakudesu');
    }
    if (lowerUrl.startsWith('neosatsu-label:') || lowerUrl.startsWith('neosatsu-merge:')) {
        return plugins.find(p => p.id === 'neosatsu');
    }

    // Coba cocokkan URL dengan domain plugin
    for (const plugin of plugins) {
        if (plugin.meta.domains && plugin.meta.domains.some(domain => lowerUrl.includes(domain))) {
            return plugin;
        }
    }
    
    return null;
}

export function getProviderIdFromUrlSync(url) {
    if (!url) return 'unknown';
    const lowerUrl = url.toString().toLowerCase();
    
    // Manual fallback handling untuk format API lokal (/api/...)
    if (lowerUrl.startsWith('/anime/') && !lowerUrl.includes('samehadaku')) {
        return 'otakudesu';
    }
    if (lowerUrl.startsWith('neosatsu-label:') || lowerUrl.startsWith('neosatsu-merge:')) {
        return 'neosatsu';
    }

    // Coba cocokkan URL dengan domain plugin dari cache memori
    for (const plugin of plugins) {
        if (plugin.meta.domains && plugin.meta.domains.some(domain => lowerUrl.includes(domain))) {
            return plugin.id;
        }
    }
    
    return 'unknown';
}

export class ProviderRegistry {
    static async getAllProviderIds() {
        await initPlugins();
        return plugins.map(p => p.id);
    }

    static async getProviderDetails(providerId) {
        await initPlugins();
        const p = plugins.find(p => p.id === providerId);
        if (!p) return null;
        return {
            id: p.id,
            name: p.name,
            matchUrl: (url) => {
                const lower = url.toLowerCase();
                return p.meta.domains.some(d => lower.includes(d));
            }
        };
    }

    /**
     * Mencari plugin berdasarkan URL (sync, menggunakan plugins yang sudah ter-load).
     * Mengembalikan objek provider dengan method getServers() dan getEpisodes(), atau null.
     */
    static getProviderForUrl(url) {
        if (!url) return null;
        const lowerUrl = url.toString().toLowerCase();

        for (const p of plugins) {
            if (p.meta.domains && p.meta.domains.some(domain => lowerUrl.includes(domain))) {
                return ProviderRegistry._wrapPlugin(p);
            }
        }
        return null;
    }

    /**
     * Mencari plugin berdasarkan ID provider (sync).
     * Mengembalikan objek provider dengan method getServers() dan getEpisodes(), atau null.
     */
    static getProviderById(providerId) {
        if (!providerId) return null;
        const p = plugins.find(pl => pl.id === providerId);
        if (!p) return null;
        return ProviderRegistry._wrapPlugin(p);
    }

    /**
     * Helper internal: membungkus plugin mentah menjadi interface provider yang seragam.
     */
    static _wrapPlugin(p) {
        return {
            id: p.id,
            name: p.name,
            getServers: async (url) => {
                let realUrl = url;
                if (url && url.includes('?url=')) {
                    realUrl = decodeURIComponent(url.split('?url=')[1]);
                }
                const data = await p.scrapeServers(realUrl);
                return {
                    ...data,
                    servers: standardizeServers(data?.servers || [], p.name)
                };
            },
            getEpisodes: async (url) => {
                return await p.scrapeEpisodes(url);
            }
        };
    }

    static async fetchEpisodes(url) {
        const plugin = await getPluginForUrl(url);
        if (plugin && plugin.scrapeEpisodes) {
            return await plugin.scrapeEpisodes(url);
        }
        console.warn(`[Registry] Tidak ada plugin yang bisa mengekstrak episode untuk URL: ${url}`);
        return null;
    }

    static async fetchServers(url) {
        const plugin = await getPluginForUrl(url);
        if (plugin && plugin.scrapeServers) {
            let realUrl = url;
            // Beberapa provider dibungkus dengan URL proxy lokal
            if (url.includes('?url=')) {
                realUrl = decodeURIComponent(url.split('?url=')[1]);
            }
            const data = await plugin.scrapeServers(realUrl);
            return {
                ...data,
                servers: standardizeServers(data?.servers || [], plugin.name)
            };
        }
        console.warn(`[Registry] Tidak ada plugin yang bisa mengekstrak server untuk URL: ${url}`);
        return { servers: [] };
    }

    static async fetchLatestUpdates(providerId) {
        await initPlugins();
        const plugin = plugins.find(p => p.id === providerId);
        if (plugin && plugin.scrapeLatestUpdates) {
            return await plugin.scrapeLatestUpdates();
        }
        return [];
    }
}
