// ── Facade Orchestrator: ffmpegStreamService.js ──
// Sesuai SRP, modul raksasa telah dipecah menjadi 3 modul spesifik:
// 1. downloaderClient.js: Pengecekan Range support, download multi-jalur (chunked), dan unduhan Mega.
// 2. hlsTranscoder.js: Pembentukan child process FFmpeg dan pengawasan pemotongan segmen HLS lokal.
// 3. azureSegmentUploader.js: Pengiriman segmen .ts dan playlist secara estafet ke Azure Blob Storage.

import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import axios from 'axios';
import { setMaxListeners } from 'events';
import { uploadCache, globalBlacklistCache, uploadProgressCache, activeUploadControllers, failureCountCache } from './streamStateStore.js';
import { getBlobPath, containerClient, ensureContainerExists } from './blobStorageService.js';
import { markUploadFailed, cleanTempFilesAsync } from './uploadProgressService.js';
import { checkRangeSupport, downloadChunked, downloadFromMega } from './downloaderClient.js';
import { transcodeAndMonitorHLS } from './hlsTranscoder.js';

export { checkRangeSupport, downloadChunked, downloadFromMega };

/**
 * Melakukan download multi-thread (jika didukung) atau single-stream, lalu upload ke Azure Blob Storage
 */
export async function uploadStream(videoUrl, headers = {}, seriesSlug, episodeSlug, source = 'player') {
    const blobPath = getBlobPath(seriesSlug, episodeSlug);
    
    if (!containerClient) {
        console.error('[FFmpegStream] Cannot upload: Container client is not configured.');
        uploadCache.set(blobPath, 'FAILED');
        return Promise.reject(new Error('Container client is not configured.'));
    }

    await ensureContainerExists();
    uploadCache.set(blobPath, 'UPLOADING', 1800);
    console.info(`[FFmpegStream] Starting upload for ${blobPath} from ${videoUrl}`);

    return (async () => {
        const globalAbort = new AbortController();
        try { setMaxListeners(50, globalAbort.signal); } catch (e) {}
        
        const appTmpDir = path.join(os.tmpdir(), 'wibuflix_temp');
        if (!fs.existsSync(appTmpDir)) fs.mkdirSync(appTmpDir, { recursive: true });
        const tempFileName = crypto.randomUUID() + '.mp4';
        const tempFilePath = path.join(appTmpDir, tempFileName);
        const hlsOutputDir = path.join(appTmpDir, `hls_${crypto.randomUUID()}`);
        
        activeUploadControllers.set(blobPath, { abortController: globalAbort, tempFilePath, hlsOutputDir, source });
        
        try {
            if (fs.existsSync(hlsOutputDir)) fs.rmSync(hlsOutputDir, { recursive: true, force: true });
            fs.mkdirSync(hlsOutputDir, { recursive: true });
            const requestHeaders = {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/124.0.0.0',
                ...headers
            };

            let isM3u8Input = videoUrl.includes('.m3u8');
            let isPipeMode = false;
            let ffmpegInputSource = videoUrl;
            let streamSource = null;

            if (isM3u8Input) {
                console.info(`[FFmpegStream] Mode M3U8: FFmpeg membaca dari URL.`);
                uploadProgressCache.set(blobPath, 'Menghubungkan ke stream M3U8...');
            } else {
                uploadProgressCache.set(blobPath, 'Menghubungkan ke server...');
                const rangeCheck = await checkRangeSupport(videoUrl, requestHeaders);
                
                let numThreads = 1;
                const hostLow = videoUrl.toLowerCase();
                if (hostLow.includes('kraken')) {
                    numThreads = 16;
                } else if (
                    hostLow.includes('googleapis') ||
                    hostLow.includes('drive.google') ||
                    hostLow.includes('mediafire') ||
                    hostLow.includes('pixeldrain') ||
                    hostLow.includes('wibufile') ||
                    (rangeCheck.supported && rangeCheck.totalSize > 0)
                ) {
                    numThreads = 2;
                }
                
                if (rangeCheck.supported && numThreads > 1) {
                    console.info(`[FFmpegStream] Mode JDownloader/Kraken. Mengunduh ke VPS lokal...`);
                    const numThreads = rangeCheck.totalSize > 500 * 1024 * 1024 ? 8 : 4;
                    isPipeMode = false;
                    ffmpegInputSource = tempFilePath;
                    await downloadChunked(videoUrl, requestHeaders, tempFilePath, rangeCheck.totalSize, numThreads, globalAbort, blobPath);
                } else if (videoUrl.includes('/api/proxy/mega')) {
                    console.info(`[FFmpegStream] Mode Mega: Mengunduh file penuh terlebih dahulu ke lokal (maxConnections: 4)...`);
                    isPipeMode = false;
                    ffmpegInputSource = tempFilePath;
                    await downloadFromMega(videoUrl, tempFilePath, globalAbort, blobPath);
                } else {
                    console.info(`[FFmpegStream] Mode Single Stream: Mengalirkan data (Pipe)...`);
                    isPipeMode = true;
                    uploadProgressCache.set(blobPath, 'Mengalirkan video ke mesin...');
                    
                    const axiosConfig = {
                        method: 'get',
                        url: videoUrl,
                        responseType: 'stream',
                        headers: requestHeaders,
                        timeout: 30000,
                        validateStatus: () => true,
                        signal: globalAbort.signal
                    };
                    if (videoUrl.includes('127.0.0.1') || videoUrl.includes('localhost')) {
                        axiosConfig.proxy = false;
                    }
                    const response = await axios(axiosConfig);
                    const contentType = (response.headers['content-type'] || '').toLowerCase();
                    if (response.status !== 200 && response.status !== 206) {
                        if (response.data && typeof response.data.destroy === 'function') response.data.destroy();
                        throw new Error(`[Stream Error] HTTP Status ${response.status} tidak valid untuk stream video`);
                    }
                    if (contentType.includes('text/html') || contentType.includes('application/json') || contentType.includes('manifest')) {
                        if (response.data && typeof response.data.destroy === 'function') response.data.destroy();
                        throw new Error(`[Stream Validator] Gagal. URL ini bukan video! Content-Type yang didapat: ${contentType}`);
                    }
                    streamSource = response.data;
                }
            }

            if (globalAbort.signal.aborted) throw new Error('UPLOAD_CANCELLED');

            console.info(`[FFmpegStream] Memulai pemotongan HLS paralel untuk ${blobPath}`);
            uploadProgressCache.set(blobPath, 'Memproses & Mengalirkan video ke Cloud Storage...');
            
            const baseAzurePath = `${seriesSlug}/${episodeSlug}`;

            await transcodeAndMonitorHLS({
                videoUrl,
                requestHeaders,
                isM3u8Input,
                isPipeMode,
                ffmpegInputSource,
                streamSource,
                hlsOutputDir,
                baseAzurePath,
                globalAbort,
                blobPath
            });

            console.info(`[FFmpegStream] Berhasil mengunggah versi HLS ke Azure secara Estafet: ${blobPath}`);
            uploadCache.set(blobPath, 'READY');
            uploadProgressCache.del(blobPath);
            activeUploadControllers.delete(blobPath);
            failureCountCache.del(blobPath);

        } catch (err) {
            if (globalAbort.signal.aborted || err.message === 'UPLOAD_CANCELLED' || err.code === 'ERR_CANCELED') {
                console.info(`[FFmpegStream] Upload dibatalkan: ${blobPath}`);
                uploadCache.del(blobPath);
                uploadProgressCache.del(blobPath);
            } else {
                console.error(`[FFmpegStream] Gagal memproses ${blobPath} dari URL ${videoUrl}:`, err.message);
                if (videoUrl && (videoUrl.includes('/api/proxy/mega') || videoUrl.toLowerCase().includes('mega.nz'))) {
                    console.warn('[FFmpegStream] Mega upload gagal total/diblokir. Memasukkan Mega ke Blacklist Global selama 10 menit...');
                    globalBlacklistCache.set('mega_blacklist', true, 600);
                }
                markUploadFailed(seriesSlug, episodeSlug);
                uploadProgressCache.del(blobPath);
            }
            if (containerClient) {
                try {
                    const blockBlobClient = containerClient.getBlockBlobClient(blobPath);
                    blockBlobClient.deleteIfExists().catch(() => {});
                } catch (delErr) {}
            }
            activeUploadControllers.delete(blobPath);
            throw err;
        } finally {
            try {
                if (!globalAbort.signal.aborted) {
                    globalAbort.abort();
                }
                cleanTempFilesAsync(tempFilePath, hlsOutputDir);
            } catch (fsErr) {
                // Abaikan
            }
        }
    })();
}
