// ── Facade & Pure Controller: v2StreamController.js ──
// Sesuai dengan Single Responsibility Principle (SRP), pengayaan metadata dan pencarian failover
// telah dipisahkan ke dalam modul spesifik:
// 1. streamMetadataEnricher.js: Memperkaya metadata navigasi (prev/next) dan daftar server cloud.
// 2. streamFailoverService.js: Resolusi server alternatif dari Orchestrator saat provider utama blacklisted/rusak.

import { resolveCanonicalUniqueId } from '../services/canonicalService.js';
import { extractSlugs } from '../services/slugService.js';
import { prefetchOneEpisode, triggerPrefetchWindow } from '../services/prefetchService.js';
import { checkUploadStatusWithFallback, getBlobPath, getBlobUrl } from '../services/stream/blobStorageService.js';
import { getUploadProgress, invalidateAndDeleteBlob } from '../services/stream/uploadProgressService.js';
import { globalBlacklistCache, uploadCache } from '../services/stream/streamStateStore.js';
import { getProviderKey, blacklistEpisodeProvider, checkUrlBlacklisted } from '../services/streamRankingService.js';
import { enrichStreamMetadata } from '../services/stream/streamMetadataEnricher.js';
import { findAlternativeProviderCandidate, resolveInitialAlternative } from '../services/stream/streamFailoverService.js';

