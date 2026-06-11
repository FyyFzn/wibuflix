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
    return containerClient.getBlockBlobClient(blobPath).url;
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
        console.log(`[Azure Uploader] Container "${containerName}" is ready.`);
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
 * Performs background stream piping from source video URL to Azure Blob Storage
 */
export async function uploadStream(videoUrl, headers = {}, seriesSlug, episodeSlug) {
    const blobPath = getBlobPath(seriesSlug, episodeSlug);
    
    if (!containerClient) {
        console.error('[Azure Uploader] Cannot upload: Container client is not configured.');
        uploadCache.set(blobPath, 'FAILED');
        return;
    }

    await ensureContainerExists();
    uploadCache.set(blobPath, 'UPLOADING');
    console.log(`[Azure Uploader] Starting upload for ${blobPath} from ${videoUrl}`);

    // Run the upload in background
    (async () => {
        try {
            // Setup headers for request
            const requestHeaders = {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
                ...headers
            };

            // Download stream from source URL
            const response = await axios({
                method: 'get',
                url: videoUrl,
                responseType: 'stream',
                headers: requestHeaders,
                timeout: 30000 // 30 seconds connection timeout
            });

            const blockBlobClient = containerClient.getBlockBlobClient(blobPath);
            
            // Pipe stream to block blob
            await blockBlobClient.uploadStream(
                response.data,
                4 * 1024 * 1024, // 4MB buffer size
                20, // max concurrency
                {
                    blobHTTPHeaders: {
                        blobContentType: 'video/mp4'
                    }
                }
            );

            console.log(`[Azure Uploader] Successfully uploaded to Azure: ${blobPath}`);
            uploadCache.set(blobPath, 'READY');
        } catch (err) {
            console.error(`[Azure Uploader] Failed to upload ${blobPath}:`, err.message);
            uploadCache.set(blobPath, 'FAILED');
            
            // Cleanup partial upload if it exists
            try {
                const blockBlobClient = containerClient.getBlockBlobClient(blobPath);
                await blockBlobClient.deleteIfExists();
                console.log(`[Azure Uploader] Cleaned up partial/failed blob: ${blobPath}`);
            } catch (cleanupErr) {
                console.error(`[Azure Uploader] Failed to clean up failed blob ${blobPath}:`, cleanupErr.message);
            }
        }
    })();
}
