import { getSamehadakuEpisodes, getSamehadakuLatestUpdates } from './scrapers/samehadakuScraper.js';
import { scrapeVideoServers } from './extractors/videoExtractor.js';
import * as otakudesu from './scrapers/otakudesuScraper.js';
import { getKuronimeEpisodes, getKuronimeServers, getKuronimeLatestUpdates } from './scrapers/kuronimeScraper.js';
import { getNanimeEpisodes, getNanimeServers, getNanimeLatestUpdates } from './scrapers/nanimeScraper.js';
import { getNimegamiEpisodes, getNimegamiServers, getNimegamiLatestUpdates } from './scrapers/nimegamiScraper.js';
import * as oploverz from './scrapers/oploverzScraper.js';
import { getNeosatsuEpisodes, getNeosatsuServers, getNeosatsuLatestUpdates } from './scrapers/neosatsuScraperService.js';
import { extractOtakuSlug } from '../utils/stringUtils.js';

/**
 * ============================================================================
 * UNIVERSAL PROVIDER REGISTRY (Provider Gateway Pattern)
 * ============================================================================
 * Menghapus pengulangan rantai if-else di seluruh codebase (scrape.js,
 * episodeService.js, streamRankingService.js) dengan memusatkan identifikasi
 * URL dan pemanggilan fungsi getEpisodes & getServers ke dalam satu Single Source of Truth.
 */

