import { resolveCanonicalUniqueId } from '../services/canonicalService.js';
import { extractSlugs } from '../services/slugService.js';
import { backgroundQueue } from '../utils/queueManager.js';
import QueueTask from '../models/QueueTask.js';
import { checkUploadStatusWithFallback } from '../services/stream/blobStorageService.js';
import { cancelUpload, getUploadProgress } from '../services/stream/uploadProgressService.js';

// POST /api/queue/add
    export async function queueAddHandler(req, res) {
        try {
            let { episodeUrl, seriesUrl, seriesTitle, episodeTitle, uniqueId, urls, cover } = req.body;
            if (!episodeUrl) return res.status(400).json({ success: false, error: "episodeUrl diperlukan" });
            
            uniqueId = await resolveCanonicalUniqueId(seriesUrl, episodeUrl, seriesTitle, uniqueId);
            const { seriesSlug, episodeSlug } = extractSlugs(episodeUrl, seriesUrl, seriesTitle, uniqueId, episodeTitle);
            
            // Pass urls (urlsObj) to background queue so prefetch can failover correctly
            const item = await backgroundQueue.add(episodeUrl, seriesUrl, seriesSlug, seriesTitle, episodeTitle, uniqueId, urls, cover);
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

async function enrichQueueProgress(queueItems) {
    return await Promise.all(queueItems.map(async (item) => {
        if (item.status === 'UPLOADING') {
            const { seriesSlug, episodeSlug, slugsToCheck, episodeSlugsToCheck } = extractSlugs(item.episodeUrl, item.seriesUrl, item.seriesTitle, item.uniqueId, item.episodeTitle);
            const checkInfo = await checkUploadStatusWithFallback(slugsToCheck, episodeSlugsToCheck);
            const activeSlug = checkInfo.activeSeriesSlug || seriesSlug;
            const activeEpSlug = checkInfo.activeEpisodeSlug || episodeSlug;

            item.progress = getUploadProgress(activeSlug, activeEpSlug);
        }
        return item;
    }));
}

// GET /api/queue/status
export async function queueStatusHandler(req, res) {
    try {
        const queueItems = await backgroundQueue.getStatus();
        const updatedItems = await enrichQueueProgress(queueItems);

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
        const updatedItems = await enrichQueueProgress(queueItems);

        res.write(`data: ${JSON.stringify({ success: true, queue: updatedItems })}\n\n`);
    };

    sendQueueUpdate();

    const interval = setInterval(sendQueueUpdate, 1500);

    req.on('close', () => {
        clearInterval(interval);
    });
}
