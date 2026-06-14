import { EventEmitter } from 'events';
import QueueTask from '../models/QueueTask.js';
import { getActiveUploadCount, cancelUpload } from './azureUploader.js';

class QueueManager extends EventEmitter {
    constructor() {
        super();
        this.isProcessing = false;
        this.processor = null;
    }

    setProcessor(processorFn) {
        this.processor = processorFn;
    }

    async add(episodeUrl, seriesSlug, seriesTitle, episodeTitle) {
        // Cek jika sudah ada
        let task = await QueueTask.findOne({ episodeUrl });
        if (task) {
            // Jika sudah gagal atau di-cancel, kembalikan ke PENDING
            if (task.status === 'FAILED' || task.status === 'CANCELLED') {
                task.status = 'PENDING';
                task.progress = 'Masuk ke antrean ulang...';
                await task.save();
                this.processNext();
            }
            return task;
        }

        const id = Date.now().toString() + Math.random().toString(36).substring(7);
        task = new QueueTask({
            id,
            episodeUrl,
            seriesSlug,
            seriesTitle,
            episodeTitle,
            status: 'PENDING',
            priority: 0
        });

        await task.save();
        console.info(`[Queue] Ditambahkan ke MongoDB queue: ${episodeTitle}`);
        this.processNext();
        return task;
    }

    async prioritize(id) {
        const task = await QueueTask.findOne({ id });
        if (task) {
            // Beri nilai priority sangat tinggi agar berada di urutan teratas
            task.priority = Date.now(); 
            await task.save();
            console.info(`[Queue] Diprioritaskan: ${task.episodeTitle}`);
        }
    }

    async cancel(id) {
        const task = await QueueTask.findOne({ id });
        if (task) {
            if (task.status === 'PENDING' || task.status === 'FAILED' || task.status === 'COMPLETED') {
                task.status = 'CANCELLED';
                await task.save();
                console.info(`[Queue] Antrean disembunyikan/dibatalkan: ${task.episodeTitle}`);
            } else if (task.status === 'UPLOADING') {
                // Biarkan Azure Uploader membatalkannya melalui AbortController
                // Kita juga update statusnya di DB
                task.status = 'CANCELLED';
                await task.save();
                console.info(`[Queue] Minta batal upload: ${task.episodeTitle}`);
            }
        }
    }

    async getStatus() {
        // Tampilkan semua task (termasuk yang sudah COMPLETED agar user tahu)
        return await QueueTask.find({ status: { $in: ['PENDING', 'UPLOADING', 'FAILED', 'COMPLETED'] } })
            .sort({ priority: -1, createdAt: 1 })
            .limit(100) // Batasi 100 riwayat agar app tidak lag
            .lean();
    }

    async removeByUrl(episodeUrl) {
        await QueueTask.deleteOne({ episodeUrl });
    }

    async updateProgress(episodeUrl, progressMsg) {
        // Optimisasi: Kita bisa update database, tapi agar tidak terlalu berat, kita batasi.
        // Fungsi ini opsional karena progress real-time bisa disuplai via cacheMemory.
        await QueueTask.updateOne({ episodeUrl }, { $set: { progress: progressMsg } });
    }

    async processNext() {
        if (this.isProcessing) return;
        if (!this.processor) return;

        // Ambil PENDING task urutan pertama (berdasarkan priority tertinggi, lalu waktu terlama)
        const nextItem = await QueueTask.findOne({ status: 'PENDING' })
            .sort({ priority: -1, createdAt: 1 });

        if (!nextItem) return;

        // Batasi 1 proses paralel
        this.isProcessing = true;
        
        // Ubah status
        nextItem.status = 'UPLOADING';
        nextItem.progress = 'Mulai memproses...';
        await nextItem.save();

        console.info(`[Queue] Memproses unduhan: ${nextItem.episodeTitle}`);

        try {
            await this.processor(nextItem);
            // Jika sukses, ubah status ke COMPLETED (bisa juga dihapus jika ingin hemat DB)
            nextItem.status = 'COMPLETED';
            nextItem.progress = 'Selesai';
            await nextItem.save();
        } catch (err) {
            console.error(`[Queue Error] ${nextItem.episodeTitle}:`, err.message);
            
            // Retry mechanism via counter custom
            const currentRetries = nextItem.priority < 0 ? Math.abs(nextItem.priority) : 0;
            if (currentRetries < 2) {
                console.info(`[Queue Retry] Mengulang ${nextItem.episodeTitle} (Percobaan ke-${currentRetries + 2})...`);
                nextItem.status = 'PENDING';
                nextItem.priority = -(currentRetries + 1); // Menggunakan minus priority untuk retry
                nextItem.progress = `Gagal: ${err.message}. Menunggu dicoba ulang...`;
                await nextItem.save();
            } else {
                console.warn(`[Queue Failed] ${nextItem.episodeTitle} gagal total.`);
                nextItem.status = 'FAILED';
                nextItem.progress = `Gagal Total: ${err.message}`;
                await nextItem.save();
            }
        } finally {
            this.isProcessing = false;
            // Lanjut periksa antrean berikutnya
            setTimeout(() => this.processNext(), 5000);
        }
    }
    
    // Dipanggil saat server baru menyala (Auto-Resume)
    async resumeOrphanedTasks() {
        console.info(`[Queue] Mengecek tugas yang terputus saat server mati...`);
        // Semua yang UPLOADING tapi servernya baru nyala, berarti terputus. Kembalikan ke PENDING.
        const result = await QueueTask.updateMany(
            { status: 'UPLOADING' },
            { $set: { status: 'PENDING', progress: 'Diresume setelah server restart' } }
        );
        
        if (result.modifiedCount > 0) {
            console.info(`[Queue] Berhasil meresume ${result.modifiedCount} tugas terputus ke PENDING.`);
        }
        
        // Mulai memutar roda antrean
        this.processNext();
    }
}

export const backgroundQueue = new QueueManager();
