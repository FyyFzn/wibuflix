import { BlobServiceClient } from '@azure/storage-blob';
import axios from 'axios';
import { getCache } from './cacheManager.js';
import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import ffmpegPath from 'ffmpeg-static';
import { execFile } from 'child_process';
import { promisify } from 'util';
import pLimit from 'p-limit';
import { setMaxListeners } from 'events';

const execFileAsync = promisify(execFile);

const connectionString = process.env.AZURE_STORAGE_CONNECTION_STRING;
const containerName = process.env.AZURE_STORAGE_CONTAINER_NAME || 'videos';

let containerClient = null;
let isContainerInitialized = false;

if (connectionString) {
    try {
        const blobServiceClient = BlobServiceClient.fromConnectionString(connectionString);
        containerClient = blobServiceClient.getContainerClient(containerName);
    } catch (err) {
        console.error('[Azure Uploader] Failed to create ContainerClient:', err.message);
    }
} else {
    console.warn('[Azure Uploader] WARNING: AZURE_STORAGE_CONNECTION_STRING is not set. Azure upload will be disabled.');
}

const uploadCache = getCache('azure-uploads', 86400); // 24 hours TTL
const MIN_VIDEO_SIZE = 100 * 1024; // 100 KB

export const uploadProgressCache = new Map();
export const activeUploadControllers = new Map();
const failureCountCache = new Map();

/**
 * Returns the current upload progress string for a given blob.
 */
export function getUploadProgress(seriesSlug, episodeSlug) {
    const blobPath = getBlobPath(seriesSlug, episodeSlug);
    return uploadProgressCache.get(blobPath) || 'Menyiapkan video...';
}

/**
 * Cancels all currently active uploads for a specific source.
 */
export function cancelAllUploads(source = 'player') {
    let count = 0;
    for (const [blobPath, data] of activeUploadControllers.entries()) {
        if (data.source === source) {
            data.abortController.abort();
            console.info(`[Azure Uploader] Cancelled upload for ${blobPath} (source: ${source})`);
            activeUploadControllers.delete(blobPath);
            count++;
        }
    }
    return count;
}

/**
 * Normalizes and formats the blob path for Azure
 */
export function getBlobPath(seriesSlug, episodeSlug) {
    return `${seriesSlug}/${episodeSlug}/playlist.m3u8`;
}

/**
 * Gets the direct URL of a blob
 */
export function getBlobUrl(blobPath) {
    if (!containerClient) return '';
    const rawUrl = containerClient.getBlockBlobClient(blobPath).url;
    
    // Pastikan URL di-encode dengan benar (mengubah spasi menjadi %20 dll) agar player Native tidak error
    try {
        return new URL(rawUrl).href;
    } catch (e) {
        return rawUrl;
    }
}

/**
 * Initializes the container, ensuring it exists with public access
 */
async function ensureContainerExists() {
    if (!containerClient || isContainerInitialized) return;
    try {
        await containerClient.createIfNotExists({
            access: 'blob'
        });
        isContainerInitialized = true;
        console.info(`[Azure Uploader] Container "${containerName}" is ready.`);
    } catch (err) {
        console.error(`[Azure Uploader] Failed to ensure container exists:`, err.message);
    }
}

/**
 * Checks the upload status of a video
 * Returns: 'READY' | 'UPLOADING' | 'FAILED' | null (not started)
 */
export async function checkUploadStatus(seriesSlug, episodeSlug) {
    const blobPath = getBlobPath(seriesSlug, episodeSlug);
    
    // Check in-memory cache ONLY for UPLOADING or FAILED
    const cachedStatus = uploadCache.get(blobPath);
    if (cachedStatus === 'UPLOADING' || cachedStatus === 'FAILED') {
        return cachedStatus;
    }

    if (!containerClient) return null;

    try {
        await ensureContainerExists();
        const blockBlobClient = containerClient.getBlockBlobClient(blobPath);
        const exists = await blockBlobClient.exists();
        if (exists) {
            return 'READY';
        }
    } catch (err) {
        console.error(`[Azure Uploader] Error checking blob existence for ${blobPath}:`, err.message);
    }

    return cachedStatus || null;
}

/**
 * Marks the upload as failed in the cache, allowing up to 3 retries before permanent failure.
 */
