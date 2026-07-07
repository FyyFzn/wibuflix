import { BlobServiceClient } from '@azure/storage-blob';
import { uploadCache } from './streamStateStore.js';

const connectionString = process.env.AZURE_STORAGE_CONNECTION_STRING;
const containerName = process.env.AZURE_STORAGE_CONTAINER_NAME || 'videos';

export let containerClient = null;
let isContainerInitialized = false;

if (connectionString) {
    try {
        const blobServiceClient = BlobServiceClient.fromConnectionString(connectionString);
        containerClient = blobServiceClient.getContainerClient(containerName);
    } catch (err) {
        console.error('[BlobStorage] Failed to create ContainerClient:', err.message);
    }
} else {
    console.warn('[BlobStorage] WARNING: AZURE_STORAGE_CONNECTION_STRING is not set. Azure upload will be disabled.');
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
export async function ensureContainerExists() {
    if (!containerClient || isContainerInitialized) return;
    try {
        await containerClient.createIfNotExists({
            access: 'blob'
        });
        isContainerInitialized = true;
        console.info(`[BlobStorage] Container "${containerName}" is ready.`);
    } catch (err) {
        console.error(`[BlobStorage] Failed to ensure container exists:`, err.message);
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
        console.error(`[BlobStorage] Error checking blob existence for ${blobPath}:`, err.message);
    }

    return cachedStatus || null;
}

/**
 * Memeriksa status upload dengan mekanisme fallback (Pengecekan Ganda).
 * Mencari di folder baru (seriesSlug), lalu jika tidak ada, mencari di folder lama (oldSeriesSlug).
 * Atau menerima array of slugs untuk memeriksa beberapa fallback sekaligus.
 * Mendukung episodeSlug berupa array untuk backward compatibility penamaan folder episode.
 */
export async function checkUploadStatusWithFallback(seriesSlug, episodeSlug, oldSeriesSlug) {
    const seriesSlugs = Array.isArray(seriesSlug) ? seriesSlug : [seriesSlug, oldSeriesSlug].filter(Boolean);
    const episodeSlugs = Array.isArray(episodeSlug) ? episodeSlug : [episodeSlug].filter(Boolean);

    for (const sSlug of seriesSlugs) {
        if (!sSlug) continue;
        for (const eSlug of episodeSlugs) {
            if (!eSlug) continue;
            let status = await checkUploadStatus(sSlug, eSlug);
            if (status !== null) {
                return { status, activeSeriesSlug: sSlug, activeEpisodeSlug: eSlug };
            }
        }
    }
    
    // Jika tidak ada di keduanya, kembalikan null dan gunakan folder utama untuk upload selanjutnya
    return { 
        status: null, 
        activeSeriesSlug: seriesSlugs[0] || 'uncategorized',
        activeEpisodeSlug: episodeSlugs[0] || 'uncategorized_ep'
    };
}

/**
 * Menghapus file secara langsung dari Azure Storage (jika ada).
 */
export async function deleteBlobFromAzure(blobPath) {
    if (!containerClient) return;
    try {
        await ensureContainerExists();
        const blockBlobClient = containerClient.getBlockBlobClient(blobPath);
        await blockBlobClient.deleteIfExists();
    } catch (err) {
        console.warn(`[BlobStorage] Gagal menghapus blob ${blobPath}:`, err.message);
    }
}
