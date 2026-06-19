import express from 'express';
import { extractVideoUrl, scrapeVideoServers, getAlternativeServersSamehadaku } from '../services/extractors/videoExtractor.js';
import { checkUploadStatus, uploadStream, getBlobPath, getBlobUrl, markUploadFailed, hasActiveUploadForSeries, getActiveUploadCount, getUploadProgress, cancelUpload, cancelAllUploads, checkRangeSupport } from '../utils/azureUploader.js';
import Anime from '../models/Anime.js';
import { getNeosatsuServers } from '../controllers/neosatsuController.js';
import { getServersInternal as getOtakuServers, getAlternativeServers as getOtakuAlternativeServers } from '../controllers/otakudesuController.js';
import { getKuronimeServers } from '../controllers/kuronimeController.js';
import { backgroundQueue } from '../utils/queueManager.js';
import QueueTask from '../models/QueueTask.js';

// Setup background queue processor
backgroundQueue.setProcessor(async (item) => {
    // Jalankan prefetchOneEpisode dengan source 'queue'
    const result = await prefetchOneEpisode(item.seriesSlug, item.episodeUrl, item.seriesTitle, 'queue');
    if (!result.success) {
        // Jika skip atau gagal, ubah status di antrean
        throw new Error(result.reason || 'Prefetch failed or skipped');
    }
});

const router = express.Router();
const activeExtractions = new Set();
let prefetchAbortController = new AbortController();

export function extractSlugs(episodeUrl, seriesUrl) {
    let episodeSlug = '';
    let seriesSlug = '';

    if (episodeUrl.includes('___neosatsu_ep___')) {
        const parts = episodeUrl.split('___neosatsu_ep___');
        const seriesPart = parts[0];
        episodeSlug = parts[1];

        // Neosatsu targetUrl bisa berupa "neosatsu-merge:Title||Label" (tanpa slash)
        // atau URL biasa seperti "https://www.neosatsu.com/p/kamen-rider-..."
        // Kita harus membuat slug Azure-safe dari keduanya.
        if (seriesPart.startsWith('neosatsu-merge:') || seriesPart.startsWith('neosatsu-label:')) {
            // Ambil hanya bagian judul (sebelum "||"), buang prefix "neosatsu-merge:"
            const dataStr = seriesPart.split(':').slice(1).join(':'); // hapus "neosatsu-merge:"
            const titlePart = dataStr.split('||')[0].trim(); // ambil title saja, buang label
            // Jadikan slug: lowercase, hapus karakter non-alfanumerik (kecuali spasi & dash), ganti spasi → dash
            seriesSlug = titlePart
                .toLowerCase()
                .replace(/[^a-z0-9\s-]/g, '')
                .trim()
                .replace(/\s+/g, '-')
                || 'neosatsu_series';
        } else {
            // URL biasa — ambil segmen path terakhir
            let cleanPart = seriesPart.replace(/\/$/, '');
            seriesSlug = cleanPart.split('/').pop() || 'neosatsu_series';
            seriesSlug = seriesSlug.replace(/\.html/g, '');
        }
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
            if (episodeUrl.includes('kuronime.sbs') && seriesSlug.startsWith('nonton-')) {
                seriesSlug = seriesSlug.replace(/^nonton-/, '');
            }
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
    } else if (episodeUrl.includes('kuronime.sbs') || episodeUrl.includes('/api/kuronime/servers')) {
        let realUrl = episodeUrl;
        if (episodeUrl.includes('?url=')) {
            realUrl = decodeURIComponent(episodeUrl.split('?url=')[1]);
        }
        return await getKuronimeServers(realUrl);
    } else {
        return await scrapeVideoServers(episodeUrl);
    }
}

