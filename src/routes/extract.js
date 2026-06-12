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
    
    // Tolak format x265/HEVC karena sangat memberatkan performa HP (software decoding)
    if (nameLower.includes('x265') || nameLower.includes('hevc')) {
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

/**
 * Prefetch satu episode tertentu ke Azure Blob.
 * Return true jika berhasil memulai upload, false jika sudah ada/skip.
 */
async function prefetchOneEpisode(seriesSlug, episodeUrl, seriesTitle) {
    const { episodeSlug } = extractSlugs(episodeUrl, null);
    const blobPath = getBlobPath(seriesSlug, episodeSlug);

    const status = await checkUploadStatus(seriesSlug, episodeSlug);
    if (status === 'READY' || status === 'UPLOADING' || status === 'FAILED') {
        console.info(`[Prefetch] Skip ${episodeSlug} — status: ${status}`);
        return false;
    }

    if (activeExtractions.has(blobPath)) {
        console.info(`[Prefetch] Skip ${episodeSlug} — sedang diekstrak`);
        return false;
    }

    console.info(`[Prefetch] Memulai prefetch untuk: ${episodeSlug}`);
    activeExtractions.add(blobPath);
    let matchedSource = null;

    try {
        const pageData = await getServersBasedOnUrl(episodeUrl);
        const primaryServers = pageData.servers || [];
        const episodeTitle = pageData.judul || '';

        let alternativeServers = [];
        if (seriesTitle && episodeTitle && !episodeUrl.includes('___neosatsu_ep___')) {
            try {
                if (episodeUrl.includes('otakudesu') || episodeUrl.includes('/api/otakudesu/servers')) {
                    alternativeServers = await getAlternativeServersSamehadaku(seriesTitle, episodeTitle);
                } else {
                    alternativeServers = await getOtakuAlternativeServers(seriesTitle, episodeTitle, episodeUrl);
                }
            } catch (altErr) {
                console.error(`[Prefetch Alt Error] Gagal mengambil server alternatif:`, altErr.message);
            }
        }

        const primarySource = (episodeUrl.includes('otakudesu') || episodeUrl.includes('/api/otakudesu/servers')) ? 'Otakudesu' : 'Samehadaku';
        const altSource = primarySource === 'Otakudesu' ? 'Samehadaku' : 'Otakudesu';

        const servers = [
            ...(primaryServers || []).map(s => ({ ...s, source: primarySource })),
            ...(alternativeServers || []).map(s => ({ ...s, source: altSource })),
        ];

        if (!servers || servers.length === 0) {
            console.info(`[Prefetch] Tidak ada server untuk: ${episodeSlug}`);
            markUploadFailed(seriesSlug, episodeSlug);
            return false;
        }

        const groups = { 1080: [], 720: [], 480: [], 360: [] };
        for (const srv of servers) {
            const resGroup = getResolutionGroup(srv.nama);
            if (resGroup && groups[resGroup]) groups[resGroup].push(srv);
        }

        for (const res of [1080, 720, 480, 360]) {
            for (const srv of groups[res]) {
                try {
                    const extracted = await extractVideoUrl(srv.iframeUrl);
                    if (extracted && extracted.url && !extracted.webviewOnly) {
                        if (!extracted.isM3U8 && !extracted.url.includes('.m3u8')) {
                            matchedSource = { url: extracted.url, headers: extracted.headers || {} };
                            console.info(`[Prefetch] ✓ ${episodeSlug} (${res}p) dari ${srv.source}`);
                            break;
                        }
                    }
                } catch (e) {
                    console.error(`[Prefetch] Gagal ekstrak dari ${srv.namaHost}:`, e.message);
                }
            }
            if (matchedSource) break;
        }
    } finally {
        activeExtractions.delete(blobPath);
    }

    if (matchedSource) {
        await uploadStream(matchedSource.url, matchedSource.headers, seriesSlug, episodeSlug);
        return true;
    } else {
        markUploadFailed(seriesSlug, episodeSlug);
        return false;
    }
}

/**
 * Prefetch sliding window — unduh episode dalam `upcomingUrls` satu per satu
 * secara sekuensial. Lewati jika sudah READY/UPLOADING.
 * Logika: selalu jaga 2 episode ke depan sudah READY.
 */
async function triggerPrefetchWindow(seriesSlug, upcomingUrls, seriesTitle) {
    if (!upcomingUrls || upcomingUrls.length === 0) return;

    // Filter hanya URL yang valid
    const validUrls = upcomingUrls.filter(Boolean);
    if (validUrls.length === 0) return;

    // Jalankan secara sekuensial agar tidak membanjiri server
    for (const epUrl of validUrls) {
        try {
            await prefetchOneEpisode(seriesSlug, epUrl, seriesTitle);
        } catch (err) {
            console.error(`[PrefetchWindow Error] ${epUrl}:`, err.message);
        }
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
    const { episodeUrl, seriesUrl, nextEpisodeUrl, nextNextEpisodeUrl, seriesTitle, episodeTitle } = req.query;
    if (!episodeUrl) {
        return res.status(400).json({ success: false, error: "Parameter 'episodeUrl' wajib diisi!" });
    }

    // Susun window prefetch: [N+1, N+2] — hanya yang ada nilainya
    const prefetchWindow = [nextEpisodeUrl, nextNextEpisodeUrl].filter(Boolean);

    try {
        const { seriesSlug, episodeSlug } = extractSlugs(episodeUrl, seriesUrl);

        const status = await checkUploadStatus(seriesSlug, episodeSlug);

        if (status === 'READY') {
            if (prefetchWindow.length > 0) {
                triggerPrefetchWindow(seriesSlug, prefetchWindow, seriesTitle);
            }
            return res.json({
                success: true,
                status: 'READY',
                url: getBlobUrl(getBlobPath(seriesSlug, episodeSlug))
            });
        }

        if (status === 'UPLOADING') {
            if (prefetchWindow.length > 0) {
                triggerPrefetchWindow(seriesSlug, prefetchWindow, seriesTitle);
            }
            
            const cachedProxyUrl = global[`proxy_${seriesSlug}_${episodeSlug}`];
            if (cachedProxyUrl) {
                return res.json({
                    success: true,
                    status: 'UPLOADING',
                    url: cachedProxyUrl,
                    message: 'Memutar via Proxy Instan sementara Azure memproses.'
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
                            const isDirectVideo = !extracted.isM3U8 && !extracted.url.includes('.m3u8');
                            if (isDirectVideo) {
                                matchedSource = {
                                    url: extracted.url,
                                    headers: extracted.headers || {}
                                };
                                console.info(`[Smart-Play] Menemukan source video (Direct) (${resVal}p) dari ${srv.source}: ${extracted.url}`);
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
            // Start upload in background, then chain prefetch window
            const uploadTask = uploadStream(matchedSource.url, matchedSource.headers, seriesSlug, episodeSlug);
            
            // Trigger prefetch window ONLY AFTER current upload finishes (hemat bandwidth)
            if (prefetchWindow.length > 0 && uploadTask) {
                uploadTask.then(() => {
                    console.info(`[Smart-Play] Upload selesai. Memulai prefetch window [${prefetchWindow.length} episode]...`);
                    triggerPrefetchWindow(seriesSlug, prefetchWindow, seriesTitle);
                }).catch(err => {
                    console.error(`[Smart-Play] Upload gagal, prefetch window dibatalkan:`, err.message);
                });
            }

            const baseUrl = `${req.protocol}://${req.get('host')}`;
            let proxyUrl = matchedSource.url;
            if (matchedSource.headers && matchedSource.headers.token) {
                proxyUrl = `${baseUrl}/api/proxy/kraken?url=${encodeURIComponent(matchedSource.url)}&token=${encodeURIComponent(matchedSource.headers.token)}&referer=${encodeURIComponent(matchedSource.headers.Referer || '')}`;
            } else {
                proxyUrl = `${baseUrl}/api/proxy/filedon?url=${encodeURIComponent(matchedSource.url)}`;
            }
            
            // Simpan proxy URL sementara ke global (opsional, tapi berguna untuk return UPLOADING berikutnya)
            global[`proxy_${seriesSlug}_${episodeSlug}`] = proxyUrl;

            return res.json({
                success: true,
                status: 'UPLOADING',
                url: proxyUrl,
                message: 'Memutar via Proxy Instan sementara Azure memproses.'
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
