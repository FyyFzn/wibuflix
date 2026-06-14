import { syncUnified } from '../sync/unified_sync.js';
import { startBackgroundAnimeSync } from '../sync/anime_sync.js';
import { startBackgroundOtakuSync } from '../sync/otaku_sync.js';
import { startBackgroundLatestSync } from '../sync/latest_sync.js';
import { syncNeosatsu } from '../sync/neosatsu_sync.js';

export function initScheduler() {
    const log = global.forceLog || console.log;
    log('⏳ [Scheduler] Memulai inisialisasi background jobs...');

    // 1. Memulai sync aktif (real-time listeners)
    startBackgroundAnimeSync();
    startBackgroundOtakuSync();
    startBackgroundLatestSync();

    // 2. Memulai proses unified sync (dijadwalkan setelah 10 detik agar server stabil)
    setTimeout(() => {
        syncUnified();
        // Jadwalkan sinkronisasi berulang tiap jam
        setInterval(syncUnified, 60 * 60 * 1000);
        
        // Neosatsu sync setiap 7 hari (604800000 ms)
        syncNeosatsu().catch(err => console.error("[Scheduler] Error Neosatsu Sync:", err));
        setInterval(() => {
            syncNeosatsu().catch(err => console.error("[Scheduler] Error Neosatsu Sync:", err));
        }, 604800000);
        
    }, 10000);

    log('✅ [Scheduler] Semua background jobs berhasil dijadwalkan!');
}
