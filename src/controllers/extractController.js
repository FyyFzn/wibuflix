// ── Facade Controller: extractController.js ──
// Sesuai dengan Single Responsibility Principle (SRP), tanggung jawab pengontrol telah dipisahkan:
// 1. streamPlaybackController.js: Menangani ekstraksi video, pemutaran (smart-play), status upload, & pembatalan stream.
// 2. prefetchController.js: Menangani antrean background (queue add/cancel/prioritize/status/stream).
// 3. failoverController.js: Menangani pelaporan video rusak (report-broken) dan failover otomatis.

export {
    extractVideoHandler,
    smartPlayHandler,
    uploadStatusHandler,
    cancelUploadsHandler,
    cancelStreamHandler
} from './streamPlaybackController.js';

export {
    queueAddHandler,
    queuePrioritizeHandler,
    queueCancelHandler,
    queueStatusHandler,
    queueStreamHandler
} from './prefetchController.js';

export {
    reportBrokenHandler
} from './failoverController.js';
