import { isSafeToMerge, isOvaOrSpecialTitle } from '../utils/stringUtils.js';

export function sanitizeContaminatedEpisodeCards(episodesList) {
    if (!episodesList || !Array.isArray(episodesList)) return [];
    const OVA_URL_RE = /(?:-|\/)ova(?:-|\/|\b|_)|(?:-|\/)sp(?:-|\/|\b|_)|(?:-|\/)ex(?:-|\/|\b|_)|(?:-|\/)special(?:-|\/|\b|_)|(?:-|\/)bonus(?:-|\/|\b|_)/i;

    return episodesList.map(ep => {
        const epObj = ep && typeof ep === 'object' ? { ...ep } : {};
        if (epObj.urls && typeof epObj.urls === 'object') {
            epObj.urls = { ...epObj.urls };
        } else {
            epObj.urls = {};
        }

        const title = (epObj.judul || epObj.title || '').trim();
        const isOvaTitle = isOvaOrSpecialTitle(title);

        // 1. Jika judul kartu itu sendiri adalah OVA / Special, pastikan num adalah null agar tidak keliru sebagai episode reguler
        if (isOvaTitle) {
            epObj.num = null;
        } else if (epObj.num != null && typeof epObj.num === 'number' && !isNaN(epObj.num)) {
            // 2. Jika kartu adalah episode reguler (misal num: 1), periksa seluruh URL provider di dalamnya.
            // Jika ada provider yang URL-nya secara jelas adalah OVA/Special, hapus URL tercemar tersebut dari kartu episode reguler ini!
            for (const [provKey, provUrl] of Object.entries(epObj.urls)) {
                if (typeof provUrl === 'string' && OVA_URL_RE.test(provUrl)) {
                    console.warn(`[Sanitizer] 🛡️ Menghapus URL tercemar OVA (${provKey}: ${provUrl}) dari kartu episode normal "${title}" (Ep ${epObj.num})`);
                    delete epObj.urls[provKey];
                }
            }
        }

        return epObj;
    });
}

export function deduplicateEpisodes(episodes) {
    if (!episodes || !Array.isArray(episodes) || episodes.length === 0) return [];
    
    // Step 1: Bersihkan kontaminasi awal sebelum penggabungan
    const sanitized = sanitizeContaminatedEpisodeCards(episodes);
    const dedupeMap = new Map();

    for (const ep of sanitized) {
        const titleLower = (ep.judul || '').toLowerCase().trim();
        // ep.num is already set correctly by sanitizeContaminatedEpisodeCards — trust it directly
        const epNum = ep.num;
        
        const isOvaCandidate = isOvaOrSpecialTitle(titleLower);
        
        let foundKey = null;
        if (typeof epNum === 'number' && !isNaN(epNum)) {
            foundKey = `ep_${epNum}`;
        } else {
            // Fuzzy search among existing keys that don't start with 'ep_'
            for (const existingKey of dedupeMap.keys()) {
                if (!existingKey.startsWith('ep_')) {
                    const existingTitle = existingKey; // dedupeMap key is titleLower for movies
                    if (titleLower === existingTitle || isSafeToMerge(existingTitle, titleLower).isSafe) {
                        foundKey = existingKey;
                        break;
                    }
                }
            }
            if (!foundKey) foundKey = titleLower;
        }
        
        if (!dedupeMap.has(foundKey)) {
            dedupeMap.set(foundKey, { ...ep });
        } else {
            const existing = dedupeMap.get(foundKey);
            const isExistingNormal = existing.num != null && !isOvaOrSpecialTitle(existing.judul || '');

            if (isExistingNormal && isOvaCandidate) {
                // Jangan merge URL OVA/Special ke dalam kartu episode normal
                continue;
            }
            if (!isExistingNormal && epNum != null && !isOvaCandidate) {
                // Timpa kartu existing yang keliru/tercemar dengan kartu episode normal yang bersih
                dedupeMap.set(foundKey, { ...ep });
                continue;
            }

            existing.urls = { ...existing.urls, ...ep.urls };
            if (existing.num == null && ep.num != null && !isOvaCandidate) {
                existing.num = ep.num;
            }
        }
    }
    return Array.from(dedupeMap.values());
}
