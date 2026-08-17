import { uploadCache, globalBlacklistCache, uploadProgressCache, activeUploadControllers, failureCountCache } from './streamStateStore.js';
import { cleanTempFilesAsync } from '../../utils/tempFileCleanupWorker.js';

export { cleanTempFilesAsync };
import { getBlobPath, deleteBlobFromAzure } from './blobStorageService.js';

export function isMegaBlacklisted() {
    return !!globalBlacklistCache.get('mega_blacklist');
}

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
            const controller = data.abortController || data;
            if (typeof controller.abort === 'function') controller.abort();
            console.info(`[UploadProgress] Cancelled upload for ${blobPath} (source: ${source})`);
            activeUploadControllers.delete(blobPath);
            count++;
        }
    }
    return count;
}

/**
 * Cancels active uploads specifically targeting a specific series or episode slugs.
 */
export function cancelUploadsForSeries(slugsToCheck, source = null) {
    if (!slugsToCheck) return 0;
    const sList = Array.isArray(slugsToCheck) ? slugsToCheck : [slugsToCheck].filter(Boolean);
    let count = 0;
    for (const [blobPath, data] of activeUploadControllers.entries()) {
        const matchesSeries = sList.some(s => {
            if (!s) return false;
            const prefix = s.toString().replace(/^(mal-\d+_|db-[0-9a-fA-F]{24}_)/, '');
            return blobPath.includes(prefix);
        });
        if (matchesSeries && (!source || data.source === source)) {
            const controller = data.abortController || data;
            if (typeof controller.abort === 'function') controller.abort();
            console.info(`[UploadProgress] Cancelled targeted upload for ${blobPath} (source: ${data.source})`);
            activeUploadControllers.delete(blobPath);
            count++;
        }
    }
    return count;
}

/**
 * Marks the upload as failed in the cache, allowing up to 3 retries before permanent failure.
 */
export function markUploadFailed(seriesSlug, episodeSlug) {
    const blobPath = getBlobPath(seriesSlug, episodeSlug);
    const count = (failureCountCache.get(blobPath) || 0) + 1;
    failureCountCache.set(blobPath, count);
    
    if (count >= 5) {
        console.warn(`[UploadProgress] ${blobPath} gagal ${count} kali. Menandai sebagai FAILED permanen (10 menit).`);
        uploadCache.set(blobPath, 'FAILED', 600); // 10 minutes failure cache TTL
    } else {
        console.info(`[UploadProgress] ${blobPath} gagal ${count} kali. Menghapus cache agar bisa di-retry.`);
        uploadCache.del(blobPath);
    }
}

/**
 * Checks if there is any active upload for a specific series.
 */
export function hasActiveUploadForSeries(seriesSlug) {
    const malPrefixMatch = seriesSlug.match(/^(mal-\d+|db-[0-9a-fA-F]{24})/);
    const prefix = malPrefixMatch ? malPrefixMatch[1] : seriesSlug.replace(/^mal-\d+_/, '');
    const keys = uploadCache.keys();
    for (const key of keys) {
        if (malPrefixMatch) {
            if (key.startsWith(prefix) && uploadCache.get(key) === 'UPLOADING') {
                return true;
            }
        } else {
            const cleanKey = key.replace(/^mal-\d+_/, '');
            if (cleanKey.startsWith(`${prefix}/`) && uploadCache.get(key) === 'UPLOADING') {
                return true;
            }
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
        console.info(`[UploadProgress] Membatalkan upload untuk ${blobPath}`);
        const controller = data.abortController || data;
        if (typeof controller.abort === 'function') controller.abort();
        
        if (data.tempFilePath || data.hlsOutputDir) {
            cleanTempFilesAsync(data.tempFilePath, data.hlsOutputDir);
        }

        activeUploadControllers.delete(blobPath);
        uploadCache.del(blobPath);
        uploadProgressCache.del(blobPath);
    }
}

/**
 * Menghapus/meng-invalidasi blob dari Azure Storage dan cache saat pengguna melapor video rusak/tanpa sub.
 */
export async function invalidateAndDeleteBlob(seriesSlug, episodeSlug) {
    const seriesSlugs = Array.isArray(seriesSlug) ? seriesSlug : [seriesSlug].filter(Boolean);
    const episodeSlugs = Array.isArray(episodeSlug) ? episodeSlug : [episodeSlug].filter(Boolean);

    for (const sSlug of seriesSlugs) {
        for (const eSlug of episodeSlugs) {
            const blobPath = getBlobPath(sSlug, eSlug);
            console.info(`[UploadProgress] 🗑️ Menghapus blob rusak/tanpa sub: ${blobPath}`);
            cancelUpload(sSlug, eSlug);
            uploadCache.del(blobPath);
            failureCountCache.del(blobPath);

            await deleteBlobFromAzure(blobPath);
        }
    }
}
