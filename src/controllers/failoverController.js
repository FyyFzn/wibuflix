import { resolveCanonicalUniqueId } from '../services/canonicalService.js';
import { extractSlugs } from '../services/slugService.js';
import { globalBlacklistCache } from '../services/stream/streamStateStore.js';
import { getProviderKey, blacklistEpisodeProvider } from '../services/streamRankingService.js';
import { invalidateAndDeleteBlob, cancelAllUploads } from '../services/stream/uploadProgressService.js';
import { prefetchOneEpisode, abortAndResetPrefetch, removeActiveExtractions } from '../services/prefetchService.js';

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
        if (brokenProv) {
            blacklistEpisodeProvider(brokenProv, { seriesSlug, episodeSlug, oldSeriesSlug });
            console.info(`[Report Broken] Deprioritizing/Blacklisting provider [${brokenProv.toUpperCase()}] untuk episode (${seriesSlug}/${episodeSlug}).`);
        }

        await invalidateAndDeleteBlob(slugsToCheck, episodeSlugsToCheck);
        removeActiveExtractions(slugsToCheck, episodeSlugsToCheck);
        
        abortAndResetPrefetch();
        cancelAllUploads('prefetch');

        if (url) {
            console.info(`[Report Broken] Memulai ekstraksi ulang failover untuk: ${url}`);
            prefetchOneEpisode(seriesSlug, url, seriesTitle, 'player', oldSeriesSlug, slugsToCheck, episodeTitle, uniqueId)
                .catch(err => console.error('[Report Broken Failover Error]', err.message));
        }
        
        res.json({ success: true, message: "Video rusak/tanpa subtitle berhasil dihapus dari cloud. Backend sedang mengunduh stream dari provider alternatif." });
    } catch (e) {
        console.error(`[Report Broken Error]:`, e.message);
        res.status(500).json({ success: false, message: e.message });
    }
}
