import { resolveCanonicalUniqueId } from '../services/canonicalService.js';
import { extractSlugs } from '../services/slugService.js';
import { prefetchOneEpisode, triggerPrefetchWindow } from '../services/prefetchService.js';
import { checkUploadStatusWithFallback, getBlobPath, getBlobUrl } from '../services/stream/blobStorageService.js';
import { getUploadProgress, invalidateAndDeleteBlob } from '../services/stream/uploadProgressService.js';
import { getUnifiedAnimeEpisodes } from '../services/animeOrchestrator.js';
import { extractEpNum } from '../utils/stringUtils.js';
import { globalBlacklistCache } from '../services/stream/streamStateStore.js';
import { isEpisodeProviderBlacklisted } from '../services/streamRankingService.js';

/**
 * Controller V2 Stream:
 * Menjamin 100% Azure Blob Streaming. Frontend tidak menerima direct link eksternal atau iframe.
 * Rute: GET /api/v2/stream
 */
export async function getV2Stream(req, res) {
    let { episodeUrl, url, seriesUrl, nextEpisodeUrl, seriesTitle, episodeTitle, uniqueId, urls } = req.query;
    const targetUrl = episodeUrl || url;

    if (!targetUrl) {
        return res.status(400).json({
            status: 'error',
            message: "Parameter 'episodeUrl' atau 'url' wajib diisi!"
        });
    }

    try {
        uniqueId = await resolveCanonicalUniqueId(seriesUrl, targetUrl, seriesTitle, uniqueId);
        const { seriesSlug, episodeSlug, oldSeriesSlug, slugsToCheck, episodeSlugsToCheck } = extractSlugs(targetUrl, seriesUrl, seriesTitle, uniqueId, episodeTitle);

        const checkInfo = await checkUploadStatusWithFallback(slugsToCheck, episodeSlugsToCheck);
        const status = checkInfo.status;
        const activeSlug = checkInfo.activeSeriesSlug || seriesSlug;
        const activeEpSlug = checkInfo.activeEpisodeSlug || episodeSlug;

        const forceRefresh = req.query.force === 'true' || req.query.refresh === 'true';

        // 1. JIKA SUDAH READY DI AZURE BLOB -> KEMBALIKAN URL BLOB (Kecuali forceRefresh = true)
        if (status === 'READY' && !forceRefresh) {
            if (nextEpisodeUrl) {
                triggerPrefetchWindow(seriesSlug, [nextEpisodeUrl], seriesTitle, slugsToCheck, uniqueId);
            }
            return res.json({
                status: 'success',
                data: {
                    stream_status: 'READY',
                    url: getBlobUrl(getBlobPath(activeSlug, activeEpSlug))
                }
            });
        }

        if (status === 'READY' && forceRefresh) {
            console.info(`[API v2 Stream] Force Refresh diminta! Mengabaikan cache Azure Blob dan melakukan ekstraksi ulang untuk: ${targetUrl}`);
        }

        // 2. JIKA SEDANG UPLOAD -> KEMBALIKAN PROGRESS (Tanpa fallback proxy/webview!)
        if (status === 'UPLOADING') {
            if (nextEpisodeUrl) {
                triggerPrefetchWindow(seriesSlug, [nextEpisodeUrl], seriesTitle, slugsToCheck, uniqueId);
            }
            const progress = getUploadProgress(activeSlug, activeEpSlug) || 0;
            return res.json({
                status: 'success',
                data: {
                    stream_status: 'UPLOADING',
                    message: 'Video sedang diproses dan diunggah ke Azure Blob Cloud Storage...',
                    progress: progress
                }
            });
        }

        // 3. JIKA BELUM ADA ATAU FAILED -> MULAI EKSTRAKSI KE AZURE BLOB DI BACKGROUND
        let urlsObj = null;
        if (urls) {
            try { urlsObj = typeof urls === 'string' ? JSON.parse(urls) : urls; } catch (e) {}
        }

        // BLACKLIST CHECK: Jika URL utama atau provider sudah dilaporkan rusak untuk episode ini, cari alternatif SEBELUM mulai ekstraksi
        let extractionUrl = targetUrl;
        const getProvKey = (u) => {
            if (!u) return '';
            for (const p of ['otakudesu', 'kuronime', 'nanime', 'neosatsu', 'nimegami', 'samehadaku']) {
                if (u.includes(p)) return p;
            }
            return '';
        };
        const currentProv = getProvKey(targetUrl);
        const checkUrlOrEpBroken = (url, prov) => {
            if (!url) return false;
            if (globalBlacklistCache.get(`broken_url_${url}`)) return true;
            if (url.includes('?url=')) {
                try {
                    const dec = decodeURIComponent(url.split('?url=')[1]);
                    if (dec && globalBlacklistCache.get(`broken_url_${dec}`)) return true;
                } catch(e) {}
            }
            if (prov && globalBlacklistCache.get(`broken_provider_${prov}`)) return true;
            if (prov && isEpisodeProviderBlacklisted(prov, { seriesSlug, episodeSlug, oldSeriesSlug })) return true;
            return false;
        };

        const isMainUrlOrProvBroken = checkUrlOrEpBroken(targetUrl, currentProv);

        if (isMainUrlOrProvBroken) {
            console.info(`[API v2 Stream] URL/Provider ${currentProv || targetUrl} terdeteksi blacklisted/rusak untuk episode ini. Mencari provider alternatif...`);
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
                        urlsObj = { ...(urlsObj || {}), ...ep.urls };
                        for (const [prov, pUrl] of Object.entries(ep.urls)) {
                            if (pUrl && pUrl !== targetUrl && prov !== currentProv && !checkUrlOrEpBroken(pUrl, prov)) {
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
        }

        console.info(`[API v2 Stream] Memulai ekstraksi video ke Azure Blob untuk: ${extractionUrl}`);
        prefetchOneEpisode(seriesSlug, extractionUrl, seriesTitle, 'player', oldSeriesSlug, slugsToCheck, episodeTitle, uniqueId, null, urlsObj)
            .then(res => {
                if (res && res.success && nextEpisodeUrl) {
                    console.info(`[API v2 Stream] Upload episode selesai. Memulai prefetch episode berikutnya: ${nextEpisodeUrl}`);
                    triggerPrefetchWindow(seriesSlug, [nextEpisodeUrl], seriesTitle, slugsToCheck, uniqueId);
                }
            })
            .catch(err => console.error('[API v2 Stream Extraction Error]', err.message));

        return res.json({
            status: 'success',
            data: {
                stream_status: 'PENDING',
                message: 'Memulai proses ekstraksi video ke Azure Blob Cloud Storage...'
            }
        });
    } catch (err) {
        console.error('[API v2 Stream Error]', err.message);
        if (!res.headersSent) {
            return res.status(500).json({
                status: 'error',
                message: err.message || 'Terjadi kesalahan internal saat memproses stream.'
            });
        }
    }
}

/**
 * Controller V2 Report Broken & Failover:
 * Menghapus blob rusak dari cloud dan otomatis beralih ke provider alternatif (Nanime/Otakudesu/Kuronime).
 * Rute: POST /api/v2/stream/report-broken
 */
export async function reportBrokenV2(req, res) {
    const targetUrl = req.body?.episodeUrl || req.body?.url || req.query?.episodeUrl || req.query?.url;
    const { seriesUrl, seriesTitle, episodeTitle } = req.body || req.query || {};
    let uniqueId = req.body?.uniqueId || req.query?.uniqueId;

    if (!targetUrl) {
        return res.status(400).json({
            status: 'error',
            message: "Parameter 'episodeUrl' atau 'url' wajib diisi untuk melaporkan video rusak!"
        });
    }

    try {
        uniqueId = await resolveCanonicalUniqueId(seriesUrl, targetUrl, seriesTitle, uniqueId);
        const { seriesSlug, episodeSlug, oldSeriesSlug, slugsToCheck } = extractSlugs(targetUrl, seriesUrl, seriesTitle, uniqueId, episodeTitle);

        console.info(`[API v2 Failover] Laporan video rusak diterima untuk: ${targetUrl}. Menghapus blob lama...`);
        await invalidateAndDeleteBlob(seriesSlug, episodeSlug);
        if (oldSeriesSlug && oldSeriesSlug !== seriesSlug) {
            await invalidateAndDeleteBlob(oldSeriesSlug, episodeSlug);
        }

        const getProviderKey = (url) => {
            if (!url) return '';
            if (url.includes('otakudesu')) return 'otakudesu';
            if (url.includes('kuronime')) return 'kuronime';
            if (url.includes('nanime')) return 'nanime';
            if (url.includes('neosatsu')) return 'neosatsu';
            if (url.includes('nimegami')) return 'nimegami';
            if (url.includes('samehadaku')) return 'samehadaku';
            return '';
        };
        const brokenProv = getProviderKey(targetUrl);
        if (targetUrl) {
            globalBlacklistCache.set(`broken_url_${targetUrl}`, true);
            if (targetUrl.includes('?url=')) {
                try {
                    const dec = decodeURIComponent(targetUrl.split('?url=')[1]);
                    if (dec) globalBlacklistCache.set(`broken_url_${dec}`, true);
                } catch(e) {}
            }
        }
        if (brokenProv) {
            if (seriesSlug && episodeSlug) {
                const sList = [seriesSlug];
                const cleanSeries = seriesSlug.replace(/^(mal-|db-)\d+_/, '');
                if (cleanSeries && !sList.includes(cleanSeries)) sList.push(cleanSeries);
                if (oldSeriesSlug && !sList.includes(oldSeriesSlug)) {
                    sList.push(oldSeriesSlug);
                    const cleanOld = oldSeriesSlug.replace(/^(mal-|db-)\d+_/, '');
                    if (cleanOld && !sList.includes(cleanOld)) sList.push(cleanOld);
                }
                for (const s of sList) {
                    globalBlacklistCache.set(`broken_ep_prov_${s}_${episodeSlug}_${brokenProv}`, true);
                }
                console.info(`[API v2 Failover] Deprioritizing provider [${brokenProv.toUpperCase()}] untuk episode ini (${seriesSlug}/${episodeSlug}) agar failover mencoba web lain lebih dulu.`);
            }
            const failCount = (globalBlacklistCache.get(`fail_count_${brokenProv}`) || 0) + 1;
            globalBlacklistCache.set(`fail_count_${brokenProv}`, failCount);
            if (failCount >= 5) {
                globalBlacklistCache.set(`broken_provider_${brokenProv}`, true);
                console.warn(`[API v2 Failover] Provider [${brokenProv.toUpperCase()}] gagal ${failCount}x berturut-turut. Blacklist sementara 15 menit.`);
            } else {
                console.info(`[API v2 Failover] Blacklist URL rusak (${targetUrl}). Provider [${brokenProv.toUpperCase()}] fail count: ${failCount}/5`);
            }
        }

        // SMART SERVER-SIDE FAILOVER: Cari URL provider alternatif dari Orchestrator (force refresh jika perlu)
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
                        // Prioritas failover ke provider yang TIDAK rusak dan TIDAK diblacklist
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
                                if (candProv && candProv === brokenProv) continue; // Jangan pakai provider yang sama jika rusak total
                                if (globalBlacklistCache.get(`broken_url_${cand}`)) continue;
                                if (cand.includes('?url=')) {
                                    try {
                                        const dec = decodeURIComponent(cand.split('?url=')[1]);
                                        if (dec && globalBlacklistCache.get(`broken_url_${dec}`)) continue;
                                    } catch(e) {}
                                }
                                if (candProv && isEpisodeProviderBlacklisted(candProv, { seriesSlug, episodeSlug, oldSeriesSlug })) continue;
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

        const nextUrlToExtract = fallbackUrl || targetUrl;
        console.info(`[API v2 Failover] Memulai ekstraksi ulang dari provider alternatif: ${nextUrlToExtract}`);
        prefetchOneEpisode(seriesSlug, nextUrlToExtract, seriesTitle, 'player', oldSeriesSlug, slugsToCheck, episodeTitle, uniqueId, null, targetEpUrls)
            .then(res => {
                const nextEpUrl = req.body?.nextEpisodeUrl || req.query?.nextEpisodeUrl;
                if (res && res.success && nextEpUrl) {
                    triggerPrefetchWindow(seriesSlug, [nextEpUrl], seriesTitle, slugsToCheck, uniqueId);
                }
            })
            .catch(err => console.error('[API v2 Failover Extraction Error]', err.message));

        return res.json({
            status: 'success',
            data: {
                stream_status: 'FAILOVER_STARTED',
                message: 'File rusak telah dihapus dari cloud. Backend sedang mengunduh stream dari provider alternatif ke Azure Blob Storage...',
                fallback_url: fallbackUrl || targetUrl
            }
        });
    } catch (err) {
        console.error('[API v2 Failover Error]', err.message);
        if (!res.headersSent) {
            return res.status(500).json({
                status: 'error',
                message: err.message || 'Gagal memproses failover video.'
            });
        }
    }
}
