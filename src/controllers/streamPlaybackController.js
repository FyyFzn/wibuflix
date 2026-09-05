import { extractVideoUrl } from '../services/extractors/videoExtractor.js';
import { getBlobPath, getBlobUrl, checkUploadStatusWithFallback } from '../services/stream/blobStorageService.js';
import { cancelUploadsForSeries, cancelUpload, getUploadProgress } from '../services/stream/uploadProgressService.js';
import { resolveCanonicalUniqueId } from '../services/canonicalService.js';
import { extractSlugs } from '../services/slugService.js';
import { prefetchOneEpisode, triggerPrefetchWindow, isCurrentlyExtracting, proxyCache, abortAndResetPrefetch, removeActiveExtractions } from '../services/prefetchService.js';

// GET /api/extract-video?url=EMBED_URL
export async function extractVideoHandler(req, res) {
    const embedUrl = req.query.url;
    if (!embedUrl) return res.status(400).json({ success: false, error: "Parameter 'url' wajib diisi!" });

    try {
        const data = await extractVideoUrl(embedUrl, req);

        if (!data || !data.url) {
            console.info(`[Extract-Video] Ekstraksi gagal untuk: ${embedUrl}`);
            return res.json({ success: false, message: 'Ekstraksi URL video gagal. Sistem hanya mendukung pemutaran MP4 (Blob).' });
        }

        let finalUrl = data.url;

        if (data?.headers?.token && data?.url) {
            const baseUrl = `${req.protocol}://${req.get('host')}`;
            finalUrl = `${baseUrl}/api/proxy/kraken?url=${encodeURIComponent(data.url)}&token=${encodeURIComponent(data.headers.token)}&referer=${encodeURIComponent(data.headers.Referer || '')}`;
        } else if ((embedUrl.includes('filedon') || embedUrl.includes('pucuk') || embedUrl.includes('pixeldrain.com') || embedUrl.includes('filemoon') || embedUrl.includes('filelions') || embedUrl.includes('moonplayer') || embedUrl.includes('animeverse') || embedUrl.includes('ylnime')) && data?.url) {
            const baseUrl = `${req.protocol}://${req.get('host')}`;
            finalUrl = `${baseUrl}/api/proxy/filedon?url=${encodeURIComponent(data.url)}`;
        }

        res.json({
            success: true,
            url: finalUrl,
            headers: data?.headers || undefined
        });
    } catch (err) {
        console.error(`[Extractor Error] URL: ${embedUrl} | STACK:`, err.stack);
        res.status(500).json({ success: false, message: err.message });
    }
}