export { enrichStreamMetadata };

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

        if (status === 'READY' && !forceRefresh) {
            if (nextEpisodeUrl && nextEpisodeUrl !== targetUrl && nextEpisodeUrl !== episodeUrl && nextEpisodeUrl !== url) {
                triggerPrefetchWindow(seriesSlug, [nextEpisodeUrl], seriesTitle, slugsToCheck, uniqueId);
            }
            const enrichedData = await enrichStreamMetadata({
                stream_status: 'READY',
                url: getBlobUrl(getBlobPath(activeSlug, activeEpSlug))
            }, targetUrl, seriesTitle, episodeTitle, uniqueId);
            return res.json({
                status: 'success',
                data: enrichedData
            });
        }

        if (status === 'READY' && forceRefresh) {
            console.info(`[API v2 Stream] Force Refresh diminta! Mengabaikan cache Azure Blob dan melakukan ekstraksi ulang untuk: ${targetUrl}`);
        }

        if (status === 'UPLOADING') {
            if (nextEpisodeUrl && nextEpisodeUrl !== targetUrl && nextEpisodeUrl !== episodeUrl && nextEpisodeUrl !== url) {
                triggerPrefetchWindow(seriesSlug, [nextEpisodeUrl], seriesTitle, slugsToCheck, uniqueId);
            }
            const progress = getUploadProgress(activeSlug, activeEpSlug) || 0;
            const enrichedData = await enrichStreamMetadata({
                stream_status: 'UPLOADING',
                message: 'Video sedang diproses dan diunggah ke Azure Blob Cloud Storage...',
                progress: progress
            }, targetUrl, seriesTitle, episodeTitle, uniqueId);
            return res.json({
                status: 'success',
                data: enrichedData
            });
        }

        let urlsObj = null;
        if (urls) {
            try { urlsObj = typeof urls === 'string' ? JSON.parse(urls) : urls; } catch (e) {}
        }

        let extractionUrl = targetUrl;
        const currentProv = getProviderKey(targetUrl);
        const isMainUrlOrProvBroken = checkUrlBlacklisted(targetUrl, { seriesSlug, episodeSlug, oldSeriesSlug });

        if (isMainUrlOrProvBroken) {
            console.info(`[API v2 Stream] URL/Provider ${currentProv || targetUrl} terdeteksi blacklisted/rusak untuk episode ini. Mencari provider alternatif...`);
            const altRes = await resolveInitialAlternative({ targetUrl, seriesTitle, episodeTitle, uniqueId, currentProv, seriesSlug, episodeSlug, oldSeriesSlug, urlsObj });
            extractionUrl = altRes.extractionUrl;
            urlsObj = altRes.updatedUrlsObj;
        }

        if (process.env.NODE_ENV !== 'test' && !process.env.NODE_TEST_CONTEXT) {
            console.info(`[API v2 Stream] Memulai ekstraksi video ke Azure Blob untuk: ${extractionUrl}`);
            prefetchOneEpisode(seriesSlug, extractionUrl, seriesTitle, 'player', oldSeriesSlug, slugsToCheck, episodeTitle, uniqueId, null, urlsObj)
                .then(res => {
                    if (res && res.success && nextEpisodeUrl) {
                        console.info(`[API v2 Stream] Upload episode selesai. Memulai prefetch episode berikutnya: ${nextEpisodeUrl}`);
                        triggerPrefetchWindow(seriesSlug, [nextEpisodeUrl], seriesTitle, slugsToCheck, uniqueId);
                    }
                })
                .catch(err => console.error('[API v2 Stream Extraction Error]', err.message));
        }

        const enrichedData = await enrichStreamMetadata({
            stream_status: 'PENDING',
            message: 'Memulai proses ekstraksi video ke Azure Blob Cloud Storage...'
        }, targetUrl, seriesTitle, episodeTitle, uniqueId);
        return res.json({
            status: 'success',
            data: enrichedData
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
    const clientIp = req.headers['x-forwarded-for'] || req.socket?.remoteAddress || 'unknown_ip';
    const ipRateKey = `rate_report_${clientIp}`;
    const currentReports = (globalBlacklistCache.get(ipRateKey) || 0) + 1;
    if (currentReports > 10) {
        return res.status(429).json({
            status: 'error',
            message: 'Terlalu banyak laporan dari IP Anda. Silakan coba beberapa saat lagi.'
        });
    }
    globalBlacklistCache.set(ipRateKey, currentReports, 600);

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

        const actualSourceProv = uploadCache.get(`blob_source_prov_${seriesSlug}_${episodeSlug}`);
        const brokenProv = actualSourceProv || getProviderKey(targetUrl);
        if (targetUrl) {
            globalBlacklistCache.set(`broken_url_${targetUrl}`, true, 1800);
            if (targetUrl.includes('?url=')) {
                try {
                    const dec = decodeURIComponent(targetUrl.split('?url=')[1]);
                    if (dec) globalBlacklistCache.set(`broken_url_${dec}`, true, 1800);
                } catch(e) {}
            }
        }
        if (brokenProv) {
            blacklistEpisodeProvider(brokenProv, { seriesSlug, episodeSlug, oldSeriesSlug });
            console.info(`[API v2 Failover] Deprioritizing provider [${brokenProv.toUpperCase()}] (actual source: ${actualSourceProv || 'default'}) untuk episode ini (${seriesSlug}/${episodeSlug}) agar failover mencoba web lain lebih dulu.`);
        }

        const altRes = await findAlternativeProviderCandidate({ targetUrl, seriesTitle, episodeTitle, uniqueId, brokenProv, seriesSlug, episodeSlug, oldSeriesSlug });
        const fallbackUrl = altRes.fallbackUrl;
        const targetEpUrls = altRes.targetEpUrls;

        if (targetUrl && actualSourceProv && actualSourceProv !== getProviderKey(targetUrl)) {
            const actualUrl = targetEpUrls?.[actualSourceProv];
            if (actualUrl) {
                globalBlacklistCache.set(`broken_url_${actualUrl}`, true, 1800);
            }
        }

        const nextUrlToExtract = fallbackUrl || targetUrl;
        if (process.env.NODE_ENV !== 'test' && !process.env.NODE_TEST_CONTEXT) {
            console.info(`[API v2 Failover] Memulai ekstraksi ulang dari provider alternatif: ${nextUrlToExtract}`);
            prefetchOneEpisode(seriesSlug, nextUrlToExtract, seriesTitle, 'player', oldSeriesSlug, slugsToCheck, episodeTitle, uniqueId, null, targetEpUrls)
                .then(res => {
                    const nextEpUrl = req.body?.nextEpisodeUrl || req.query?.nextEpisodeUrl;
                    if (res && res.success && nextEpUrl) {
                        triggerPrefetchWindow(seriesSlug, [nextEpUrl], seriesTitle, slugsToCheck, uniqueId);
                    }
                })
                .catch(err => console.error('[API v2 Failover Extraction Error]', err.message));
        }

        const enrichedData = await enrichStreamMetadata({
            stream_status: 'FAILOVER_STARTED',
            message: 'File rusak telah dihapus dari cloud. Backend sedang mengunduh stream dari provider alternatif ke Azure Blob Storage...',
            fallback_url: fallbackUrl || targetUrl
        }, targetUrl, seriesTitle, episodeTitle, uniqueId);
        return res.json({
            status: 'success',
            data: enrichedData
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
