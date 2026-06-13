// src/utils/queueManager.js
import { EventEmitter } from 'events';
import { getActiveUploadCount } from './azureUploader.js';

class QueueManager extends EventEmitter {
    constructor() {
        super();
        this.queue = [];
        this.isProcessing = false;
        this.processor = null; // Fungsi callback untuk memproses URL
    }

    setProcessor(processorFn) {
        this.processor = processorFn;
    }

    add(episodeUrl, seriesSlug, seriesTitle, episodeTitle) {
        // Cek jika sudah ada di antrean
        const existing = this.queue.find(i => i.episodeUrl === episodeUrl);
        if (existing) return existing;

        const item = {
            id: Date.now().toString() + Math.random().toString(36).substring(7),
            episodeUrl,
            seriesSlug,
            seriesTitle,
            episodeTitle,
            status: 'PENDING', // PENDING, UPLOADING, FAILED
            createdAt: Date.now()
        };

        this.queue.push(item);
        console.info(`[Queue] Added to background queue: ${episodeTitle}`);
        this.processNext();
        return item;
    }

    prioritize(id) {
        const index = this.queue.findIndex(i => i.id === id);
        if (index > -1) {
            const item = this.queue.splice(index, 1)[0];
            // Cari index pertama yang berstatus PENDING
            const firstPendingIdx = this.queue.findIndex(i => i.status === 'PENDING');
            if (firstPendingIdx !== -1) {
                this.queue.splice(firstPendingIdx, 0, item);
            } else {
                this.queue.push(item);
            }
            console.info(`[Queue] Prioritized: ${item.episodeTitle}`);
        }
    }

    cancel(id) {
        const index = this.queue.findIndex(i => i.id === id);
        if (index > -1) {
            const item = this.queue[index];
            if (item.status === 'PENDING') {
                this.queue.splice(index, 1);
                console.info(`[Queue] Cancelled from queue: ${item.episodeTitle}`);
            } else if (item.status === 'UPLOADING') {
                // Biarkan dibatalkan dari route extract.js / azureUploader
                // Tapi kita hapus dari list
                this.queue.splice(index, 1);
            }
        }
    }

    getStatus() {
        return this.queue;
    }

    removeByUrl(episodeUrl) {
        this.queue = this.queue.filter(i => i.episodeUrl !== episodeUrl);
    }

    async processNext() {
        if (this.isProcessing) return;
        if (!this.processor) return;

        const nextItem = this.queue.find(i => i.status === 'PENDING');
        if (!nextItem) return;

        // Limit concurrent background queue upload to 1
        this.isProcessing = true;
        nextItem.status = 'UPLOADING';
        console.info(`[Queue] Processing background upload: ${nextItem.episodeTitle}`);

        try {
            await this.processor(nextItem);
            // Hapus dari antrean jika selesai sukses
            this.removeByUrl(nextItem.episodeUrl);
        } catch (err) {
            console.error(`[Queue Error] ${nextItem.episodeTitle}:`, err.message);
            
            nextItem.retryCount = (nextItem.retryCount || 0) + 1;
            if (nextItem.retryCount < 3) {
                console.info(`[Queue Retry] Mengulang ${nextItem.episodeTitle} (Percobaan ke-${nextItem.retryCount + 1})...`);
                nextItem.status = 'PENDING';
            } else {
                console.warn(`[Queue Failed] ${nextItem.episodeTitle} gagal 3 kali. Menghapus dari antrean.`);
                this.removeByUrl(nextItem.episodeUrl);
            }
        } finally {
            this.isProcessing = false;
            // Cek antrean berikutnya setelah jeda sejenak
            setTimeout(() => this.processNext(), 5000);
        }
    }
}

export const backgroundQueue = new QueueManager();