// GET /api/smart-play
export async function smartPlayHandler(req, res) {
    let { episodeUrl, seriesUrl, nextEpisodeUrl, seriesTitle, episodeTitle, uniqueId, urls } = req.query;
    if (!episodeUrl) {
        return res.status(400).json({ success: false, error: "Parameter 'episodeUrl' wajib diisi!" });
    }

    uniqueId = await resolveCanonicalUniqueId(seriesUrl, episodeUrl, seriesTitle, uniqueId);
    const prefetchWindow = [nextEpisodeUrl].filter(Boolean);

    try {
        const { seriesSlug, episodeSlug, oldSeriesSlug, slugsToCheck, episodeSlugsToCheck } = extractSlugs(episodeUrl, seriesUrl, seriesTitle, uniqueId, episodeTitle);

        const checkInfo = await checkUploadStatusWithFallback(slugsToCheck, episodeSlugsToCheck);
        const status = checkInfo.status;
        const activeSlug = checkInfo.activeSeriesSlug || seriesSlug;
        const activeEpSlug = checkInfo.activeEpisodeSlug || episodeSlug;

        if (status === 'READY') {
            const validPrefetch = prefetchWindow.filter(u => u && u !== episodeUrl && u !== req.query.url);
            if (validPrefetch.length > 0) {
                triggerPrefetchWindow(seriesSlug, validPrefetch, seriesTitle, slugsToCheck, uniqueId);
            }
            return res.json({
                success: true,
                status: 'READY',
                url: getBlobUrl(getBlobPath(activeSlug, activeEpSlug))
            });
        }

        // Video dari host yang memblokir datacenter (seperti YLnime/animeverse.id)
        // URL dikembalikan langsung agar browser user bisa memutarnya tanpa melalui Azure.
        if (status === 'DIRECT' && checkInfo.directUrl) {
            return res.json({
                success: true,
                status: 'READY',
                url: checkInfo.directUrl
            });
        }

        if (status === 'UPLOADING') {
            const validPrefetch = prefetchWindow.filter(u => u && u !== episodeUrl && u !== req.query.url);
            if (validPrefetch.length > 0) {
                triggerPrefetchWindow(seriesSlug, validPrefetch, seriesTitle, slugsToCheck, uniqueId);
            }

            let cachedProxyUrl = proxyCache.get(`proxy_${seriesSlug}_${episodeSlug}`);
            if (!cachedProxyUrl && proxyCache.has(`prefetch_src_${seriesSlug}_${episodeSlug}`)) {
                const src = proxyCache.get(`prefetch_src_${seriesSlug}_${episodeSlug}`);
                const baseUrl = `${req.protocol}://${req.get('host')}`;
                if (src.headers && src.headers.token) {
                    cachedProxyUrl = `${baseUrl}/api/proxy/kraken?url=${encodeURIComponent(src.url)}&token=${encodeURIComponent(src.headers.token)}&referer=${encodeURIComponent(src.headers.Referer || '')}`;
                } else {
                    cachedProxyUrl = `${baseUrl}/api/proxy/filedon?url=${encodeURIComponent(src.url)}`;
                }
            }

            if (cachedProxyUrl) {
                return res.json({
                    success: true,
                    status: 'UPLOADING',
                    message: 'Video sedang dialirkan ke Azure Blob (Proxy dimatikan agar progress terlihat).'
                });
            }

            return res.json({
                success: true,
                status: 'UPLOADING',
                message: 'Video sedang dialirkan ke Azure Blob.'
            });
        }

        if (status === 'FAILED') {
            return res.json({
                success: true,
                status: 'FAILED',
                message: 'Ekstraksi video gagal sebelumnya. Menggunakan fallback server.'
            });
        }

        if (isCurrentlyExtracting(slugsToCheck, episodeSlugsToCheck)) {
            return res.json({
                success: true,
                status: 'UPLOADING',
                message: 'Video sedang diekstrak di request lain.'
            });
        }

        console.info(`[Smart-Play] Mulai ekstraksi server untuk: ${episodeUrl}`);

        let urlsObj = null;
        if (urls) {
            try { urlsObj = typeof urls === 'string' ? JSON.parse(urls) : urls; } catch (e) {}
        }

        prefetchOneEpisode(seriesSlug, episodeUrl, seriesTitle, 'player', oldSeriesSlug, slugsToCheck, episodeTitle, uniqueId, null, urlsObj)
            .then(res => {
                if (res && res.success && prefetchWindow.length > 0) {
                    console.info(`[Smart-Play] Upload selesai. Memulai prefetch window [${prefetchWindow.length} episode]...`);
                    triggerPrefetchWindow(seriesSlug, prefetchWindow, seriesTitle, slugsToCheck, uniqueId);
                }
            })
            .catch(err => console.error('[Smart-Play Extraction Error]', err.message));

        return res.json({
            success: true,
            status: 'UPLOADING',
            message: 'Video sedang dialirkan ke Azure Blob.'
        });

    } catch (err) {
        console.error(`[Smart-Play Error] URL: ${episodeUrl} | STACK:`, err.stack);
        res.status(500).json({ success: false, message: err.message });
    }
}