// Helper untuk menstandarkan skema server agar tidak ada perbedaan nama properti (id vs nume, tipe vs type)
export function standardizeServers(servers = [], defaultSource = 'Samehadaku') {
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

const providers = [
    // 1. Neosatsu
    {
        id: 'neosatsu',
        name: 'Neosatsu',
        matchUrl: (url) => url.includes('___neosatsu_ep___') || url.includes('neosatsu.com') || url.startsWith('neosatsu-label:') || url.startsWith('neosatsu-merge:'),
        getEpisodes: async (url) => {
            const cleanUrl = url.includes('___neosatsu_ep___') ? url.split('___neosatsu_ep___')[0] : url;
            return await getNeosatsuEpisodes(cleanUrl);
        },
        getServers: async (url) => {
            const neoData = await getNeosatsuServers(url);
            return {
                ...neoData,
                judul: neoData?.judul || 'Tokusatsu',
                judul_seri: neoData?.judul_seri || neoData?.judul || 'Tokusatsu',
                servers: standardizeServers(neoData?.servers || [], 'Neosatsu')
            };
        },
        getLatestUpdates: async () => await getNeosatsuLatestUpdates()
    },
    // 2. Otakudesu
    {
        id: 'otakudesu',
        name: 'Otakudesu',
        matchUrl: (url) => url.includes('otakudesu') || url.startsWith('/anime/') || url.startsWith('/api/otakudesu/servers'),
        getEpisodes: async (url) => {
            const slug = extractOtakuSlug(url);
            return await otakudesu.getOtakuEpisodesFormatted(slug);
        },
        getServers: async (url) => {
            let realUrl = url;
            if (url.includes('?url=')) {
                realUrl = decodeURIComponent(url.split('?url=')[1]);
            }
            const data = await otakudesu.getServersInternal(realUrl);
            return {
                ...data,
                servers: standardizeServers(data?.servers || [], 'Otakudesu')
            };
        },
        getLatestUpdates: async () => await otakudesu.getOtakudesuLatestUpdates()
    },
    // 3. Kuronime
    {
        id: 'kuronime',
        name: 'Kuronime',
        matchUrl: (url) => url.includes('kuronime.sbs') || url.startsWith('/api/kuronime/'),
        getEpisodes: async (url) => await getKuronimeEpisodes(url),
        getServers: async (url) => {
            let realUrl = url;
            if (url.includes('?url=')) {
                realUrl = decodeURIComponent(url.split('?url=')[1]);
            }
            const data = await getKuronimeServers(realUrl);
            return {
                ...data,
                servers: standardizeServers(data?.servers || [], 'Kuronime')
            };
        },
        getLatestUpdates: async () => await getKuronimeLatestUpdates()
    },
    // 4. Nanime
    {
        id: 'nanime',
        name: 'Nanime',
        matchUrl: (url) => url.includes('nanimeid.net') || url.startsWith('/api/nanime/'),
        getEpisodes: async (url) => await getNanimeEpisodes(url),
        getServers: async (url) => {
            let realUrl = url;
            if (url.includes('?url=')) {
                realUrl = decodeURIComponent(url.split('?url=')[1]);
            }
            const data = await getNanimeServers(realUrl);
            return {
                ...data,
                servers: standardizeServers(data?.servers || [], 'Nanime')
            };
        },
        getLatestUpdates: async () => await getNanimeLatestUpdates()
    },
    // 5. Nimegami
    {
        id: 'nimegami',
        name: 'Nimegami',
        matchUrl: (url) => url.includes('nimegami.id') || url.startsWith('/api/nimegami/'),
        getEpisodes: async (url) => await getNimegamiEpisodes(url),
        getServers: async (url) => {
            let realUrl = url;
            if (url.includes('?url=')) {
                realUrl = decodeURIComponent(url.split('?url=')[1]);
            }
            const data = await getNimegamiServers(realUrl);
            return {
                ...data,
                servers: standardizeServers(data?.servers || [], 'Nimegami')
            };
        },
        getLatestUpdates: async () => await getNimegamiLatestUpdates()
    },
    // 6. Oploverz
    {
        id: 'oploverz',
        name: 'Oploverz',
        matchUrl: (url) => url.includes('oploverz.ltd') || url.includes('oploverz.site') || url.startsWith('/api/oploverz/'),
        getEpisodes: async (url) => await oploverz.getOploverzEpisodes(url),
        getServers: async (url) => {
            let realUrl = url;
            if (url.includes('?url=')) {
                realUrl = decodeURIComponent(url.split('?url=')[1]);
            }
            const data = await oploverz.getOploverzServers(realUrl);
            return {
                ...data,
                servers: standardizeServers(data?.servers || [], 'Oploverz')
            };
        },
        getLatestUpdates: async () => await oploverz.getOploverzLatestUpdates()
    },
    // 7. Samehadaku (Default/Primary)
    {
        id: 'samehadaku',
        name: 'Samehadaku',
        matchUrl: (url) => true, // Fallback utama jika tidak cocok dengan provider lain
        getEpisodes: async (url) => await getSamehadakuEpisodes(url),
        getServers: async (url) => {
            const data = await scrapeVideoServers(url);
            return {
                ...data,
                servers: standardizeServers(data?.servers || [], 'Samehadaku')
            };
        },
        getLatestUpdates: async () => await getSamehadakuLatestUpdates()
    }
];

export class ProviderRegistry {
    /**
     * Cari provider yang cocok untuk suatu URL.
     * Jika tidak ada yang cocok secara khusus, mengembalikan Samehadaku.
     */
    static getProviderForUrl(url) {
        if (!url || typeof url !== 'string') return providers[providers.length - 1]; // Samehadaku
        for (let i = 0; i < providers.length - 1; i++) {
            if (providers[i].matchUrl(url)) {
                return providers[i];
            }
        }
        return providers[providers.length - 1]; // Samehadaku
    }

    /**
     * Cari provider berdasarkan id (misal: 'otakudesu', 'kuronime').
     */
    static getProviderById(id) {
        return providers.find(p => p.id === id) || providers[providers.length - 1];
    }

    /**
     * Eksekusi getEpisodes dengan skema standar.
     */
    static async fetchEpisodes(url) {
        const provider = this.getProviderForUrl(url);
        return await provider.getEpisodes(url);
    }

    /**
     * Eksekusi getServers dengan skema standar (selalu mengembalikan servers yang terstandarisasi).
     */
    static async fetchServers(url) {
        const provider = this.getProviderForUrl(url);
        return await provider.getServers(url);
    }

    /**
     * Eksekusi getLatestUpdates untuk provider tertentu dengan skema DTO standar.
     */
    static async fetchLatestUpdates(providerId) {
        const provider = this.getProviderById(providerId);
        if (provider && typeof provider.getLatestUpdates === 'function') {
            return await provider.getLatestUpdates();
        }
        return [];
    }

    /**
     * Dapatkan semua daftar provider ID.
     */
    static getAllProviderIds() {
        return providers.map(p => p.id);
    }
}

export default ProviderRegistry;
