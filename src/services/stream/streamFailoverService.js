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
        if (epNum != null) {
            const orchQuerySlug = uniqueId ? uniqueId.toString().replace(/^(mal-|db-)/, '') : seriesTitle;
            let animeData = null;
            if (orchQuerySlug || seriesTitle) {
                animeData = await getUnifiedAnimeEpisodes({ slug: orchQuerySlug || seriesTitle, forceRefresh: true }).catch(() => null);
            }
            if (!animeData || !animeData.episodes || animeData.episodes.length === 0) {
                animeData = await getUnifiedAnimeEpisodes({ targetUrl: targetUrl, forceRefresh: true }).catch(() => null);
            }
            if (animeData && animeData.episodes) {
                const targetEp = animeData.episodes.find(e => e.num === epNum);
                if (targetEp && targetEp.urls) {
                    targetEpUrls = targetEp.urls;
                    const candidates = [
                        targetEp.urls.samehadaku,
                        targetEp.urls.otakudesu,
                        targetEp.urls.nanime,
                        targetEp.urls.neosatsu,
                        targetEp.urls.nimegami,
                        targetEp.urls.kuronime
                    ].filter(Boolean);

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
        if (epNum != null) {
            const orchSlug = uniqueId ? uniqueId.toString().replace(/^(mal-|db-)/, '') : seriesTitle;
            let animeData = null;
            if (orchSlug || seriesTitle) {
                animeData = await getUnifiedAnimeEpisodes({ slug: orchSlug || seriesTitle, forceRefresh: false }).catch(() => null);
            }
            if (!animeData?.episodes?.length) {
                animeData = await getUnifiedAnimeEpisodes({ targetUrl, forceRefresh: false }).catch(() => null);
            }
            const ep = animeData?.episodes?.find(e => e.num === epNum);
            if (ep?.urls) {
                updatedUrlsObj = { ...(updatedUrlsObj || {}), ...ep.urls };
                for (const [prov, pUrl] of Object.entries(ep.urls)) {
                    if (pUrl && pUrl !== targetUrl && prov !== currentProv && !checkUrlBlacklisted(pUrl, { seriesSlug, episodeSlug, oldSeriesSlug })) {
                        extractionUrl = pUrl;
                        console.info(`[API v2 Stream] ✓ Mengalihkan ekstraksi ke provider alternatif: [${prov.toUpperCase()}] ${extractionUrl}`);
                        break;
                    }
                }
            }
        }
    } catch (e) {
        console.warn('[API v2 Stream] Gagal mencari alternatif saat blacklist check:', e.message);
    }
    return { extractionUrl, updatedUrlsObj };
}
