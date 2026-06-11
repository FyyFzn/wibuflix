import express from 'express';
import { extractVideoUrl, scrapeVideoServers, getAlternativeServersSamehadaku } from '../scraper/extractor.js';
import { checkUploadStatus, uploadStream, getBlobPath, getBlobUrl, markUploadFailed } from '../utils/azureUploader.js';
import { getNeosatsuServers } from '../scraper/neosatsu.js';
import { getServersInternal as getOtakuServers, getAlternativeServers as getOtakuAlternativeServers } from '../scraper/otakudesu_controller.js';

const router = express.Router();
const activeExtractions = new Set();

function extractSlugs(episodeUrl, seriesUrl) {
    let episodeSlug = '';
    let seriesSlug = '';
    
    if (episodeUrl.includes('___neosatsu_ep___')) {
        const parts = episodeUrl.split('___neosatsu_ep___');
        let seriesPart = parts[0].replace(/\/$/, '').split('/').pop() || 'neosatsu_series';
        seriesSlug = seriesPart.replace(/\.html/g, '');
        episodeSlug = parts[1];
    } else {
        let realEpUrl = episodeUrl;
        if (episodeUrl.includes('?url=')) {
            realEpUrl = decodeURIComponent(episodeUrl.split('?url=')[1]);
        }
        const cleanUrl = realEpUrl.replace(/\/$/, '');
        episodeSlug = cleanUrl.split('/').pop() || 'uncategorized_ep';
        
        if (seriesUrl) {
            let realSeriesUrl = seriesUrl;
            if (seriesUrl.includes('?url=')) {
                realSeriesUrl = decodeURIComponent(seriesUrl.split('?url=')[1]);
            }
            seriesSlug = realSeriesUrl.replace(/\/$/, '').split('/').pop() || 'uncategorized';
        } else {
            seriesSlug = episodeSlug.replace(/-episode-\d+.*$/i, '').replace(/-dan-sub-indo.*$/i, '');
        }
    }
    if (!seriesSlug) seriesSlug = 'uncategorized';

    return { seriesSlug, episodeSlug };
}

async function getServersBasedOnUrl(episodeUrl) {
    if (episodeUrl.includes('___neosatsu_ep___')) {
        return await getNeosatsuServers(episodeUrl);
    } else if (episodeUrl.includes('otakudesu') || episodeUrl.includes('/api/otakudesu/servers')) {
        let realUrl = episodeUrl;
        if (episodeUrl.includes('?url=')) {
            realUrl = decodeURIComponent(episodeUrl.split('?url=')[1]);
        }
        return await getOtakuServers(realUrl);
    } else {
        return await scrapeVideoServers(episodeUrl);
    }
}

function getResolutionGroup(serverName) {
    const nameLower = serverName.toLowerCase();
    
    // Only accept MP4. Reject MKV or x265
    if (nameLower.includes('mkv') || nameLower.includes('x265')) {
        return null;
    }
    
    if (nameLower.includes('1080') || nameLower.includes('fullhd') || nameLower.includes('full hd')) {
        return 1080;
    }
    if (nameLower.includes('720') || nameLower.includes('hd')) {
        return 720;
    }
    if (nameLower.includes('480')) {
        return 480;
    }
    if (nameLower.includes('360') || nameLower.includes('320')) {
        return 360;
    }
    return null;
}