function serverScore(host) {
    if (!host) return 0;
    const h = host.toLowerCase();
    if (h.includes('mega')) return 100;
    if (h.includes('wibufile')) return 90;
    if (h.includes('filedon') || h.includes('filemoon') || h.includes('filelions')) return 80;
    if (h.includes('pixeldrain')) return 70;
    if (h.includes('acefile')) return 60;
    if (h.includes('vidhide')) return 50;
    if (h.includes('kraken')) return -100; // super lambat, last resort
    return 0;
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
export async function prefetchOneEpisode(seriesSlug, episodeUrl, seriesTitle, source = 'player') {
    const { episodeSlug } = extractSlugs(episodeUrl, null);
    const blobPath = getBlobPath(seriesSlug, episodeSlug);
    const logPrefix = source === 'queue' ? '[Queue]' : '[Prefetch]';

    const status = await checkUploadStatus(seriesSlug, episodeSlug);
    
    // Jika lewat queue, kita abaikan status FAILED agar bisa di-retry
    if (status === 'READY' || status === 'UPLOADING' || (status === 'FAILED' && source !== 'queue')) {
        console.info(`${logPrefix} Skip ${episodeSlug} — status: ${status}`);
        return { success: false, reason: 'Already processing or failed' };
    }

    if (activeExtractions.has(blobPath)) {
        console.info(`${logPrefix} Skip ${episodeSlug} — sedang diekstrak`);
        return { success: false, reason: 'Already extracting' };
    }

    console.info(`${logPrefix} Memulai proses untuk: ${episodeSlug}`);
    activeExtractions.add(blobPath);
    let matchedSource = null;
    let m3u8Found = false;

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

        let primarySource = 'Samehadaku';
        if (episodeUrl.includes('otakudesu') || episodeUrl.includes('/api/otakudesu/servers')) primarySource = 'Otakudesu';
        if (episodeUrl.includes('kuronime.sbs') || episodeUrl.includes('/api/kuronime/servers')) primarySource = 'Kuronime';
        
        let altSource = 'Otakudesu';
        if (primarySource === 'Otakudesu') altSource = 'Samehadaku';
        if (primarySource === 'Kuronime') altSource = 'Samehadaku'; // Fallback logic for now

        const servers = [
            ...(primaryServers || []).map(s => ({ ...s, source: primarySource })),
            ...(alternativeServers || []).map(s => ({ ...s, source: altSource })),
        ];

        if (!servers || servers.length === 0) {
            console.info(`${logPrefix} Tidak ada server untuk: ${episodeSlug}`);
            markUploadFailed(seriesSlug, episodeSlug);
            return { success: false, reason: 'Tidak ada server tersedia' };
        }

        // Check M3U8 from direct stream first (Kuronime)
        for (const srv of servers) {
            if (srv.type === 'direct' && srv.iframeUrl && srv.iframeUrl.includes('.m3u8')) {
                matchedSource = { url: srv.iframeUrl, headers: srv.headers || {} };
                m3u8Found = true;
                console.info(`${logPrefix} Menemukan source M3U8 langsung dari ${srv.source}: ${srv.iframeUrl}`);
                break;
            }
        }

        if (!m3u8Found) {
            const groups = { 1080: [], 720: [], 480: [], 360: [] };
            for (const srv of servers) {
                const resGroup = getResolutionGroup(srv.nama);
                if (resGroup && groups[resGroup]) groups[resGroup].push(srv);
            }

            // Sama seperti smart-play: urutkan server berdasarkan skor kecepatan provider
            for (const res of [1080, 720, 480, 360]) {
                if (groups[res].length > 0) {
                    groups[res].sort((a, b) => serverScore(b.namaHost) - serverScore(a.namaHost));
                    const serverNames = groups[res].map(s => s.namaHost).join(', ');
                    console.info(`${logPrefix} Menguji server ${res}p: ${serverNames}`);
                }
                for (const srv of groups[res]) {
                    try {
                        const extracted = await extractVideoUrl(srv.iframeUrl);
                        if (extracted && extracted.url && !extracted.webviewOnly) {
                            // Merge headers, prioritizing the ones provided by the server extraction
                            const finalHeaders = { ...(extracted.headers || {}), ...(srv.headers || {}) };
                            
                            // Ping server untuk mengecek limit bandwidth (HTTP 429)
                            try {
                                await checkRangeSupport(extracted.url, finalHeaders);
                            } catch (pingErr) {
                                if (pingErr.message === 'HTTP_429_LIMIT') {
                                    console.warn(`${logPrefix} ${srv.namaHost} terkena limit kuota (429), lompat ke server berikutnya...`);
                                    continue;
                                }
                                throw pingErr;
                            }
                            matchedSource = { url: extracted.url, headers: finalHeaders };
                            console.info(`${logPrefix} ✓ ${episodeSlug} (${res}p) dari ${srv.source} [${srv.namaHost}]`);
                            break;
                        }
                    } catch (e) {
                        console.error(`${logPrefix} Gagal ekstrak dari ${srv.namaHost}:`, e.message);
                    }
                }
                if (matchedSource) break;
            }
        }
    } finally {
        activeExtractions.delete(blobPath);
    }

    if (matchedSource) {
        global[`prefetch_src_${seriesSlug}_${episodeSlug}`] = matchedSource;
        await uploadStream(matchedSource.url, matchedSource.headers, seriesSlug, episodeSlug, source);
        delete global[`prefetch_src_${seriesSlug}_${episodeSlug}`];
        return { success: true };
    } else {
        markUploadFailed(seriesSlug, episodeSlug);
        return { success: false, reason: 'Semua server gagal atau limit.' };
    }
}

