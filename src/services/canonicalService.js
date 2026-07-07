import Anime from '../models/Anime.js';
import { normalizeTitleForMatch } from '../utils/stringUtils.js';
import { findAnimeInDatabase } from './episodeService.js';
import { resolveCatalogSource } from '../utils/animeMatcher.js';

export const canonicalTitleMap = new Map();

/**
 * Canonical Database Identity Lookup:
 * Memastikan bahwa dari web mana pun (Samehadaku, Otakudesu, Kuronime, Neosatsu) anime diputar,
 * jika uniqueId belum ada dari frontend, kita secara otomatis mengaitkannya dengan malId atau ObjectId
 * dari database MongoDB lokal agar selalu masuk ke dalam 1 folder kanonikal yang sama di Azure Blob Storage!
 */
export async function resolveCanonicalUniqueId(seriesUrl, episodeUrl, seriesTitle, currentUniqueId) {
    if (currentUniqueId && currentUniqueId.toString().trim() !== '') {
        const rawId = currentUniqueId.toString().trim();
        if (!canonicalTitleMap.has(rawId)) {
            try {
                const malMatch = rawId.match(/^mal-(\d+)/);
                const dbMatch = rawId.match(/^db-([0-9a-fA-F]{24})/);
                let dbAnime = null;
                if (malMatch) {
                    dbAnime = await Anime.findOne({ malId: parseInt(malMatch[1], 10) });
                } else if (dbMatch) {
                    dbAnime = await Anime.findById(dbMatch[1]);
                }
                if (dbAnime) {
                    const canonicalTitle = (dbAnime.normalizedTitle || (dbAnime.title ? normalizeTitleForMatch(dbAnime.title) : '')).replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '').replace(/-+/g, '-').replace(/^-|-$/g, '');
                    if (canonicalTitle) canonicalTitleMap.set(rawId, canonicalTitle);
                }
            } catch (e) {}
        }
        return rawId;
    }
    
    try {
        let dbAnime = null;
        if (seriesUrl || episodeUrl) {
            const targetUrl = seriesUrl || episodeUrl;
            dbAnime = await findAnimeInDatabase({ targetUrl });
        }
        
        if (!dbAnime && seriesTitle) {
            for (const prov of ['samehadaku', 'otakudesu', 'kuronime', 'nanime', 'neosatsu']) {
                const res = await resolveCatalogSource(seriesTitle, prov);
                if (res && res.entry) {
                    dbAnime = res.entry;
                    break;
                }
            }
        }
        
        if (dbAnime) {
            const canonicalTitle = (dbAnime.normalizedTitle || (dbAnime.title ? normalizeTitleForMatch(dbAnime.title) : '')).replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '').replace(/-+/g, '-').replace(/^-|-$/g, '');
            if (dbAnime.malId) {
                const malKey = `mal-${dbAnime.malId}`;
                if (canonicalTitle) canonicalTitleMap.set(malKey, canonicalTitle);
                console.info(`[CanonicalLookup] ✓ Mengaitkan "${seriesTitle || seriesUrl}" dengan mal-${dbAnime.malId} dari database.`);
                return malKey;
            } else if (dbAnime._id) {
                const dbKey = `db-${dbAnime._id}`;
                if (canonicalTitle) canonicalTitleMap.set(dbKey, canonicalTitle);
                console.info(`[CanonicalLookup] ✓ Mengaitkan "${seriesTitle || seriesUrl}" dengan db-${dbAnime._id} dari database.`);
                return dbKey;
            }
        }
    } catch (err) {
        console.warn(`[CanonicalLookup Error]:`, err.message);
    }
    
    return currentUniqueId || null;
}
