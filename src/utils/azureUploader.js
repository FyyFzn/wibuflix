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
    
    // Jika user mengonfigurasi CDN, timpa URL base-nya
    const cdnUrl = process.env.AZURE_CDN_URL;
    if (cdnUrl) {
        try {
            const parsedRaw = new URL(rawUrl);
            const parsedCdn = new URL(cdnUrl);
            // Gabungkan host CDN dengan path asli dari Blob
            return `${parsedCdn.origin}${parsedRaw.pathname}${parsedRaw.search}`;
        } catch (e) {
            console.error('[Azure Uploader] URL CDN tidak valid, kembali ke URL Blob default.');
            return rawUrl;
        }
    }
    
    return rawUrl;
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
    
    // Check in-memory cache first
    const cachedStatus = uploadCache.get(blobPath);
    if (cachedStatus === 'READY' || cachedStatus === 'UPLOADING') {
        return cachedStatus;
    }

    if (!containerClient) return null;

    try {
        await ensureContainerExists();
        const blockBlobClient = containerClient.getBlockBlobClient(blobPath);
        const exists = await blockBlobClient.exists();
        if (exists) {
            uploadCache.set(blobPath, 'READY');
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
    uploadCache.set(blobPath, 'UPLOADING');
    console.info(`[Azure Uploader] Starting upload for ${blobPath} from ${videoUrl}`);

    // Return the upload promise so callers can wait for it if they want
    return (async () => {
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
                
                const chunkSize = 4 * 1024 * 1024; // 4MB per block (Aman untuk B1)
                const concurrencyLimit = 8; // Max 8 koneksi paralel (Aman untuk B1)
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
                        const block = blocks[blockIndex++];
                        let attempt = 0;
                        let success = false;

                        while (attempt < 3 && !success) {
                            try {
                                const res = await axios.get(videoUrl, {
                                    headers: { ...requestHeaders, 'Range': `bytes=${block.start}-${block.end}` },
                                    responseType: 'arraybuffer',
                                    timeout: 30000
                                });
                                
                                await blockBlobClient.stageBlock(block.blockId, res.data, res.data.byteLength);
                                totalDownloadedBytes += res.data.byteLength;
                                success = true;
                                completedChunks++;
                                
                                if (completedChunks % 5 === 0 || completedChunks === blocks.length) {
                                    console.info(`[Azure Uploader] Progress Multi-Thread ${blobPath}: ${completedChunks}/${blocks.length} blocks (${Math.round(totalDownloadedBytes / 1024 / 1024)}MB)...`);
                                }
                            } catch (err) {
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
                await blockBlobClient.commitBlockList(blockIds, {
                    blobHTTPHeaders: { blobContentType: 'video/mp4' }
                });
                
                console.info(`[Azure Uploader] Selesai merakit multi-thread: ${blobPath}`);

            } else {
                // ========================================================
                // SINGLE STREAM UPLOAD (FALLBACK)
                // ========================================================
                console.info(`[Azure Uploader] Menggunakan fallback SINGLE-STREAM untuk ${blobPath}`);
                const abortController = new AbortController();
                const timeoutId = setTimeout(() => abortController.abort(), 30 * 60 * 1000);

                const response = await axios({
                    method: 'get',
                    url: videoUrl,
                    responseType: 'stream',
                    headers: requestHeaders,
                    timeout: 30000,
                    signal: abortController.signal
                });

                let nextLogThreshold = 50 * 1024 * 1024;
                response.data.on('data', (chunk) => {
                    totalDownloadedBytes += chunk.length;
                    if (totalDownloadedBytes >= nextLogThreshold) {
                        console.info(`[Azure Uploader] Progress Stream ${blobPath}: ${Math.round(totalDownloadedBytes / 1024 / 1024)}MB downloaded...`);
                        nextLogThreshold += 50 * 1024 * 1024;
                    }
                });

                try {
                    await blockBlobClient.uploadStream(response.data, 4 * 1024 * 1024, 5, {
                        blobHTTPHeaders: { blobContentType: 'video/mp4' },
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

        } catch (err) {
            console.error(`[Azure Uploader] Failed to upload ${blobPath} from URL ${videoUrl}:`, err.message);
            uploadCache.set(blobPath, 'FAILED', 600); // Fail for 10 minutes
            
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