export function markUploadFailed(seriesSlug, episodeSlug) {
    const blobPath = getBlobPath(seriesSlug, episodeSlug);
    const count = (failureCountCache.get(blobPath) || 0) + 1;
    failureCountCache.set(blobPath, count);
    
    if (count >= 3) {
        console.warn(`[Azure Uploader] ${blobPath} gagal ${count} kali. Menandai sebagai FAILED permanen (10 menit).`);
        uploadCache.set(blobPath, 'FAILED', 600); // 10 minutes failure cache TTL
    } else {
        console.info(`[Azure Uploader] ${blobPath} gagal ${count} kali. Menghapus cache agar bisa di-retry.`);
        uploadCache.del(blobPath);
    }
}

/**
 * Checks if there is any active upload for a specific series.
 */
export function hasActiveUploadForSeries(seriesSlug) {
    const prefix = `${seriesSlug}/`;
    const keys = uploadCache.keys();
    for (const key of keys) {
        if (key.startsWith(prefix) && uploadCache.get(key) === 'UPLOADING') {
            return true;
        }
    }
    return false;
}

/**
 * Gets the total number of active uploads globally.
 */
export function getActiveUploadCount() {
    let count = 0;
    const keys = uploadCache.keys();
    for (const key of keys) {
        if (uploadCache.get(key) === 'UPLOADING') {
            count++;
        }
    }
    return count;
}

/**
 * Membatalkan proses upload yang sedang berjalan
 */
export function cancelUpload(seriesSlug, episodeSlug) {
    const blobPath = getBlobPath(seriesSlug, episodeSlug);
    const data = activeUploadControllers.get(blobPath);
    if (data) {
        console.info(`[Azure Uploader] Membatalkan upload untuk ${blobPath}`);
        const controller = data.abortController || data;
        if (typeof controller.abort === 'function') controller.abort();
        
        if (data.tempFilePath) {
            // Sapu bersih file sementara
            try {
                if (fs.existsSync(data.tempFilePath)) fs.unlinkSync(data.tempFilePath);
                for (let i = 0; i < 20; i++) {
                    const chunkPath = `${data.tempFilePath}.part${i}`;
                    if (fs.existsSync(chunkPath)) fs.unlinkSync(chunkPath);
                }
            } catch(e) { }
        }

        activeUploadControllers.delete(blobPath);
        uploadCache.del(blobPath);
        uploadProgressCache.delete(blobPath);
    }
}



// --- FUNGSI JDOWNLOADER ---
export async function checkRangeSupport(url, headers) {
    try {
        const res = await axios({
            method: 'get',
            url: url,
            headers: { ...headers, 'Range': 'bytes=0-0' },
            timeout: 10000
        });
        if (res.status === 206) {
            const contentRange = res.headers['content-range'];
            if (contentRange) {
                const match = contentRange.match(/\/(\d+)$/);
                if (match) return { supported: true, totalSize: parseInt(match[1], 10) };
            }
        }
        // Jika status 200 OK, berarti file ada tapi tidak support resume
        return { supported: false, totalSize: 0 };
    } catch (e) {
        if (e.response) {
            if (e.response.status === 429) throw new Error('HTTP_429_LIMIT');
            if (e.response.status === 404) throw new Error('HTTP_404_NOT_FOUND');
            if (e.response.status === 403) throw new Error('HTTP_403_FORBIDDEN');
            if (e.response.status >= 500) throw new Error(`HTTP_${e.response.status}_SERVER_ERROR`);
        }
        throw new Error('NETWORK_ERROR: ' + e.message);
    }
}

