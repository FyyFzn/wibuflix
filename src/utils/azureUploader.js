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
 * Performs background stream piping from source video URL to Azure Blob Storage
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
            // Setup headers for request
            const requestHeaders = {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
                ...headers
            };

            // Set up a 30-minute hard timeout because Krakenfiles limits speed to ~150KB/s (takes 15-20 mins)
            const abortController = new AbortController();
            const timeoutId = setTimeout(() => abortController.abort(), 30 * 60 * 1000);

            // Download stream from source URL
            const response = await axios({
                method: 'get',
                url: videoUrl,
                responseType: 'stream',
                headers: requestHeaders,
                timeout: 30000, // 30 seconds connection timeout
                signal: abortController.signal
            });

            // Progress tracking
            let downloadedBytes = 0;
            const logInterval = 50 * 1024 * 1024; // Log setiap 50MB agar console tidak penuh
            let nextLogThreshold = logInterval;

            response.data.on('data', (chunk) => {
                downloadedBytes += chunk.length;
                if (downloadedBytes >= nextLogThreshold) {
                    console.info(`[Azure Uploader] Progress ${blobPath}: ${Math.round(downloadedBytes / 1024 / 1024)}MB downloaded...`);
                    nextLogThreshold += logInterval;
                }
            });

            response.data.on('end', () => {
                console.info(`[Azure Uploader] Selesai mendownload dari source: ${blobPath} (Total: ${Math.round(downloadedBytes / 1024 / 1024)}MB)`);
            });

            response.data.on('error', (err) => {
                console.error(`[Azure Uploader] Stream download error untuk ${blobPath}:`, err.message);
            });

            const blockBlobClient = containerClient.getBlockBlobClient(blobPath);
            
            try {
                // Pipe stream to block blob
                await blockBlobClient.uploadStream(
                    response.data,
                    4 * 1024 * 1024, // 4MB buffer size
                    5, // reduced max concurrency to 5 to save memory and prevent connection drops
                    {
                        blobHTTPHeaders: {
                            blobContentType: 'video/mp4'
                        },
                        abortSignal: abortController.signal
                    }
                );
            } finally {
                clearTimeout(timeoutId);
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
