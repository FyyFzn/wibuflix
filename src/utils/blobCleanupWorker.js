import { containerClient, ensureContainerExists } from '../services/stream/blobStorageService.js';

const STALE_THRESHOLD_MS = 7 * 24 * 60 * 60 * 1000;

async function deleteStaleBlobs() {
    if (!containerClient) return;
    try {
        await ensureContainerExists();
        let deleted = 0;
        for await (const item of containerClient.listBlobsFlat()) {
            if (item.properties?.createdOn) {
                const age = Date.now() - new Date(item.properties.createdOn).getTime();
                if (age > STALE_THRESHOLD_MS) {
                    await containerClient.getBlockBlobClient(item.name).deleteIfExists();
                    console.log(`[BlobCleanup] Menghapus blob kadaluarsa: ${item.name}`);
                    deleted++;
                }
            }
        }
        if (deleted > 0) {
            console.info(`[BlobCleanup] Selesai. Total dihapus: ${deleted} blob.`);
        } else {
            console.info('[BlobCleanup] Tidak ada blob kadaluarsa yang ditemukan.');
        }
    } catch (err) {
        console.error(`[BlobCleanup] Gagal membersihkan blob: ${err.message}`);
    }
}

export function scheduledBlobCleanup() {
    setTimeout(() => deleteStaleBlobs(), 30000);
    setInterval(() => deleteStaleBlobs(), 24 * 60 * 60 * 1000);
}