async function downloadChunked(url, headers, tempFilePath, totalSize, numThreads, globalAbort, blobPath) {
    const chunkSize = Math.ceil(totalSize / numThreads);
    const chunkFiles = [];
    let downloadedBytes = 0;
    let nextLogThreshold = 5 * 1024 * 1024;
    // Batasi concurrency maksimal 8 agar aman dari error 429 (Too Many Requests), tapi tetap cepat (~1 MB/s)
    const limit = pLimit(Math.min(numThreads, 8)); 
    const promises = [];
    
    // Gunakan satu event listener terpusat untuk menghindari MaxListenersExceededWarning
    const abortCallbacks = new Set();
    const handleGlobalAbort = () => {
        for (const cb of abortCallbacks) {
            try { cb(); } catch (e) {}
        }
    };
    globalAbort.signal.addEventListener('abort', handleGlobalAbort);
    
    for (let i = 0; i < numThreads; i++) {
        const start = i * chunkSize;
        const end = Math.min((i + 1) * chunkSize - 1, totalSize - 1);
        if (start > end) break;
        
        const chunkPath = `${tempFilePath}.part${i}`;
        chunkFiles.push(chunkPath);
        
        promises.push(limit(async () => {
            // Trik Anti-DDoS: Beri jeda acak 0.5 - 2.5 detik sebelum memulai tiap thread baru
            // Mencegah tembakan request serentak di milidetik yang sama agar tidak dianggap serangan bot
            const staggerDelay = 500 + Math.random() * 2000;
            await new Promise(r => setTimeout(r, staggerDelay));

            let attempt = 0;
            const maxAttempts = 3;
            
            while (attempt < maxAttempts) {
                attempt++;
                let chunkDownloadedBytes = 0;
                
                try {
                    const localAbort = new AbortController();
                    
                    const res = await axios({
                        method: 'get',
                        url: url,
                        responseType: 'stream',
                        headers: { ...headers, 'Range': `bytes=${start}-${end}` },
                        signal: localAbort.signal,
                        timeout: 30000
                    });
                    
                    const writer = fs.createWriteStream(chunkPath);
                    let idleTimeout;
                    
                    const resetIdleTimeout = () => {
                        clearTimeout(idleTimeout);
                        idleTimeout = setTimeout(() => {
                            if (res.data && typeof res.data.destroy === 'function') {
                                res.data.destroy(new Error('STREAM_IDLE_TIMEOUT'));
                            }
                        }, 20000); // 20 detik tanpa data = timeout
                    };
                    
                    resetIdleTimeout();

                    res.data.on('data', (chunk) => {
                        resetIdleTimeout();
                        chunkDownloadedBytes += chunk.length;
                        downloadedBytes += chunk.length;
                        if (downloadedBytes >= nextLogThreshold) {
                            const downloadedMB = Math.round(downloadedBytes / 1024 / 1024);
                            const msg = `Mengunduh (${numThreads} Jalur): ${Math.round((downloadedBytes / totalSize) * 100)}% (${downloadedMB}MB / ${Math.round(totalSize / 1024 / 1024)}MB)`;
                            console.info(`[Azure Uploader] ${blobPath} - ${msg}`);
                            uploadProgressCache.set(blobPath, msg);
                            nextLogThreshold += 25 * 1024 * 1024;
                        }
                    });
                    
                    res.data.pipe(writer);
                    
                    await new Promise((resolve, reject) => {
                        const onAbort = () => {
                            clearTimeout(idleTimeout);
                            localAbort.abort();
                            writer.destroy(new Error('UPLOAD_CANCELLED'));
                            reject(new Error('UPLOAD_CANCELLED'));
                        };
                        
                        abortCallbacks.add(onAbort);
                        
                        writer.on('finish', () => {
                            clearTimeout(idleTimeout);
                            abortCallbacks.delete(onAbort);
                            resolve();
                        });
                        writer.on('error', (err) => {
                            clearTimeout(idleTimeout);
                            abortCallbacks.delete(onAbort);
                            reject(err);
                        });
                        res.data.on('error', (err) => {
                            clearTimeout(idleTimeout);
                            abortCallbacks.delete(onAbort);
                            reject(err);
                        });
                    });
                    
                    // Jika sukses, keluar dari loop retry
                    break;
                } catch (err) {
                    // Kurangi bytes yang sudah terhitung agar progress bar tidak rusak
                    downloadedBytes -= chunkDownloadedBytes;
                    
                    if (err.message === 'UPLOAD_CANCELLED' || globalAbort.signal.aborted) {
                        throw err;
                    }
                    
                    if (attempt >= maxAttempts) {
                        console.error(`[Azure Uploader] Chunk ${i} gagal setelah ${maxAttempts} percobaan: ${err.message}`);
                        throw err;
                    }
                    
                    console.warn(`[Azure Uploader] Chunk ${i} gagal/stuck, mengulang (${attempt}/${maxAttempts})... Error: ${err.message}`);
                    await new Promise(r => setTimeout(r, 2000)); // jeda sebelum retry
                }
            }
        }));
    }
    
    await Promise.all(promises);
    globalAbort.signal.removeEventListener('abort', handleGlobalAbort);
    
    console.info(`[Azure Uploader] Pengunduhan multi-jalur selesai. Menggabungkan ${chunkFiles.length} file...`);
    uploadProgressCache.set(blobPath, 'Menggabungkan potongan file...');
    
    if (fs.existsSync(tempFilePath)) fs.unlinkSync(tempFilePath);
    for (const chunkPath of chunkFiles) {
        if (!fs.existsSync(chunkPath)) throw new Error(`Chunk hilang: ${chunkPath}`);
        await new Promise((resolve, reject) => {
            const reader = fs.createReadStream(chunkPath);
            const writer = fs.createWriteStream(tempFilePath, { flags: 'a' });
            reader.pipe(writer);
            reader.on('end', () => {
                fs.unlinkSync(chunkPath);
                resolve();
            });
            reader.on('error', reject);
            writer.on('error', reject);
        });
    }
}


