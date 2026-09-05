import fs from 'fs';
import path from 'path';
import { containerClient } from './blobStorageService.js';
import { uploadProgressCache } from './streamStateStore.js';

/**
 * Mengunggah satu file (.ts atau .m3u8) dari lokal ke Azure Blob Storage.
 */
export async function uploadSingleFileToAzure(localPath, azureDest, globalAbort) {
    if (!fs.existsSync(localPath)) return false;
    const stats = fs.statSync(localPath);
    if (stats.size === 0) return false;

    const type = localPath.endsWith('.m3u8') ? 'application/vnd.apple.mpegurl' : 'video/mp2t';
    const blockBlobClient = containerClient.getBlockBlobClient(azureDest);
    
    await blockBlobClient.uploadFile(localPath, {
        blobHTTPHeaders: { 
            blobContentType: type, 
            blobCacheControl: 'public, max-age=31536000' 
        },
        abortSignal: globalAbort.signal
    });
    try { fs.promises.unlink(localPath).catch(() => {}); } catch (e) {}
    return true;
}

/**
 * Mengunggah potongan segmen .ts menggunakan direktori staging (.uploading) untuk mencegah bentrok lock I/O.
 */
export async function uploadSegmentStaged(localPath, azureDest, globalAbort, blobPath, totalUploadedChunksRef) {
    if (!fs.existsSync(localPath)) return false;
    const stats = fs.statSync(localPath);
    if (stats.size === 0) return false;

    const stagingPath = localPath + '.uploading';
    try {
        fs.renameSync(localPath, stagingPath);
    } catch (renameErr) {
        return false;
    }

    const blockBlobClient = containerClient.getBlockBlobClient(azureDest);
    await blockBlobClient.uploadFile(stagingPath, {
        blobHTTPHeaders: { 
            blobContentType: 'video/mp2t', 
            blobCacheControl: 'public, max-age=31536000' 
        },
        abortSignal: globalAbort.signal
    });
    
    try { fs.promises.unlink(stagingPath).catch(() => {}); } catch (e) {}
    totalUploadedChunksRef.count++;
    if (blobPath) {
        uploadProgressCache.set(blobPath, `Mengalirkan video ke Cloud Storage... (Segment ${totalUploadedChunksRef.count} terkirim)`);
    }
    return true;
}

/**
 * Menyapu sisa file terakhir (termasuk playlist.m3u8) sesudah FFmpeg selesai.
 */
export async function uploadRemainingFilesToAzure(hlsOutputDir, baseAzurePath, globalAbort, uploadLimit) {
    const remainingFiles = fs.readdirSync(hlsOutputDir);
    await Promise.all(remainingFiles.map(file => uploadLimit(async () => {
        const localPath = path.join(hlsOutputDir, file);
        if (file.endsWith('.tmp') || file.endsWith('.uploading')) return;
        const azureDest = `${baseAzurePath}/${file}`;
        await uploadSingleFileToAzure(localPath, azureDest, globalAbort);
    })));
}