/**
 * Prefetch sliding window — unduh episode dalam `upcomingUrls` satu per satu
 * secara sekuensial dengan jeda antar episode.
 * Logika: selalu jaga 2 episode ke depan sudah READY.
 * Jika ada upload Mega yang sedang berjalan, tunggu dulu.
 */
async function triggerPrefetchWindow(seriesSlug, upcomingUrls, seriesTitle) {
    if (!upcomingUrls || upcomingUrls.length === 0) return;

    const validUrls = upcomingUrls.filter(Boolean);
    if (validUrls.length === 0) return;

    for (const epUrl of validUrls) {
        try {
            const { episodeSlug } = extractSlugs(epUrl, null);
            const status = await checkUploadStatus(seriesSlug, episodeSlug);

            if (status === 'READY' || status === 'FAILED') {
                // Sudah done atau sudah gagal — skip
                console.info(`[PrefetchWindow] Skip ${episodeSlug} — status: ${status}`);
                continue;
            }

            if (status === 'UPLOADING') {
                // Sedang upload, tunggu dahulu sebelum episode berikutnya
                console.info(`[PrefetchWindow] ${episodeSlug} sedang UPLOADING, tunggu sebelum lanjut ke episode berikutnya...`);
                await new Promise(r => setTimeout(r, 45000)); // Tunggu 45 detik
                continue;
            }

            // Jika ada upload aktif lainnya di series ini, tunggu dulu sebelum mulai prefetch
            let activeUploadExists = hasActiveUploadForSeries(seriesSlug);
            let globalUploadCount = getActiveUploadCount();

            while (activeUploadExists || globalUploadCount >= 3) {
                if (prefetchAbortController.signal.aborted) {
                    console.info(`[PrefetchWindow] Dibatalkan oleh pengguna saat menunggu antrean untuk ${episodeSlug}`);
                    return;
                }

                if (activeUploadExists) {
                    console.info(`[PrefetchWindow] Series ${seriesSlug} masih memiliki upload yang berjalan. Menunda prefetch ${episodeSlug}...`);
                } else if (globalUploadCount >= 3) {
                    console.info(`[PrefetchWindow] VPS sedang sibuk (ada ${globalUploadCount} upload berjalan). Menunda prefetch ${episodeSlug}...`);
                }

                await new Promise(r => setTimeout(r, 10000)); // Cek setiap 10 detik

                activeUploadExists = hasActiveUploadForSeries(seriesSlug);
                globalUploadCount = getActiveUploadCount();
            }

            if (prefetchAbortController.signal.aborted) return;

            await prefetchOneEpisode(seriesSlug, epUrl, seriesTitle);

            // Jeda antar episode untuk mencegah ETOOMANY dari Mega
            if (validUrls.indexOf(epUrl) < validUrls.length - 1) {
                console.info(`[PrefetchWindow] Jeda 30 detik sebelum prefetch episode berikutnya...`);
                await new Promise(r => setTimeout(r, 30000));
            }
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
    const { episodeUrl, seriesUrl, nextEpisodeUrl, seriesTitle, episodeTitle } = req.query;
    if (!episodeUrl) {
        return res.status(400).json({ success: false, error: "Parameter 'episodeUrl' wajib diisi!" });
    }

    // Susun window prefetch: [N+1, N+2] — hanya yang ada nilainya
    const prefetchWindow = [nextEpisodeUrl].filter(Boolean);

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

            let cachedProxyUrl = global[`proxy_${seriesSlug}_${episodeSlug}`];
            if (!cachedProxyUrl && global[`prefetch_src_${seriesSlug}_${episodeSlug}`]) {
                const src = global[`prefetch_src_${seriesSlug}_${episodeSlug}`];
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
            let primarySource = 'Samehadaku';
            if (episodeUrl.includes('otakudesu') || episodeUrl.includes('/api/otakudesu/servers')) primarySource = 'Otakudesu';
            if (episodeUrl.includes('kuronime.sbs') || episodeUrl.includes('/api/kuronime/servers')) primarySource = 'Kuronime';
            
            let altSource = 'Otakudesu';
            if (primarySource === 'Otakudesu') altSource = 'Samehadaku';
            if (primarySource === 'Kuronime') altSource = 'Samehadaku';

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
            let m3u8Source = null;

            for (const resVal of resolutions) {
                if (groups[resVal].length > 0) {
                    // Urutkan server berdasarkan prioritas kecepatan dan keandalan (Mega, Wibufile > Krakenfiles)
                    groups[resVal].sort((a, b) => serverScore(b.namaHost) - serverScore(a.namaHost));

                    const serverNames = groups[resVal].map(s => s.namaHost).join(', ');
                    console.info(`[Smart-Play] Menguji server ${resVal}p: ${serverNames}`);
                }
                for (const srv of groups[resVal]) {
                    try {
                        const extracted = await extractVideoUrl(srv.iframeUrl, req);
                        if (extracted && extracted.url && !extracted.webviewOnly) {
                            // Ping host to ensure it's not rate-limited (e.g., Pixeldrain 5GB limit)
                            console.info(`[Smart-Play] Ping ${srv.namaHost} untuk mengecek limit bandwidth...`);
                            try {
                                const finalHeaders = { ...(extracted.headers || {}), ...(srv.headers || {}) };
                                await checkRangeSupport(extracted.url, finalHeaders);
                                // If no error, we proceed
                                matchedSource = {
                                    url: extracted.url,
                                    headers: finalHeaders
                                };
                                console.info(`[Smart-Play] Menemukan source video (${resVal}p) dari ${srv.source}: ${extracted.url}`);
                                break;
                            } catch (pingErr) {
                                if (pingErr.message === 'HTTP_429_LIMIT') {
                                    console.warn(`[Smart-Play] ${srv.namaHost} terkena Limit Kuota (429)! Melompat ke server berikutnya...`);
                                    continue;
                                }
                                throw pingErr;
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

            // Pastikan selalu ada .catch() agar Node tidak crash jika terjadi unhandled rejection
            if (uploadTask) {
                uploadTask.then(() => {
                    if (prefetchWindow.length > 0) {
                        console.info(`[Smart-Play] Upload selesai. Memulai prefetch window [${prefetchWindow.length} episode]...`);
                        triggerPrefetchWindow(seriesSlug, prefetchWindow, seriesTitle);
                    }
                }).catch(err => {
                    console.error(`[Smart-Play] Upload latar belakang gagal:`, err.message);
                });
            }

            const baseUrl = `${req.protocol}://${req.get('host')}`;
            let proxyUrl = matchedSource.url;
            if (matchedSource.headers && matchedSource.headers.token) {
                proxyUrl = `${baseUrl}/api/proxy/kraken?url=${encodeURIComponent(matchedSource.url)}&token=${encodeURIComponent(matchedSource.headers.token)}&referer=${encodeURIComponent(matchedSource.headers.Referer || '')}`;
            } else if (!matchedSource.url.includes('.m3u8')) {
                proxyUrl = `${baseUrl}/api/proxy/filedon?url=${encodeURIComponent(matchedSource.url)}`;
            }

            // Simpan proxy URL sementara ke global (opsional)
            global[`proxy_${seriesSlug}_${episodeSlug}`] = proxyUrl;

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
});

// ============================================================
// POST /api/cancel-uploads
// ============================================================
router.post('/api/cancel-uploads', (req, res) => {
    try {
        prefetchAbortController.abort();
        prefetchAbortController = new AbortController();
        const count = cancelAllUploads();
        res.json({ success: true, message: `Berhasil membatalkan ${count} upload aktif.` });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

// ============================================================
// GET /api/upload-status
// ============================================================
router.get('/api/upload-status', (req, res) => {
    try {
        const { episodeUrl, seriesUrl } = req.query;
        if (!episodeUrl) return res.status(400).json({ success: false, message: "URL required" });
        
        const { seriesSlug, episodeSlug } = extractSlugs(episodeUrl, seriesUrl);
        const progressMessage = getUploadProgress(seriesSlug, episodeSlug);
        res.json({ success: true, progressMessage });
    } catch (e) {
        console.error(`[Smart-Play Error]:`, e.message);
        return res.status(500).json({ success: false, status: 'FAILED', message: e.message });
    }
});

// Endpoint untuk membatalkan upload secara eksplisit dari client
router.post('/cancel-stream', express.json(), (req, res) => {
    const { url } = req.body;
    if (!url) return res.json({ success: false });
    
    const { seriesSlug, episodeSlug } = extractSlugs(url, null);
    const blobPath = getBlobPath(seriesSlug, episodeSlug);
    
    console.info(`[Smart-Play] Eksplisit cancel dari client untuk: ${episodeSlug}`);
    cancelUpload(seriesSlug, episodeSlug);
    activeExtractions.delete(blobPath);
    
    return res.json({ success: true });
});

// ============================================================
// RUTE QUEUE: Background Download Manager
// ============================================================

router.post('/api/queue/add', express.json(), async (req, res) => {
    const { episodeUrl, seriesUrl, seriesTitle, episodeTitle } = req.body;
    if (!episodeUrl) return res.status(400).json({ success: false, error: "episodeUrl diperlukan" });
    
    // Extract slugs to check if already uploaded/uploading
    const { seriesSlug, episodeSlug } = extractSlugs(episodeUrl, seriesUrl);
    
    // We can directly add it to the background queue manager
    const item = await backgroundQueue.add(episodeUrl, seriesSlug, seriesTitle, episodeTitle);
    res.json({ success: true, item });
});

router.post('/api/queue/prioritize', express.json(), async (req, res) => {
    const { id } = req.body;
    await backgroundQueue.prioritize(id);
    res.json({ success: true });
});

router.post('/api/queue/cancel', express.json(), async (req, res) => {
    const { id } = req.body;
    
    try {
        const task = await QueueTask.findOne({ id });
        if (task && task.status === 'UPLOADING') {
            const { episodeSlug } = extractSlugs(task.episodeUrl, null);
            const seriesSlug = task.seriesSlug || extractSlugs(task.episodeUrl, null).seriesSlug;
            
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
});

router.get('/api/queue/status', async (req, res) => {
    const queueItems = await backgroundQueue.getStatus();
    
    // Update real-time progress untuk item yang UPLOADING
    const updatedItems = queueItems.map(item => {
        if (item.status === 'UPLOADING') {
            const { seriesSlug, episodeSlug } = extractSlugs(item.episodeUrl, null);
            item.progress = getUploadProgress(seriesSlug, episodeSlug);
        }
        return item;
    });

    res.json({ success: true, queue: updatedItems });
});

router.get('/api/queue/stream', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    const sendQueueUpdate = async () => {
        const queueItems = await backgroundQueue.getStatus();
        
        // Update real-time progress untuk item yang UPLOADING
        const updatedItems = queueItems.map(item => {
            if (item.status === 'UPLOADING') {
                const { seriesSlug, episodeSlug } = extractSlugs(item.episodeUrl, null);
                item.progress = getUploadProgress(seriesSlug, episodeSlug);
            }
            return item;
        });

        res.write(`data: ${JSON.stringify({ success: true, queue: updatedItems })}\n\n`);
    };

    // Kirim data langsung saat koneksi dibuka
    sendQueueUpdate();

    // Kirim update setiap 1.5 detik
    const interval = setInterval(sendQueueUpdate, 1500);

    req.on('close', () => {
        clearInterval(interval);
    });
});

export default router;