/**
 * Melakukan download multi-thread (jika didukung) atau single-stream, lalu upload ke Azure Blob Storage
 */
export async function uploadStream(videoUrl, headers = {}, seriesSlug, episodeSlug, source = 'player') {
    const blobPath = getBlobPath(seriesSlug, episodeSlug);
    
    if (!containerClient) {
        console.error('[Azure Uploader] Cannot upload: Container client is not configured.');
        uploadCache.set(blobPath, 'FAILED');
        return Promise.reject(new Error('Container client is not configured.'));
    }

    await ensureContainerExists();
    // Set UPLOADING state with a 30-minute TTL to prevent it from getting stuck forever if the upload crashes
    uploadCache.set(blobPath, 'UPLOADING', 1800);
    console.info(`[Azure Uploader] Starting upload for ${blobPath} from ${videoUrl}`);

    // Return the upload promise so callers can wait for it if they want
    return (async () => {
        const globalAbort = new AbortController();
        
        // Naikkan batas max listeners agar tidak memicu MaxListenersExceededWarning saat Kraken (16 jalur) berjalan
        try { setMaxListeners(50, globalAbort.signal); } catch (e) {}
        
        const tempFileName = crypto.randomUUID() + '.mp4';
        const tempFilePath = path.join(os.tmpdir(), tempFileName);
        
        activeUploadControllers.set(blobPath, { abortController: globalAbort, tempFilePath, source });
        
        const hlsOutputDir = path.join(os.tmpdir(), `hls_${crypto.randomUUID()}`);
        
        try {
            if (fs.existsSync(hlsOutputDir)) fs.rmSync(hlsOutputDir, { recursive: true, force: true });
            fs.mkdirSync(hlsOutputDir, { recursive: true });
            const requestHeaders = {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/124.0.0.0',
                ...headers
            };

            const blockBlobClient = containerClient.getBlockBlobClient(blobPath);

            // ========================================================
            // TAHAP 1: UNDUH UTUH KE SERVER LOKAL (VPS)
            // ========================================================
            const isM3u8Input = videoUrl.includes('.m3u8');
            
            if (isM3u8Input) {
                console.info(`[Azure Uploader] URL input adalah M3U8. Melewati Tahap 1 (Unduh Tunggal) dan langsung ke FFmpeg.`);
                uploadProgressCache.set(blobPath, 'Menghubungkan ke stream M3U8...');
            } else {
                console.info(`[Azure Uploader] Tahap 1: Mengecek JDownloader Mode untuk ${videoUrl}`);
                uploadProgressCache.set(blobPath, 'Menghubungkan ke server...');
                
                const rangeCheck = await checkRangeSupport(videoUrl, requestHeaders);
            
            let numThreads = 1;
            const hostLow = videoUrl.toLowerCase();
            if (hostLow.includes('kraken')) numThreads = 16;
            
            if (rangeCheck.supported && numThreads > 1) {
                console.info(`[Azure Uploader] Menggunakan JDownloader Mode (${numThreads} Threads) untuk ${blobPath}`);
                await downloadChunked(videoUrl, requestHeaders, tempFilePath, rangeCheck.totalSize, numThreads, globalAbort, blobPath);
            } else {
                console.info(`[Azure Uploader] Tahap 1: Mengunduh Single-Stream ke server lokal...`);
                uploadProgressCache.set(blobPath, 'Mengunduh ke Server VPS... 0%');
                
                const response = await axios({
                    method: 'get',
                    url: videoUrl,
                    responseType: 'stream',
                    headers: requestHeaders,
                    timeout: 30000,
                    signal: globalAbort.signal
                });

                const contentLengthStr = response.headers['content-length'];
                const contentLength = contentLengthStr ? parseInt(contentLengthStr) : 0;
                let totalDownloadedBytes = 0;

                const writer = fs.createWriteStream(tempFilePath);
                
                let nextLogThreshold = 5 * 1024 * 1024;
                response.data.on('data', (chunk) => {
                    totalDownloadedBytes += chunk.length;
                    if (totalDownloadedBytes >= nextLogThreshold) {
                        const downloadedMB = Math.round(totalDownloadedBytes / 1024 / 1024);
                        const msg = contentLength > MIN_VIDEO_SIZE 
                            ? `Mengunduh ke Server VPS: ${Math.round((totalDownloadedBytes / contentLength) * 100)}% (${downloadedMB}MB / ${Math.round(contentLength / 1024 / 1024)}MB)`
                            : `Mengunduh ke Server VPS: ${downloadedMB}MB...`;
                            
                        console.info(`[Azure Uploader] ${blobPath} - ${msg}`);
                        uploadProgressCache.set(blobPath, msg);
                        nextLogThreshold += 25 * 1024 * 1024;
                    }
                });

                response.data.pipe(writer);

                await new Promise((resolve, reject) => {
                    writer.on('finish', resolve);
                    writer.on('error', reject);
                    globalAbort.signal.addEventListener('abort', () => {
                        writer.destroy(new Error('UPLOAD_CANCELLED'));
                        reject(new Error('UPLOAD_CANCELLED'));
                    });
                });

                if (totalDownloadedBytes < MIN_VIDEO_SIZE) {
                    throw new Error(`[Azure Uploader] File terlalu kecil (${totalDownloadedBytes} bytes) — URL mungkin bukan direct link video.`);
                }
            }
            } // end if (!isM3u8Input)

            // ========================================================
            // TAHAP 2: POTONG VIDEO JADI HLS (M3U8)
            // ========================================================
            if (globalAbort.signal.aborted) throw new Error('UPLOAD_CANCELLED');
            
            console.info(`[Azure Uploader] Tahap 2: Mengubah format ke pecahan HLS...`);
            uploadProgressCache.set(blobPath, 'Memproses video (FFmpeg HLS)...');
            
            try {
                let ffmpegArgs = [];
                if (isM3u8Input) {
                    ffmpegArgs = [
                        '-y',
                        '-protocol_whitelist', 'file,http,https,tcp,tls,crypto'
                    ];
                    
                    if (requestHeaders['User-Agent']) {
                        ffmpegArgs.push('-user_agent', requestHeaders['User-Agent']);
                    }
                    if (requestHeaders['Referer']) {
                        ffmpegArgs.push('-referer', requestHeaders['Referer']);
                    }
                    
                    const headersArray = [];
                    if (requestHeaders['Origin']) headersArray.push(`Origin: ${requestHeaders['Origin']}`);
                    
                    if (headersArray.length > 0) {
                        ffmpegArgs.push('-headers', headersArray.join('\r\n') + '\r\n');
                    }
                    
                    ffmpegArgs.push(
                        '-i', videoUrl,
                        '-c', 'copy',
                        '-f', 'hls',
                        '-hls_time', '10',
                        '-hls_playlist_type', 'vod',
                        '-hls_segment_filename', path.join(hlsOutputDir, 'seg_%03d.ts'),
                        path.join(hlsOutputDir, 'playlist.m3u8')
                    );
                } else {
                    ffmpegArgs = [
                        '-y',
                        '-i', tempFilePath,
                        '-c', 'copy',
                        '-f', 'hls',
                        '-hls_time', '10',
                        '-hls_playlist_type', 'vod',
                        '-hls_segment_filename', path.join(hlsOutputDir, 'seg_%03d.ts'),
                        path.join(hlsOutputDir, 'playlist.m3u8')
                    ];
                }

                await execFileAsync(ffmpegPath, ffmpegArgs);
                console.info(`[Azure Uploader] Pemotongan HLS sukses diterapkan untuk ${blobPath}.`);
            } catch (fastErr) {
                 const stderrMsg = fastErr.stderr ? fastErr.stderr.toString() : '';
                 throw new Error('FFmpeg HLS gagal: ' + fastErr.message + '\n' + stderrMsg);
            }

            // ========================================================
            // TAHAP 3: UNGGAH KE AZURE STORAGE
            // ========================================================
            if (globalAbort.signal.aborted) throw new Error('UPLOAD_CANCELLED');

            console.info(`[Azure Uploader] Tahap 3: Mengunggah pecahan HLS ke Azure Blob...`);
            
            const uploadAbort = new AbortController();
            try { setMaxListeners(1000, uploadAbort.signal); } catch(e){}
            const onGlobalAbort = () => uploadAbort.abort();
            globalAbort.signal.addEventListener('abort', onGlobalAbort);

            const filesToUpload = fs.readdirSync(hlsOutputDir);
            uploadProgressCache.set(blobPath, `Mengunggah HLS ke Azure Cloud (0/${filesToUpload.length})...`);

            const limit = pLimit(15);
            let uploadedCount = 0;
            const baseAzurePath = `${seriesSlug}/${episodeSlug}`;

            const uploadPromises = filesToUpload.map(filename => limit(async () => {
                if (uploadAbort.signal.aborted) throw new Error('UPLOAD_CANCELLED');
                const filePath = path.join(hlsOutputDir, filename);
                const azurePath = `${baseAzurePath}/${filename}`;
                const fileType = filename.endsWith('.m3u8') ? 'application/vnd.apple.mpegurl' : 'video/mp2t';
                const blockBlobClient = containerClient.getBlockBlobClient(azurePath);
                
                await blockBlobClient.uploadFile(filePath, {
                    blobHTTPHeaders: { 
                        blobContentType: fileType,
                        blobCacheControl: 'public, max-age=31536000' // Cache 1 tahun
                    },
                    abortSignal: uploadAbort.signal
                });

                uploadedCount++;
                if (uploadedCount % 5 === 0 || uploadedCount === filesToUpload.length) {
                    uploadProgressCache.set(blobPath, `Mengunggah HLS ke Azure Cloud (${uploadedCount}/${filesToUpload.length})...`);
                }
            }));

            await Promise.all(uploadPromises);
            
            globalAbort.signal.removeEventListener('abort', onGlobalAbort);

            console.info(`[Azure Uploader] Berhasil mengunggah versi HLS ke Azure: ${blobPath}`);
            uploadCache.set(blobPath, 'READY');
            uploadProgressCache.delete(blobPath);
            activeUploadControllers.delete(blobPath);
            failureCountCache.delete(blobPath); // Hapus count jika sukses

        } catch (err) {
            if (globalAbort.signal.aborted || err.message === 'UPLOAD_CANCELLED' || err.code === 'ERR_CANCELED') {
                console.info(`[Azure Uploader] Upload dibatalkan oleh pengguna: ${blobPath}`);
                uploadCache.del(blobPath);
                uploadProgressCache.delete(blobPath);
            } else {
                console.error(`[Azure Uploader] Gagal memproses ${blobPath} dari URL ${videoUrl}:`, err.message);
                markUploadFailed(seriesSlug, episodeSlug); // Gunakan fungsi terpusat untuk logika retry
                uploadProgressCache.delete(blobPath);
            }
            // Bersihkan controller aktif — selalu dijalankan, baik cancel maupun error
            activeUploadControllers.delete(blobPath);
            // Lempar lagi agar caller (queue / smart-play) tahu ini error
            throw err;
        } finally {
            // ========================================================
            // TAHAP 4: BERSIH-BERSIH DISK VPS & ZOMBIE THREADS
            // ========================================================
            try {
                // Pastikan semua proses background dihentikan agar tidak jadi zombie
                if (!globalAbort.signal.aborted) {
                    globalAbort.abort();
                }
                
                if (fs.existsSync(tempFilePath)) fs.unlinkSync(tempFilePath);
                
                // Hapus semua potongan file .part jika ada
                for (let i = 0; i < 32; i++) {
                    const chunkPath = `${tempFilePath}.part${i}`;
                    if (fs.existsSync(chunkPath)) fs.unlinkSync(chunkPath);
                }
                
                if (hlsOutputDir && fs.existsSync(hlsOutputDir)) fs.rmSync(hlsOutputDir, { recursive: true, force: true });
                console.info(`[Azure Uploader] Disk VPS dibersihkan untuk ${blobPath}.`);
            } catch (fsErr) {
                console.warn(`[Azure Uploader] Gagal menghapus file temporary: ${fsErr.message}`);
            }
        }
    })();
}
