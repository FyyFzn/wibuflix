import { getUnifiedAnimeEpisodes } from '../animeOrchestrator.js';
import { extractEpNum } from '../../utils/stringUtils.js';
import { getProviderKey, checkUrlBlacklisted } from '../streamRankingService.js';

/**
 * Helper failover: Mencari URL provider alternatif dari Orchestrator jika provider utama rusak/blacklisted.
 */
export async function findAlternativeProviderCandidate({ targetUrl, seriesTitle, episodeTitle, uniqueId, brokenProv, seriesSlug, episodeSlug, oldSeriesSlug }) {
    let fallbackUrl = null;
    let targetEpUrls = null;
    try {
        const epNum = extractEpNum(episodeTitle || targetUrl);
        if (epNum != null || targetUrl || episodeTitle) {
            const orchQuerySlug = uniqueId ? uniqueId.toString().replace(/^(mal-|db-)/, '') : seriesTitle;
            let animeData = null;
            if (orchQuerySlug || seriesTitle) {
                animeData = await getUnifiedAnimeEpisodes({ slug: orchQuerySlug || seriesTitle, forceRefresh: true }).catch(() => null);
            }
            if (!animeData || !animeData.episodes || animeData.episodes.length === 0) {
                animeData = await getUnifiedAnimeEpisodes({ targetUrl: targetUrl, forceRefresh: true }).catch(() => null);
            }
            if (animeData && animeData.episodes) {
                const targetEp = animeData.episodes.find(e => 
                    (epNum != null && e.num === epNum) || 
                    (e.url && e.url === targetUrl) || 
                    (e.urls && Object.values(e.urls).includes(targetUrl))
                );
                if (targetEp && targetEp.urls) {
                    const urlArray = Array.isArray(targetEp.urls) ? targetEp.urls : Object.values(targetEp.urls);
                    targetEpUrls = urlArray;
                    const candidates = urlArray.filter(Boolean);

                    for (const cand of candidates) {
                        if (cand && cand !== targetUrl) {
                            const candProv = getProviderKey(cand);
                            if (candProv && candProv === brokenProv) continue;
                            if (checkUrlBlacklisted(cand, { seriesSlug, episodeSlug, oldSeriesSlug })) continue;
                            fallbackUrl = cand;
                            break;
                        }
                    }
                }
            }
        }
    } catch (e) {
        console.warn('[API v2 Failover] Gagal mencari alternatif provider dari orchestrator:', e.message);
    }
    return { fallbackUrl, targetEpUrls };
}

/**
 * Helper untuk resolusi provider alternatif sebelum ekstraksi awal.
 */
export async function resolveInitialAlternative({ targetUrl, seriesTitle, episodeTitle, uniqueId, currentProv, seriesSlug, episodeSlug, oldSeriesSlug, urlsObj }) {
    let extractionUrl = targetUrl;
    let updatedUrlsObj = urlsObj;
    try {
        const epNum = extractEpNum(episodeTitle || targetUrl);
        if (epNum != null || targetUrl || episodeTitle) {
            const orchSlug = uniqueId ? uniqueId.toString().replace(/^(mal-|db-)/, '') : seriesTitle;
            let animeData = null;
            if (orchSlug || seriesTitle) {
                animeData = await getUnifiedAnimeEpisodes({ slug: orchSlug || seriesTitle, forceRefresh: false }).catch(() => null);
            }
            if (!animeData?.episodes?.length) {
                animeData = await getUnifiedAnimeEpisodes({ targetUrl, forceRefresh: false }).catch(() => null);
            }
            const ep = animeData?.episodes?.find(e => 
                (epNum != null && e.num === epNum) || 
                (e.url && e.url === targetUrl) || 
                (e.urls && Object.values(e.urls).includes(targetUrl))
            );
            if (ep?.urls) {
                const epUrlArray = Array.isArray(ep.urls) ? ep.urls : Object.values(ep.urls);
                const currentUrlsArray = Array.isArray(updatedUrlsObj) ? updatedUrlsObj : (updatedUrlsObj ? Object.values(updatedUrlsObj) : []);
                updatedUrlsObj = Array.from(new Set([...currentUrlsArray, ...epUrlArray]));

                for (const pUrl of updatedUrlsObj) {
                    if (pUrl && pUrl !== targetUrl && !checkUrlBlacklisted(pUrl, { seriesSlug, episodeSlug, oldSeriesSlug })) {
                        const prov = getProviderKey(pUrl) || 'unknown';
                        if (prov !== currentProv) {
                            extractionUrl = pUrl;
                            console.info(`[API v2 Stream] ✓ Mengalihkan ekstraksi ke alternatif: [${prov.toUpperCase()}] ${extractionUrl}`);
                            break;
                        }
                    }
                }
            }
        }
    } catch (e) {
        console.warn('[API v2 Stream] Gagal mencari alternatif saat blacklist check:', e.message);
    }
    return { extractionUrl, updatedUrlsObj };
}