async function triggerPrefetch(seriesSlug, nextEpisodeUrl, seriesTitle) {
    if (!nextEpisodeUrl) return;
    try {
        const { episodeSlug: nextEpisodeSlug } = extractSlugs(nextEpisodeUrl, null);
        const nextBlobPath = getBlobPath(seriesSlug, nextEpisodeSlug);
        
        const status = await checkUploadStatus(seriesSlug, nextEpisodeSlug);
        if (status === 'READY' || status === 'UPLOADING' || status === 'FAILED') {
            return;
        }

        if (activeExtractions.has(nextBlobPath)) {
            return;
        }

        console.info(`[Prefetch] Memulai prefetch untuk: ${nextEpisodeSlug}`);
        
        activeExtractions.add(nextBlobPath);
        let matchedSource = null;

        try {
            const pageData = await getServersBasedOnUrl(nextEpisodeUrl);
            const primaryServers = pageData.servers || [];
            const episodeTitle = pageData.judul || '';

            let alternativeServers = [];
            if (seriesTitle && episodeTitle && !nextEpisodeUrl.includes('___neosatsu_ep___')) {
                try {
                    if (nextEpisodeUrl.includes('otakudesu') || nextEpisodeUrl.includes('/api/otakudesu/servers')) {
                        alternativeServers = await getAlternativeServersSamehadaku(seriesTitle, episodeTitle);
                    } else {
                        alternativeServers = await getOtakuAlternativeServers(seriesTitle, episodeTitle, nextEpisodeUrl);
                    }
                } catch (altErr) {
                    console.error(`[Prefetch Alt Error] Gagal mengambil server alternatif:`, altErr.message);
                }
            }

            const primarySource = (nextEpisodeUrl.includes('otakudesu') || nextEpisodeUrl.includes('/api/otakudesu/servers')) ? 'Otakudesu' : 'Samehadaku';
            const altSource = primarySource === 'Otakudesu' ? 'Samehadaku' : 'Otakudesu';

            const taggedPrimary = (primaryServers || []).map(s => ({ ...s, source: primarySource }));
            const taggedAlternative = (alternativeServers || []).map(s => ({ ...s, source: altSource }));

            const servers = [...taggedPrimary, ...taggedAlternative];

            if (!servers || servers.length === 0) {
                console.info(`[Prefetch] Tidak ada server ditemukan untuk prefetch ${nextEpisodeSlug}`);
                markUploadFailed(seriesSlug, nextEpisodeSlug);
                return;
            }

            // Group servers by resolution
            const groups = { 1080: [], 720: [], 480: [], 360: [] };
            for (const srv of servers) {
                const resGroup = getResolutionGroup(srv.nama);
                if (resGroup && groups[resGroup]) {
                    groups[resGroup].push(srv);
                }
            }

            // Try extracting in priority order
            const resolutions = [1080, 720, 480, 360];
            for (const res of resolutions) {
                if (groups[res].length > 0) {
                    const serverNames = groups[res].map(s => s.namaHost).join(', ');
                    console.info(`[Prefetch] Menguji server ${res}p: ${serverNames}`);
                }
                for (const srv of groups[res]) {
                    try {
                        const extracted = await extractVideoUrl(srv.iframeUrl);
                        if (extracted && extracted.url && !extracted.webviewOnly) {
                            const isMp4 = !extracted.isM3U8 && !extracted.url.includes('.m3u8');
                            if (isMp4) {
                                matchedSource = {
                                    url: extracted.url,
                                    headers: extracted.headers || {}
                                };
                                console.info(`[Prefetch] Menemukan source MP4 (${res}p) dari ${srv.source || 'Primary'}: ${extracted.url}`);
                                break;
                            }
                        }
                    } catch (e) {
                        console.error(`[Prefetch] Gagal mengekstrak dari server ${srv.namaHost} (${srv.source || 'Primary'}):`, e.message);
                    }
                }
                if (matchedSource) break;
            }
        } finally {
            activeExtractions.delete(nextBlobPath);
        }

        if (matchedSource) {
            await uploadStream(matchedSource.url, matchedSource.headers, seriesSlug, nextEpisodeSlug);
        } else {
            markUploadFailed(seriesSlug, nextEpisodeSlug);
        }
    } catch (err) {
        console.error(`[Prefetch Error] Gagal memproses prefetch untuk ${nextEpisodeUrl}:`, err.message);
    }
}

// ============================================================
// RUTE 5: GET /api/extract-video?url=EMBED_URL
// ============================================================
router.get('/api/extract-video', async (req, res) => {
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
});

