import { extractSlugs, prefetchOneEpisode, resolveCanonicalUniqueId } from '../routes/extract.js';
import { checkUploadStatusWithFallback, getBlobPath, getBlobUrl, getUploadProgress, invalidateAndDeleteBlob } from '../utils/azureUploader.js';
import { getUnifiedAnimeEpisodes } from '../services/animeOrchestrator.js';
import { extractEpNum } from '../utils/stringUtils.js';

/**
 * Controller V2 Stream:
 * Menjamin 100% Azure Blob Streaming. Frontend tidak menerima direct link eksternal atau iframe.
 * Rute: GET /api/v2/stream
 */
export async function getV2Stream(req, res) {
    let { episodeUrl, url, seriesUrl, nextEpisodeUrl, seriesTitle, episodeTitle, uniqueId } = req.query;
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

        // 1. JIKA SUDAH READY DI AZURE BLOB -> KEMBALIKAN URL BLOB
        if (status === 'READY') {
            return res.json({
                status: 'success',
                data: {
                    stream_status: 'READY',
                    url: getBlobUrl(getBlobPath(activeSlug, activeEpSlug))
                }
            });
        }

        // 2. JIKA SEDANG UPLOAD -> KEMBALIKAN PROGRESS (Tanpa fallback proxy/webview!)
        if (status === 'UPLOADING') {
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
        console.info(`[API v2 Stream] Memulai ekstraksi video ke Azure Blob untuk: ${targetUrl}`);
        prefetchOneEpisode(seriesSlug, targetUrl, seriesTitle, 'player', oldSeriesSlug, slugsToCheck, episodeTitle, uniqueId)
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

        // SMART SERVER-SIDE FAILOVER: Cari URL provider alternatif dari Orchestrator
        let fallbackUrl = null;
        try {
            const epNum = extractEpNum(episodeTitle || targetUrl);
            if (epNum != null) {
                const animeData = await getUnifiedAnimeEpisodes({ targetUrl: targetUrl, forceRefresh: false });
                if (animeData && animeData.episodes) {
                    const targetEp = animeData.episodes.find(e => e.num === epNum);
                    if (targetEp && targetEp.urls) {
                        // Prioritas failover: Kuronime -> Samehadaku -> Otakudesu -> Nanime -> Neosatsu
                        const candidates = [
                            targetEp.urls.kuronime,
                            targetEp.urls.samehadaku,
                            targetEp.urls.otakudesu,
                            targetEp.urls.nanime,
                            targetEp.urls.neosatsu
                        ].filter(Boolean);

                        for (const cand of candidates) {
                            if (cand && cand !== targetUrl) {
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
        prefetchOneEpisode(seriesSlug, nextUrlToExtract, seriesTitle, 'player', oldSeriesSlug, slugsToCheck, episodeTitle, uniqueId)
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
