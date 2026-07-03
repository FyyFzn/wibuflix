import Anime from '../models/Anime.js';
import { normalizeTitleForMatch } from './stringUtils.js';

function extractSequelMetadata(str) {
    if (!str) return { season: 1, part: 1 };
    const sMatch = str.match(/(?:season|s)\s*(\d+)/i) || 
                   str.match(/(\d+)(?:st|nd|rd|th)\s*season/i) || 
                   str.match(/-s(\d+)(?:-|$)/i) || 
                   str.match(/-season-(\d+)(?:-|$)/i);
    const pMatch = str.match(/(?:part|cour|pt)\s*(\d+)/i) || 
                   str.match(/-part-(\d+)(?:-|$)/i);
    
    let season = sMatch ? parseInt(sMatch[1], 10) : 1;
    let part = pMatch ? parseInt(pMatch[1], 10) : 1;
    return { season, part };
}

/**
 * Global method untuk memetakan judul seri (seriesTitle) ke entri katalog di database (Anime)
 * untuk penyedia tertentu (providerKey: 'samehadaku' | 'kuronime' | 'otakudesu').
 * 
 * Menerapkan Exact 1-to-1 match terlebih dahulu, kemudian fallback ke fuzzy matching
 * dengan proteksi anti-Live Action / Movie, skoring selisih panjang judul, dan
 * Absolute Versioning (Semantic Sequel Matching).
 */
export async function resolveCatalogSource(seriesTitle, providerKey) {
    if (!seriesTitle || !providerKey) return null;

    try {
        const query = normalizeTitleForMatch(seriesTitle);
        const sourceUrlField = `sources.${providerKey}.url`;
        const qSeq = extractSequelMetadata(seriesTitle);

        // 1. Prioritaskan pencarian Exact 1-to-1 match dari database (title atau aliases)
        const exactMatch = await Anime.findOne({
            [sourceUrlField]: { $ne: null },
            $or: [
                { title: { $regex: new RegExp(`^${query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i') } },
                { aliases: { $regex: new RegExp(`^${query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i') } }
            ]
        }).lean();

        if (exactMatch && exactMatch.sources && exactMatch.sources[providerKey]) {
            const itemSeq = extractSequelMetadata(`${exactMatch.title} ${exactMatch.sources[providerKey].url}`);
            if (qSeq.season === itemSeq.season && qSeq.part === itemSeq.part) {
                return {
                    title: exactMatch.title,
                    url: exactMatch.sources[providerKey].url,
                    entry: exactMatch
                };
            }
        }

        // 2. Fallback ke Safe Fuzzy Match dengan Semantic Versioning & skoring penalti selisih panjang
        const dbItems = await Anime.find({ [sourceUrlField]: { $ne: null } }).lean();
        if (!dbItems || dbItems.length === 0) return null;

        const queryWords = query.split(' ').filter(w => w.length > 2);
        let bestMatch = null;
        let bestScore = -1;

        const isLiveActionQuery = query.includes('live action');
        const isMovieQuery = query.includes('movie') || query.includes('film');

        for (const item of dbItems) {
            if (!item.sources || !item.sources[providerKey] || !item.sources[providerKey].url) continue;

            const itemTitle = item.title.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
            const itemUrl = (item.sources[providerKey].url || '').toLowerCase();

            // Mencegah anime salah masuk ke Live Action / Movie
            if (!isLiveActionQuery && (itemTitle.includes('live action') || itemUrl.includes('live-action'))) continue;
            if (!isMovieQuery && (itemTitle.includes('movie') || itemUrl.includes('-movie'))) continue;

            // HARD REJECT: Absolute Versioning Weight (Jika Season atau Part/Cour berbeda, langsung tolak!)
            const itemSeq = extractSequelMetadata(`${item.title} ${itemUrl}`);
            if (qSeq.season !== itemSeq.season || qSeq.part !== itemSeq.part) {
                continue;
            }

            let matches = 0;
            for (const w of queryWords) {
                if (new RegExp('\\b' + w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b').test(itemTitle)) matches++;
            }

            if (matches >= queryWords.length / 2 && matches > 0) {
                // Skoring dengan penalti selisih panjang string agar judul yang lebih tepat menang
                const lengthPenalty = Math.abs(itemTitle.length - query.length);
                const score = (matches * 1000) - lengthPenalty;
                if (score > bestScore) {
                    bestScore = score;
                    bestMatch = item;
                }
            }
        }

        if (!bestMatch || !bestMatch.sources || !bestMatch.sources[providerKey]) return null;

        return {
            title: bestMatch.title,
            url: bestMatch.sources[providerKey].url,
            entry: bestMatch
        };
    } catch (err) {
        console.error(`[resolveCatalogSource Error] (${providerKey}):`, err.message);
        return null;
    }
}