// ============================================================
// RUTE Baru: GET /api/smart-play
// Parameter: episodeUrl (wajib), seriesUrl, nextEpisodeUrl
// ============================================================
router.get('/api/smart-play', async (req, res) => {
    const { episodeUrl, seriesUrl, nextEpisodeUrl, seriesTitle, episodeTitle } = req.query;
    if (!episodeUrl) {
        return res.status(400).json({ success: false, error: "Parameter 'episodeUrl' wajib diisi!" });
    }

    try {
        const { seriesSlug, episodeSlug } = extractSlugs(episodeUrl, seriesUrl);

        const status = await checkUploadStatus(seriesSlug, episodeSlug);

        if (status === 'READY') {
            if (nextEpisodeUrl) {
                triggerPrefetch(seriesSlug, nextEpisodeUrl, seriesTitle);
            }
            return res.json({
                success: true,
                status: 'READY',
                url: getBlobUrl(getBlobPath(seriesSlug, episodeSlug))
            });
        }

        if (status === 'UPLOADING') {
            if (nextEpisodeUrl) {
                triggerPrefetch(seriesSlug, nextEpisodeUrl, seriesTitle);
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

        const blobPath = getBlobPath(seriesSlug, episodeSlug);
        if (activeExtractions.has(blobPath)) {
            return res.json({
                success: true,
                status: 'UPLOADING',
                message: 'Video sedang diekstrak di request lain.'
            });
        }

        // Status is FAILED or null -> Start extraction and upload process
        console.info(`[Smart-Play] Mulai ekstraksi server untuk: ${episodeUrl}`);

        activeExtractions.add(blobPath);
        let matchedSource = null;

        try {
            // Fetch primary servers and alternative servers in parallel
            let primaryPromise = getServersBasedOnUrl(episodeUrl);
            let alternativePromise = Promise.resolve([]);

            if (seriesTitle && episodeTitle && !episodeUrl.includes('___neosatsu_ep___')) {
                if (episodeUrl.includes('otakudesu') || episodeUrl.includes('/api/otakudesu/servers')) {
                    console.info(`[Smart-Play] Pencarian alternatif di Samehadaku untuk: "${seriesTitle}" - "${episodeTitle}"`);
                    alternativePromise = getAlternativeServersSamehadaku(seriesTitle, episodeTitle);
                } else {
                    console.info(`[Smart-Play] Pencarian alternatif di Otakudesu untuk: "${seriesTitle}" - "${episodeTitle}"`);
                    alternativePromise = getOtakuAlternativeServers(seriesTitle, episodeTitle, seriesUrl);
                }
            }

            const [primaryData, alternativeServers] = await Promise.all([
                primaryPromise,
                alternativePromise.catch(err => {
                    console.error(`[Smart-Play Alternative Fetch Error]:`, err.message);
                    return [];
                })
            ]);

            const primaryServers = primaryData.servers || [];

            // Mark source websites for clarity in logging / resolution priority
            const primarySource = (episodeUrl.includes('otakudesu') || episodeUrl.includes('/api/otakudesu/servers')) ? 'Otakudesu' : 'Samehadaku';
            const altSource = primarySource === 'Otakudesu' ? 'Samehadaku' : 'Otakudesu';

            const taggedPrimary = primaryServers.map(s => ({ ...s, source: primarySource }));
            const taggedAlternative = (alternativeServers || []).map(s => ({ ...s, source: altSource }));

            const servers = [...taggedPrimary, ...taggedAlternative];

            if (servers.length === 0) {
                markUploadFailed(seriesSlug, episodeSlug);
                return res.status(404).json({
                    success: false,
                    status: 'FAILED',
                    message: 'Tidak ada server download/streaming yang ditemukan di halaman episode.'
                });
            }

            // Group servers by resolution
            const groups = { 1080: [], 720: [], 480: [], 360: [] };
            for (const srv of servers) {
                const resGroup = getResolutionGroup(srv.nama);
                if (resGroup && groups[resGroup]) {
                    groups[resGroup].push(srv);
                }
            }

            // Try extracting in priority order
            const resolutions = [1080, 720, 480, 360];

            for (const resVal of resolutions) {
                if (groups[resVal].length > 0) {
                    // Urutkan server berdasarkan prioritas kecepatan dan keandalan (Mega, Wibufile > Krakenfiles)
                    groups[resVal].sort((a, b) => {
                        const score = (host) => {
                            if (!host) return 0;
                            const h = host.toLowerCase();
                            if (h.includes('mega')) return 100;
                            if (h.includes('wibufile')) return 90;
                            if (h.includes('filedon') || h.includes('filemoon') || h.includes('filelions')) return 80;
                            if (h.includes('pixeldrain')) return 70;
                            if (h.includes('acefile')) return 60;
                            if (h.includes('vidhide')) return 50;
                            if (h.includes('kraken')) return -100; // Super lambat 125 KB/s, jadikan last resort
                            return 0;
                        };
                        return score(b.namaHost) - score(a.namaHost);
                    });

                    const serverNames = groups[resVal].map(s => s.namaHost).join(', ');
                    console.info(`[Smart-Play] Menguji server ${resVal}p: ${serverNames}`);
                }
                for (const srv of groups[resVal]) {
                    try {
                        const extracted = await extractVideoUrl(srv.iframeUrl, req);
                        if (extracted && extracted.url && !extracted.webviewOnly) {
                            const isMp4 = !extracted.isM3U8 && !extracted.url.includes('.m3u8');
                            if (isMp4) {
                                matchedSource = {
                                    url: extracted.url,
                                    headers: extracted.headers || {}
                                };
                                console.info(`[Smart-Play] Menemukan source MP4 (${resVal}p) dari ${srv.source}: ${extracted.url}`);
                                break;
                            }
                        }
                    } catch (e) {
                        console.error(`[Smart-Play] Gagal mengekstrak dari server ${srv.namaHost} (${srv.source}):`, e.message);
                    }
                }
                if (matchedSource) break;
            }
        } finally {
            activeExtractions.delete(blobPath);
        }

        if (matchedSource) {
            // Start upload in background and chain prefetch
            const uploadTask = uploadStream(matchedSource.url, matchedSource.headers, seriesSlug, episodeSlug);
            
            // Trigger prefetch of next episode ONLY AFTER current upload finishes
            if (nextEpisodeUrl && uploadTask) {
                uploadTask.then(() => {
                    console.info(`[Smart-Play] Upload episode saat ini selesai. Memulai prefetch episode selanjutnya...`);
                    triggerPrefetch(seriesSlug, nextEpisodeUrl, seriesTitle);
                }).catch(err => {
                    console.error(`[Smart-Play] Upload gagal, prefetch dibatalkan:`, err.message);
                });
            }

            return res.json({
                success: true,
                status: 'UPLOADING',
                message: 'Ekstraksi berhasil. Sedang mengalirkan video ke Azure Blob.'
            });
        } else {
            markUploadFailed(seriesSlug, episodeSlug);
            return res.status(404).json({
                success: false,
                status: 'FAILED',
                message: 'Tidak ada server MP4 yang didukung untuk resolusi yang tersedia.'
            });
        }

    } catch (err) {
        console.error(`[Smart-Play Error] URL: ${episodeUrl} | STACK:`, err.stack);
        res.status(500).json({ success: false, message: err.message });
    }
});

export default router;
