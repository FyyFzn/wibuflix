import { extractVideoUrl } from '../services/extractors/videoExtractor.js';
import { getBlobPath, getBlobUrl, checkUploadStatusWithFallback } from '../services/stream/blobStorageService.js';
import { cancelAllUploads, cancelUpload, markUploadFailed, invalidateAndDeleteBlob, getUploadProgress } from '../services/stream/uploadProgressService.js';
import { uploadStream } from '../services/stream/ffmpegStreamService.js';
import { globalBlacklistCache } from '../services/stream/streamStateStore.js';
import { resolveCanonicalUniqueId } from '../services/canonicalService.js';
import { extractSlugs } from '../services/slugService.js';
import { findBestVideoSource } from '../services/streamRankingService.js';
import { triggerPrefetchWindow, isCurrentlyExtracting, addActiveExtractions, removeActiveExtractions, proxyCache, abortAndResetPrefetch, prefetchAbortController } from '../services/prefetchService.js';
import { backgroundQueue } from '../utils/queueManager.js';
import QueueTask from '../models/QueueTask.js';

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
        } else if ((embedUrl.includes('filedon') || embedUrl.includes('pucuk') || embedUrl.includes('pixeldrain.com') || embedUrl.includes('filemoon') || embedUrl.includes('filelions') || embedUrl.includes('moonplayer')) && data?.url) {
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
    let { episodeUrl, seriesUrl, nextEpisodeUrl, seriesTitle, episodeTitle, uniqueId } = req.query;
    if (!episodeUrl) {
        return res.status(400).json({ success: false, error: "Parameter 'episodeUrl' wajib diisi!" });
    }

    uniqueId = await resolveCanonicalUniqueId(seriesUrl, episodeUrl, seriesTitle, uniqueId);

    // Susun window prefetch: [N+1, N+2] — hanya yang ada nilainya
    const prefetchWindow = [nextEpisodeUrl].filter(Boolean);

    try {
        const { seriesSlug, episodeSlug, oldSeriesSlug, slugsToCheck, episodeSlugsToCheck } = extractSlugs(episodeUrl, seriesUrl, seriesTitle, uniqueId, episodeTitle);

        const checkInfo = await checkUploadStatusWithFallback(slugsToCheck, episodeSlugsToCheck);
        const status = checkInfo.status;
        const activeSlug = checkInfo.activeSeriesSlug || seriesSlug;
        const activeEpSlug = checkInfo.activeEpisodeSlug || episodeSlug;

        if (status === 'READY') {
            if (prefetchWindow.length > 0) {
                // Selalu prefetch ke folder baru (seriesSlug)
                triggerPrefetchWindow(seriesSlug, prefetchWindow, seriesTitle, slugsToCheck, uniqueId);
            }
            return res.json({
                success: true,
                status: 'READY',
                url: getBlobUrl(getBlobPath(activeSlug, activeEpSlug))
            });
        }

        if (status === 'UPLOADING') {
            if (prefetchWindow.length > 0) {
                triggerPrefetchWindow(seriesSlug, prefetchWindow, seriesTitle, slugsToCheck, uniqueId);
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
                    // url dihapus agar player tidak memutar proxy stream dan tetap menampilkan progress upload
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

        // Status is FAILED or null -> Start extraction and upload process
        console.info(`[Smart-Play] Mulai ekstraksi server untuk: ${episodeUrl}`);

        addActiveExtractions(slugsToCheck, episodeSlugsToCheck);
        let matchedSource = null;

        try {
            const result = await findBestVideoSource(episodeUrl, seriesTitle, episodeTitle, '[Smart-Play]', req, null, new Set(), { seriesSlug, episodeSlug });
            matchedSource = result.matchedSource;

            if (!matchedSource) {
                removeActiveExtractions(slugsToCheck, episodeSlugsToCheck);
                markUploadFailed(seriesSlug, episodeSlug);
                return res.status(404).json({
                    success: false,
                    status: 'FAILED',
                    message: result.error || 'Tidak ada server download/streaming yang ditemukan di halaman episode.'
                });
            }
        } catch (err) {
            removeActiveExtractions(slugsToCheck, episodeSlugsToCheck);
            throw err;
        }

        if (matchedSource) {
            // Start upload in background with 5x retry loop across candidate servers
            const runBackgroundUpload = async () => {
                const maxAttempts = 5;
                let currentSource = matchedSource;
                const excludedServers = new Set();
                for (let attempt = 1; attempt <= maxAttempts; attempt++) {
                    try {
                        if (attempt > 1) {
                            console.info(`[Smart-Play] Mencoba ulang upload latar belakang (${attempt}/${maxAttempts})...`);
                            const res = await findBestVideoSource(episodeUrl, seriesTitle, episodeTitle, `[Smart-Play Retry ${attempt}/${maxAttempts}]`, req, null, excludedServers, { seriesSlug, episodeSlug });
                            currentSource = res.matchedSource;
                            if (!currentSource) {
                                throw new Error(res.error || 'Tidak ada server cadangan lain.');
                            }
                        }
                        await uploadStream(currentSource.url, currentSource.headers, seriesSlug, episodeSlug, 'player');
                        removeActiveExtractions(slugsToCheck, episodeSlugsToCheck);
                        if (prefetchWindow.length > 0) {
                            console.info(`[Smart-Play] Upload selesai. Memulai prefetch window [${prefetchWindow.length} episode]...`);
                            triggerPrefetchWindow(seriesSlug, prefetchWindow, seriesTitle, slugsToCheck, uniqueId);
                        }
                        return;
                    } catch (err) {
                        if (currentSource) {
                            if (currentSource.server) {
                                excludedServers.add(currentSource.server.toString().toLowerCase());
                                globalBlacklistCache.set(`broken_srv_${currentSource.server.toString().toLowerCase()}`, true, 900);
                            }
                            if (currentSource.host) {
                                excludedServers.add(currentSource.host.toString().toLowerCase());
                                globalBlacklistCache.set(`broken_host_${currentSource.host.toString().toLowerCase()}`, true, 900);
                            }
                        }
                        const isCanceled = err.message === 'UPLOAD_CANCELLED' || err.message?.toLowerCase().includes('cancel') || err.code === 'ERR_CANCELED' || err.name === 'AbortError' || (prefetchAbortController && prefetchAbortController.signal && prefetchAbortController.signal.aborted);
                        if (isCanceled) {
                            console.info(`[Smart-Play] Upload dibatalkan oleh pengguna (cancel/exit app). Menghentikan proses retry.`);
                            removeActiveExtractions(slugsToCheck, episodeSlugsToCheck);
                            return;
                        }
                        console.error(`[Smart-Play] Upload latar belakang gagal pada percobaan ${attempt}/${maxAttempts}:`, err.message);
                        if (attempt === maxAttempts) {
                            removeActiveExtractions(slugsToCheck, episodeSlugsToCheck);
                            markUploadFailed(seriesSlug, episodeSlug);
                        } else {
                            await new Promise(r => setTimeout(r, 3000));
                        }
                    }
                }
            };
            runBackgroundUpload();

            const baseUrl = `${req.protocol}://${req.get('host')}`;
            let proxyUrl = matchedSource.url;
            if (matchedSource.headers && matchedSource.headers.token) {
                proxyUrl = `${baseUrl}/api/proxy/kraken?url=${encodeURIComponent(matchedSource.url)}&token=${encodeURIComponent(matchedSource.headers.token)}&referer=${encodeURIComponent(matchedSource.headers.Referer || '')}`;
            } else if (!matchedSource.url.includes('.m3u8')) {
                proxyUrl = `${baseUrl}/api/proxy/filedon?url=${encodeURIComponent(matchedSource.url)}`;
            }

            // Simpan proxy URL sementara ke cache (opsional)
            proxyCache.set(`proxy_${seriesSlug}_${episodeSlug}`, proxyUrl);

            return res.json({
                success: true,
                status: 'UPLOADING',
                // url dihapus agar player tidak memutar proxy stream dan tetap menampilkan progress upload
                message: 'Video sedang dialirkan ke Azure Blob (Proxy dimatikan agar progress terlihat).'
            });
        } else {
            markUploadFailed(seriesSlug, episodeSlug);
            return res.status(404).json({
                success: false,
                status: 'FAILED',
                message: 'Tidak ada server MP4 atau M3U8 yang didukung untuk resolusi yang tersedia.'
            });
        }

    } catch (err) {
        console.error(`[Smart-Play Error] URL: ${episodeUrl} | STACK:`, err.stack);
        res.status(500).json({ success: false, message: err.message });
    }
}

// POST /api/cancel-uploads
export function cancelUploadsHandler(req, res) {
    try {
        abortAndResetPrefetch();
        const count = cancelAllUploads('player') + cancelAllUploads('prefetch');
        res.json({ success: true, message: `Berhasil membatalkan ${count} upload aktif.` });
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
    
    // Batalkan juga prefetch yang sedang berjalan karena user sudah keluar dari player
    abortAndResetPrefetch();
    cancelAllUploads('prefetch');
    
    return res.json({ success: true });
}

// ALL /api/report-broken, /report-broken
export async function reportBrokenHandler(req, res) {
    try {
        const body = req.body || {};
        const query = req.query || {};
        let url = body.url || body.episodeUrl || body.embedUrl || body.videoUrl || query.url || query.episodeUrl || query.embedUrl || query.videoUrl;
        let seriesUrl = body.seriesUrl || query.seriesUrl;
        let seriesTitle = body.seriesTitle || query.seriesTitle;
        let uniqueId = body.uniqueId || query.uniqueId;
        let episodeTitle = body.episodeTitle || query.episodeTitle;
        let currentServer = body.currentServer || query.currentServer;

        if (!url) {
            console.warn(`[Report Broken] ⚠️ Gagal: Laporan diterima namun parameter URL kosong! Body: ${JSON.stringify(body)} | Query: ${JSON.stringify(query)}`);
            return res.status(400).json({ success: false, message: "URL diperlukan" });
        }

        uniqueId = await resolveCanonicalUniqueId(seriesUrl, url, seriesTitle, uniqueId);
        const { seriesSlug, episodeSlug, oldSeriesSlug, slugsToCheck, episodeSlugsToCheck } = extractSlugs(url, seriesUrl, seriesTitle, uniqueId, episodeTitle);
        
        console.warn(`[Report Broken] ⚠️ Laporan dari pengguna untuk video: "${episodeTitle || url}" (Server: ${currentServer || 'Unknown'})`);
        
        const getProviderKey = (u) => {
            if (!u) return '';
            for (const p of ['otakudesu', 'kuronime', 'nanime', 'neosatsu', 'nimegami', 'samehadaku']) {
                if (u.includes(p)) return p;
            }
            return '';
        };
        const brokenProv = getProviderKey(url);
        if (url) {
            globalBlacklistCache.set(`broken_url_${url}`, true);
            if (url.includes('?url=')) {
                try {
                    const dec = decodeURIComponent(url.split('?url=')[1]);
                    if (dec) globalBlacklistCache.set(`broken_url_${dec}`, true);
                } catch(e) {}
            }
        }
        if (brokenProv && seriesSlug && episodeSlug) {
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
            console.info(`[Report Broken] Deprioritizing/Blacklisting provider [${brokenProv.toUpperCase()}] untuk episode (${seriesSlug}/${episodeSlug}).`);
        }

        // Hapus blob dari Azure dan bersihkan cache agar upload baru dari server lain bisa berjalan
        await invalidateAndDeleteBlob(slugsToCheck, episodeSlugsToCheck);
        removeActiveExtractions(slugsToCheck, episodeSlugsToCheck);
        
        // Batalkan juga prefetch yang sedang berjalan agar tidak membuang resource VPS
        abortAndResetPrefetch();
        cancelAllUploads('prefetch');
        
        res.json({ success: true, message: "Video rusak/tanpa subtitle berhasil dihapus dari cloud. Silakan ganti server." });
    } catch (e) {
        console.error(`[Report Broken Error]:`, e.message);
        res.status(500).json({ success: false, message: e.message });
    }
}

// POST /api/queue/add
export async function queueAddHandler(req, res) {
    try {
        let { episodeUrl, seriesUrl, seriesTitle, episodeTitle, uniqueId } = req.body;
        if (!episodeUrl) return res.status(400).json({ success: false, error: "episodeUrl diperlukan" });
        
        uniqueId = await resolveCanonicalUniqueId(seriesUrl, episodeUrl, seriesTitle, uniqueId);
        const { seriesSlug, episodeSlug } = extractSlugs(episodeUrl, seriesUrl, seriesTitle, uniqueId, episodeTitle);
        
        const item = await backgroundQueue.add(episodeUrl, seriesUrl, seriesSlug, seriesTitle, episodeTitle, uniqueId);
        res.json({ success: true, item });
    } catch (e) {
        console.error(`[Queue Add Error]:`, e.message);
        res.status(500).json({ success: false, message: e.message });
    }
}

// POST /api/queue/prioritize
export async function queuePrioritizeHandler(req, res) {
    try {
        const { id } = req.body;
        await backgroundQueue.prioritize(id);
        res.json({ success: true });
    } catch (e) {
        console.error(`[Queue Prioritize Error]:`, e.message);
        res.status(500).json({ success: false });
    }
}

// POST /api/queue/cancel
export async function queueCancelHandler(req, res) {
    const { id } = req.body;
    
    try {
        const task = await QueueTask.findOne({ id });
        if (task && task.status === 'UPLOADING') {
            const { seriesSlug, episodeSlug } = extractSlugs(task.episodeUrl, task.seriesUrl, task.seriesTitle, task.uniqueId, task.episodeTitle);
            
            if (seriesSlug && episodeSlug) {
                cancelUpload(seriesSlug, episodeSlug);
                console.info(`[Queue] Upload dibatalkan untuk ${episodeSlug}`);
            }
        }
        await backgroundQueue.cancel(id);
        res.json({ success: true });
    } catch (e) {
        console.error(`[Queue] Gagal membatalkan task ${id}:`, e.message);
        res.status(500).json({ success: false });
    }
}

// GET /api/queue/status
export async function queueStatusHandler(req, res) {
    try {
        const queueItems = await backgroundQueue.getStatus();
        
        const updatedItems = await Promise.all(queueItems.map(async (item) => {
            if (item.status === 'UPLOADING') {
                const { seriesSlug, episodeSlug, slugsToCheck, episodeSlugsToCheck } = extractSlugs(item.episodeUrl, item.seriesUrl, item.seriesTitle, item.uniqueId, item.episodeTitle);
                const checkInfo = await checkUploadStatusWithFallback(slugsToCheck, episodeSlugsToCheck);
                const activeSlug = checkInfo.activeSeriesSlug || seriesSlug;
                const activeEpSlug = checkInfo.activeEpisodeSlug || episodeSlug;

                item.progress = getUploadProgress(activeSlug, activeEpSlug);
            }
            return item;
        }));

        res.json({ success: true, queue: updatedItems });
    } catch (e) {
        console.error(`[Queue Status Error]:`, e.message);
        res.status(500).json({ success: false, queue: [] });
    }
}

// GET /api/queue/stream
export function queueStreamHandler(req, res) {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    const sendQueueUpdate = async () => {
        const queueItems = await backgroundQueue.getStatus();
        
        // Update real-time progress untuk item yang UPLOADING
        const updatedItems = await Promise.all(queueItems.map(async (item) => {
            if (item.status === 'UPLOADING') {
                const { seriesSlug, episodeSlug, slugsToCheck, episodeSlugsToCheck } = extractSlugs(item.episodeUrl, item.seriesUrl, item.seriesTitle, item.uniqueId, item.episodeTitle);
                const checkInfo = await checkUploadStatusWithFallback(slugsToCheck, episodeSlugsToCheck);
                const activeSlug = checkInfo.activeSeriesSlug || seriesSlug;
                const activeEpSlug = checkInfo.activeEpisodeSlug || episodeSlug;

                item.progress = getUploadProgress(activeSlug, activeEpSlug);
            }
            return item;
        }));

        res.write(`data: ${JSON.stringify({ success: true, queue: updatedItems })}\n\n`);
    };

    // Kirim data langsung saat koneksi dibuka
    sendQueueUpdate();

    // Kirim update setiap 1.5 detik
    const interval = setInterval(sendQueueUpdate, 1500);

    req.on('close', () => {
        clearInterval(interval);
    });
}
