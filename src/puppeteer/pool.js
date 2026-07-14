// ── Facade Module: pool.js ──
// Sesuai dengan Single Responsibility Principle (SRP), tanggung jawab pool browser telah dipecah:
// 1. browserPool.js: Siklus hidup instance browser, konfigurasi page, dan pemanasan CF cookie.
// 2. concurrencyGuard.js: Mutex & FIFO slot queueing, konkurensi batas atas, serta acquire/release slot.
// 3. cookieSessionStore.js: Store thread-safe untuk penyimpanan cookie Cloudflare dan User-Agent.
// 4. circuitBreaker.js: Proteksi antrean browser dari web penyedia yang macet/down secara beruntun.

export {
    getBrowser,
    createPage,
    createExtractorPage,
    waitForCloudflare,
    refreshCfCookie,
    initPagePool,
    closeAllBrowsers
} from './browserPool.js';

export {
    acquireFromPool,
    acquireFromExtractorPool,
    releaseToPool,
    fetchPage
} from './concurrencyGuard.js';

export {
    globalCfCookie,
    globalUserAgent,
    getCfCookie,
    getCfCookiesArray,
    setCfCookie
} from './cookieSessionStore.js';

export {
    isCircuitOpen,
    recordProviderFailure,
    recordProviderSuccess
} from './circuitBreaker.js';
