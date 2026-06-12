import { BlobServiceClient } from '@azure/storage-blob';
import axios from 'axios';
import { getCache } from './cacheManager.js';

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

export const uploadProgressCache = new Map();
export const activeUploadControllers = new Map();

/**
 * Returns the current upload progress string for a given blob.
 */
export function getUploadProgress(seriesSlug, episodeSlug) {
    const blobPath = getBlobPath(seriesSlug, episodeSlug);
    return uploadProgressCache.get(blobPath) || 'Menyiapkan video...';
}

/**
 * Cancels all currently active uploads.
 */
export function cancelAllUploads() {
    let count = 0;
    for (const [blobPath, controller] of activeUploadControllers.entries()) {
        controller.abort();
        console.info(`[Azure Uploader] Cancelled upload for ${blobPath}`);
        count++;
    }
    activeUploadControllers.clear();
    return count;
}

/**
 * Normalizes and formats the blob path for Azure
 */
export function getBlobPath(seriesSlug, episodeSlug) {
    return `videos/${seriesSlug}/${episodeSlug}.mp4`;
}

/**
 * Gets the direct URL of a blob
 */
export function getBlobUrl(blobPath) {
    if (!containerClient) return '';
    const rawUrl = containerClient.getBlockBlobClient(blobPath).url;
    
    // Gunakan Azure CDN jika dikonfigurasi di environment variables
    const cdnUrl = process.env.AZURE_CDN_URL;
    if (cdnUrl) {
        try {
            const parsedRaw = new URL(rawUrl);
            // Tambahkan protokol otomatis jika user lupa memasukkan https://
            const validCdnUrl = cdnUrl.startsWith('http') ? cdnUrl : `https://${cdnUrl}`;
            const parsedCdn = new URL(validCdnUrl);
            
            // Gabungkan host CDN dengan path asli dan ubah spasi menjadi %20 agar tidak error di player
            return `${parsedCdn.origin}${parsedRaw.pathname}${parsedRaw.search}`.replace(/ /g, '%20');
        } catch (e) {
            console.error('[Azure Uploader] URL CDN tidak valid, kembali ke URL Blob default.');
        }
    }
    
    // Fallback: Mengambil video langsung dari Azure Storage Blob
    
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
 * Marks the upload as failed in the cache with a 10-minute TTL
 */
export function markUploadFailed(seriesSlug, episodeSlug) {
    const blobPath = getBlobPath(seriesSlug, episodeSlug);
    uploadCache.set(blobPath, 'FAILED', 600); // 10 minutes failure cache TTL
}

/**
 * Checks if there is any active upload for a specific series.
 */
export function hasActiveUploadForSeries(seriesSlug) {
    const prefix = `videos/${seriesSlug}/`;
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
 * Melakukan download multi-thread (jika didukung) atau single-stream, lalu upload ke Azure Blob Storage
 */
export async function uploadStream(videoUrl, headers = {}, seriesSlug, episodeSlug) {
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
        activeUploadControllers.set(blobPath, globalAbort);
        
        try {
            const requestHeaders = {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
                ...headers
            };

            const blockBlobClient = containerClient.getBlockBlobClient(blobPath);

            // 1. Pre-flight check: Apakah server mendukung Range Request?
            let supportsRange = false;
            let contentLength = 0;
            try {
                const headRes = await axios.get(videoUrl, {
                    headers: { ...requestHeaders, 'Range': 'bytes=0-0' },
                    timeout: 10000,
                    responseType: 'arraybuffer'
                });
                
                if (headRes.status === 206) {
                    supportsRange = true;
                    const contentRange = headRes.headers['content-range'];
                    if (contentRange) {
                        contentLength = parseInt(contentRange.split('/')[1]);
                    }
                } else if (headRes.headers['content-length']) {
                    contentLength = parseInt(headRes.headers['content-length']);
                }
            } catch (e) {
                console.warn(`[Azure Uploader] Pre-flight check failed, fallback to single-stream. Error: ${e.message}`);
            }

            const MIN_VIDEO_SIZE = 100 * 1024; // 100 KB
            let totalDownloadedBytes = 0;

            if (supportsRange && contentLength > MIN_VIDEO_SIZE) {
                // ========================================================
                // JDOWNLOADER-STYLE MULTI-THREADED UPLOAD (B1 SAFE-MODE)
                // ========================================================
                console.info(`[Azure Uploader] Server supports Range! Starting MULTI-THREADED download for ${blobPath} (${Math.round(contentLength / 1024 / 1024)}MB)`);
                
                const chunkSize = 4 * 1024 * 1024; // 4MB per block
                let concurrencyLimit = 20; // Default untuk hoster normal
                if (videoUrl.includes('mega') || videoUrl.includes('/proxy/mega')) {
                    concurrencyLimit = 2; // Mega memblokir (ETOOMANY / -6) jika terlalu banyak koneksi
                }
                const blocks = [];
                const blockIds = [];
                
                for (let i = 0; i < contentLength; i += chunkSize) {
                    const end = Math.min(i + chunkSize - 1, contentLength - 1);
                    // Block ID harus panjangnya sama dan Base64 encoded
                    const blockId = Buffer.from(String(blocks.length).padStart(6, '0')).toString('base64');
                    blocks.push({ start: i, end, blockId, index: blocks.length });
                    blockIds.push(blockId);
                }

                let completedChunks = 0;
                let activeWorkers = 0;
                let blockIndex = 0;

                // Promise pool worker
                const worker = async () => {
                    while (blockIndex < blocks.length) {
                        if (globalAbort.signal.aborted) throw new Error('UPLOAD_CANCELLED');
                        const block = blocks[blockIndex++];
                        let attempt = 0;
                        let success = false;

                        while (attempt < 3 && !success) {
                            let chunkTimeout;
                            let onGlobalAbort;
                            try {
                                const chunkAbort = new AbortController();
                                chunkTimeout = setTimeout(() => chunkAbort.abort(), 60000); // 60s hard timeout per chunk
                                
                                onGlobalAbort = () => chunkAbort.abort();
                                globalAbort.signal.addEventListener('abort', onGlobalAbort);
                                
                                const res = await axios.get(videoUrl, {
                                    headers: { ...requestHeaders, 'Range': `bytes=${block.start}-${block.end}` },
                                    responseType: 'arraybuffer',
                                    signal: chunkAbort.signal
                                });
                                clearTimeout(chunkTimeout);
                                globalAbort.signal.removeEventListener('abort', onGlobalAbort);
                                
                                await blockBlobClient.stageBlock(block.blockId, res.data, res.data.byteLength);
                                totalDownloadedBytes += res.data.byteLength;
                                success = true;
                                completedChunks++;
                                
                                if (completedChunks % 5 === 0 || completedChunks === blocks.length) {
                                    const percent = Math.round((completedChunks / blocks.length) * 100);
                                    const downloadedMB = Math.round(totalDownloadedBytes / 1024 / 1024);
                                    const totalMB = Math.round(contentLength / 1024 / 1024);
                                    const msg = `Mengunggah: ${percent}% (${downloadedMB}MB / ${totalMB}MB)`;
                                    
                                    console.info(`[Azure Uploader] ${blobPath} - ${msg}`);
                                    uploadProgressCache.set(blobPath, msg);
                                }
                            } catch (err) {
                                if (chunkTimeout) clearTimeout(chunkTimeout);
                                if (onGlobalAbort) globalAbort.signal.removeEventListener('abort', onGlobalAbort);
                                if (globalAbort.signal.aborted) throw new Error('UPLOAD_CANCELLED');
                                
                                attempt++;
                                console.warn(`[Azure Uploader] Gagal chunk ${block.index} (attempt ${attempt}/3): ${err.message}`);
                                if (attempt === 3) throw err;
                                await new Promise(r => setTimeout(r, 2000));
                            }
                        }
                    }
                };

                const workers = [];
                for (let i = 0; i < Math.min(concurrencyLimit, blocks.length); i++) {
                    workers.push(worker());
                }

                await Promise.all(workers);

                // Gabungkan semua block
                console.info(`[Azure Uploader] Semua chunk terunduh. Menggabungkan ${blocks.length} blocks untuk ${blobPath}...`);
                const commitAbort = new AbortController();
                const commitTimeout = setTimeout(() => commitAbort.abort(), 120000); // 2 menit hard timeout
                
                await blockBlobClient.commitBlockList(blockIds, {
                    blobHTTPHeaders: { 
                        blobContentType: 'video/mp4',
                        blobCacheControl: 'public, max-age=31536000' // Cache 1 tahun di CDN
                    },
                    abortSignal: commitAbort.signal
                });
                clearTimeout(commitTimeout);
                
                console.info(`[Azure Uploader] Selesai merakit multi-thread: ${blobPath}`);

            } else {
                // ========================================================
                // SINGLE STREAM UPLOAD (FALLBACK)
                // ========================================================
                console.info(`[Azure Uploader] Menggunakan fallback SINGLE-STREAM untuk ${blobPath}`);
                const abortController = new AbortController();
                const timeoutId = setTimeout(() => abortController.abort(), 30 * 60 * 1000);
                
                // Jika globalAbort dibatalkan, batalkan juga abortController
                globalAbort.signal.addEventListener('abort', () => abortController.abort());

                const response = await axios({
                    method: 'get',
                    url: videoUrl,
                    responseType: 'stream',
                    headers: requestHeaders,
                    timeout: 30000,
                    signal: abortController.signal
                });

                let nextLogThreshold = 5 * 1024 * 1024;
                response.data.on('data', (chunk) => {
                    totalDownloadedBytes += chunk.length;
                    if (totalDownloadedBytes >= nextLogThreshold) {
                        const downloadedMB = Math.round(totalDownloadedBytes / 1024 / 1024);
                        const msg = contentLength > MIN_VIDEO_SIZE 
                            ? `Mengunggah: ${Math.round((totalDownloadedBytes / contentLength) * 100)}% (${downloadedMB}MB / ${Math.round(contentLength / 1024 / 1024)}MB)`
                            : `Mengunggah: ${downloadedMB}MB...`;
                            
                        console.info(`[Azure Uploader] ${blobPath} - ${msg}`);
                        uploadProgressCache.set(blobPath, msg);
                        nextLogThreshold += 5 * 1024 * 1024;
                    }
                });

                try {
                    await blockBlobClient.uploadStream(response.data, 4 * 1024 * 1024, 5, {
                        blobHTTPHeaders: { 
                            blobContentType: 'video/mp4',
                            blobCacheControl: 'public, max-age=31536000' // Cache 1 tahun di CDN
                        },
                        abortSignal: abortController.signal
                    });
                } finally {
                    clearTimeout(timeoutId);
                }
            }

            // Validasi akhir ukuran file
            if (totalDownloadedBytes < MIN_VIDEO_SIZE) {
                await blockBlobClient.deleteIfExists();
                throw new Error(`[Azure Uploader] File terlalu kecil (${totalDownloadedBytes} bytes) — URL mungkin bukan direct link video. Dihapus dari Azure.`);
            }

            console.info(`[Azure Uploader] Successfully uploaded to Azure: ${blobPath}`);
            uploadCache.set(blobPath, 'READY');
            uploadProgressCache.delete(blobPath);
            activeUploadControllers.delete(blobPath);

        } catch (err) {
            if (globalAbort.signal.aborted || err.message === 'UPLOAD_CANCELLED' || err.code === 'ERR_CANCELED') {
                console.info(`[Azure Uploader] Upload cancelled explicitly: ${blobPath}`);
                uploadCache.delete(blobPath);
                uploadProgressCache.delete(blobPath);
            } else {
                console.error(`[Azure Uploader] Failed to upload ${blobPath} from URL ${videoUrl}:`, err.message);
                uploadCache.set(blobPath, 'FAILED', 600); // Fail for 10 minutes
                uploadProgressCache.delete(blobPath);
            }
            
            activeUploadControllers.delete(blobPath);
            
            // Cleanup partial upload if it exists
            try {
                const blockBlobClient = containerClient.getBlockBlobClient(blobPath);
                await blockBlobClient.deleteIfExists();
                console.info(`[Azure Uploader] Cleaned up partial/failed blob: ${blobPath}`);
            } catch (cleanupErr) {
                console.error(`[Azure Uploader] Failed to clean up failed blob ${blobPath}:`, cleanupErr.message);
            }
        }
    })();
}