// POST /api/cancel-uploads
export async function cancelUploadsHandler(req, res) {
    try {
        const body = req.body || {};
        const query = req.query || {};
        const url = body.url || body.episodeUrl || query.url || query.episodeUrl;
        const seriesUrl = body.seriesUrl || query.seriesUrl;
        const seriesTitle = body.seriesTitle || query.seriesTitle;
        const uniqueId = body.uniqueId || query.uniqueId;

        if (!url && !seriesUrl && !seriesTitle && !uniqueId) {
            return res.status(400).json({ 
                success: false, 
                message: "Parameter series/episode (url/seriesUrl/uniqueId) wajib disertakan untuk membatalkan upload secara terisolasi." 
            });
        }

        const { slugsToCheck } = extractSlugs(url || seriesUrl, seriesUrl, seriesTitle, uniqueId, null);
        abortAndResetPrefetch(slugsToCheck);
        const count = cancelUploadsForSeries(slugsToCheck, 'player') + cancelUploadsForSeries(slugsToCheck, 'prefetch');
        res.json({ success: true, message: `Berhasil membatalkan ${count} upload aktif untuk series/episode tersebut.` });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
}

// GET /api/upload-status
export async function uploadStatusHandler(req, res) {
    try {
        let { episodeUrl, seriesUrl, seriesTitle, uniqueId, episodeTitle } = req.query;
        if (!episodeUrl) return res.status(400).json({ success: false, message: "URL required" });
        
        uniqueId = await resolveCanonicalUniqueId(seriesUrl, episodeUrl, seriesTitle, uniqueId);
        const { seriesSlug, episodeSlug, slugsToCheck, episodeSlugsToCheck } = extractSlugs(episodeUrl, seriesUrl, seriesTitle, uniqueId, episodeTitle);
        const checkInfo = await checkUploadStatusWithFallback(slugsToCheck, episodeSlugsToCheck);
        const activeSlug = checkInfo.activeSeriesSlug || seriesSlug;
        const activeEpSlug = checkInfo.activeEpisodeSlug || episodeSlug;

        const progressMessage = getUploadProgress(activeSlug, activeEpSlug);
        res.json({ success: true, progressMessage });
    } catch (e) {
        console.error(`[Smart-Play Error]:`, e.message);
        return res.status(500).json({ success: false, status: 'FAILED', message: e.message });
    }
}

// ALL /api/cancel-stream, /cancel-stream
export async function cancelStreamHandler(req, res) {
    const body = req.body || {};
    const query = req.query || {};
    let url = body.url || body.episodeUrl || query.url || query.episodeUrl;
    let seriesUrl = body.seriesUrl || query.seriesUrl;
    let seriesTitle = body.seriesTitle || query.seriesTitle;
    let uniqueId = body.uniqueId || query.uniqueId;
    let episodeTitle = body.episodeTitle || query.episodeTitle;

    if (!url) return res.json({ success: false });
    
    uniqueId = await resolveCanonicalUniqueId(seriesUrl, url, seriesTitle, uniqueId);
    const { seriesSlug, episodeSlug, slugsToCheck, episodeSlugsToCheck } = extractSlugs(url, seriesUrl, seriesTitle, uniqueId, episodeTitle);
    const checkInfo = await checkUploadStatusWithFallback(slugsToCheck, episodeSlugsToCheck);
    const activeSlug = checkInfo.activeSeriesSlug || seriesSlug;
    const activeEpSlug = checkInfo.activeEpisodeSlug || episodeSlug;

    console.info(`[Smart-Play] Eksplisit cancel dari client untuk: ${activeEpSlug}`);
    cancelUpload(activeSlug, activeEpSlug);
    removeActiveExtractions(slugsToCheck, episodeSlugsToCheck);
    
    abortAndResetPrefetch(slugsToCheck);
    cancelUploadsForSeries(slugsToCheck, 'prefetch');
    
    return res.json({ success: true });
}
