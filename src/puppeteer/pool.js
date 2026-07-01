import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';

puppeteer.use(StealthPlugin());

let browserInstance = null;
const PAGE_POOL_SIZE = 2; // Dikurangi dari 4 untuk menghemat RAM Azure B1
const EXTRACTOR_POOL_SIZE = 1; // Dikurangi dari 2 untuk menghemat RAM
const pagePool = [];
const extractorPool = [];
let poolReady = false;
let activeTempPages = 0;
const MAX_TEMP_PAGES = 2; // Batasi maksimal 2 tab sementara agar RAM VPS tidak habis

export let globalCfCookie = '';
export const globalUserAgent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36';

export async function getBrowser() {
    if (browserInstance) {
        try {
            await browserInstance.version();
        } catch {
            console.log('[Browser] Instance lama mati, membuka yang baru...');
            try { browserInstance.close().catch(() => {}); } catch(e){}
            browserInstance = null;
        }
    }
    if (!browserInstance) {
        console.log('[Browser] Membuka instance baru...');
        browserInstance = await puppeteer.launch({
            headless: true,
            protocolTimeout: 120000, // 2 minutes timeout for slow B1 core
            args: [
                '--no-sandbox', 
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-gpu'
            ]
        });
    }
    return browserInstance;
}

export async function createPage(browser) {
    const page = await browser.newPage();
    await page.setUserAgent(globalUserAgent);
    await page.setRequestInterception(true);
    page.on('request', req => {
        if (req.isInterceptResolutionHandled && req.isInterceptResolutionHandled()) return;
        const type = req.resourceType();
        const url = req.url();
        if (['font', 'media'].includes(type)) return req.abort().catch(() => {});
        if (url.includes('googlesyndication') || url.includes('doubleclick') ||
            url.includes('dtscout') || url.includes('facebook.com/tr')) return req.abort().catch(() => {});
        req.continue().catch(() => {});
    });
    return page;
}

export async function createExtractorPage(browser) {
    const page = await browser.newPage();
    await page.setUserAgent(globalUserAgent);
    await page.setRequestInterception(true);
    page.on('request', req => {
        if (req.isInterceptResolutionHandled && req.isInterceptResolutionHandled()) return;
        const type = req.resourceType();
        const url = req.url();
        if (['font', 'image', 'stylesheet', 'media'].includes(type)) return req.abort().catch(() => {});
        if (url.includes('googlesyndication') || url.includes('doubleclick') ||
            url.includes('dtscout') || url.includes('facebook.com/tr')) return req.abort().catch(() => {});
        req.continue().catch(() => {});
    });
    return page;
}

export async function waitForCloudflare(page) {
    // Cloudflare Turnstile/Challenge bisa butuh hingga 10-12 detik pada server lambat
    const MAX_WAIT = 12000;
    const INTERVAL = 400;
    let elapsed = 0;
    while (elapsed < MAX_WAIT) {
        const judul = await page.title().catch(() => '');
        const titleLower = judul.toLowerCase();
        if (!titleLower.includes('just a moment') && !titleLower.includes('please wait')) return;
        await new Promise(r => setTimeout(r, INTERVAL));
        elapsed += INTERVAL;
    }
    // Jika masih CF setelah timeout, log warning tapi tidak lempar error di sini
    const finalTitle = await page.title().catch(() => '');
    if (finalTitle.toLowerCase().includes('just a moment')) {
        console.warn('[waitForCloudflare] Timeout menunggu CF challenge selesai!');
    }
}

export async function refreshCfCookie() {
    const browser = await getBrowser();
    const page = await createPage(browser);
    try {
        console.log(`[PagePool] Me-refresh CF cookie...`);
        // Gunakan networkidle2 agar CF challenge benar-benar selesai sebelum baca cookie
        await page.goto('https://v2.samehadaku.how/', { waitUntil: 'networkidle2', timeout: 60000 }).catch(() =>
            page.goto('https://v2.samehadaku.how/', { waitUntil: 'domcontentloaded', timeout: 60000 })
        );
        await waitForCloudflare(page);
        const cookies = await page.cookies();
        const cfClearance = cookies.find(c => c.name === 'cf_clearance');
        if (cfClearance) {
            globalCfCookie = `cf_clearance=${cfClearance.value};`;
            console.log(`[PagePool] cf_clearance cookie berhasil diperbarui ✓`);
        } else {
            console.warn('[PagePool] cf_clearance cookie tidak ditemukan setelah refresh.');
        }
    } catch (e) {
        console.warn(`[PagePool] Gagal me-refresh CF cookie:`, e.message);
    } finally {
        await page.close().catch(() => {});
    }
}

export async function initPagePool() {
    if (poolReady) return;
    poolReady = true;
    const browser = await getBrowser();
    
    // ── Fase 1: Warm-up 1 page untuk bypass Cloudflare ──
    const firstPage = await createPage(browser);
    try {
        console.log(`[PagePool] Warming up CF cookie (networkidle2)...`);
        // networkidle2 memastikan semua request CF challenge selesai
        await firstPage.goto('https://v2.samehadaku.how/', { waitUntil: 'networkidle2', timeout: 60000 }).catch(() =>
            firstPage.goto('https://v2.samehadaku.how/', { waitUntil: 'domcontentloaded', timeout: 60000 })
        );
        await waitForCloudflare(firstPage);
        const cookies = await firstPage.cookies();
        const cfClearance = cookies.find(c => c.name === 'cf_clearance');
        if (cfClearance) {
            globalCfCookie = `cf_clearance=${cfClearance.value};`;
            console.log(`[PagePool] cf_clearance cookie berhasil didapat untuk Axios ✓`);
        } else {
            console.warn(`[PagePool] cf_clearance tidak didapat saat warm-up — Cloudflare mungkin lebih ketat.`);
        }
        console.log(`[PagePool] CF warm-up selesai ✓`);
    } catch (e) {
        console.warn(`[PagePool] CF warm-up gagal (akan dicoba ulang saat request):`, e.message);
    }
    pagePool.push({ page: firstPage, busy: false, type: 'regular' });

    // ── Fase 2: Buat sisa page tanpa navigasi ──
    const remainingPages = [];
    for (let i = 1; i < PAGE_POOL_SIZE; i++) {
        remainingPages.push(createPage(browser).then(page => {
            pagePool.push({ page, busy: false, type: 'regular' });
            console.log(`[PagePool] Page ${i + 1} siap`);
        }));
    }
    for (let i = 0; i < EXTRACTOR_POOL_SIZE; i++) {
        remainingPages.push(createExtractorPage(browser).then(page => {
            extractorPool.push({ page, busy: false, type: 'extractor' });
            console.log(`[ExtractorPool] Page ${i + 1} siap`);
        }));
    }
    await Promise.all(remainingPages);
    console.log(`[Pool] Semua ${PAGE_POOL_SIZE + EXTRACTOR_POOL_SIZE} page siap ✓`);

    // ── Fase 3: Auto-refresh cookie setiap 30 menit ──
    // cf_clearance token Cloudflare punya TTL ~30-60 menit, jadi perlu diperbarui berkala
    setInterval(async () => {
        console.log('[PagePool] Auto-refresh CF cookie (30 menit)...');
        await refreshCfCookie().catch(e => console.warn('[PagePool] Auto-refresh gagal:', e.message));
    }, 30 * 60 * 1000);
}

export async function acquireFromPool() {
    let slot = pagePool.find(s => !s.busy);
    for (let i = 0; i < 10 && !slot; i++) {
        await new Promise(r => setTimeout(r, 1000));
        slot = pagePool.find(s => !s.busy);
    }
    if (slot) { 
        slot.busy = true; 
        if (slot.resetPromise) {
            await slot.resetPromise.catch(() => {});
            slot.resetPromise = null;
        }
        try {
            if (slot.page.isClosed()) throw new Error('closed');
            await slot.page.evaluate('1'); // Test connection
        } catch {
            console.log('[PagePool] Mendeteksi page mati di pool, memulihkan...');
            const browser = await getBrowser();
            slot.page = await createPage(browser);
        }
        return slot; 
    }
    while (activeTempPages >= MAX_TEMP_PAGES) {
        await new Promise(r => setTimeout(r, 1000));
    }
    activeTempPages++;
    console.log(`[PagePool] Membuka temporary page (${activeTempPages}/${MAX_TEMP_PAGES})...`);
    const browser = await getBrowser();
    const page = await createPage(browser);
    return { page, busy: true, temp: true, type: 'regular' };
}

export async function acquireFromExtractorPool() {
    let slot = extractorPool.find(s => !s.busy);
    for (let i = 0; i < 10 && !slot; i++) {
        await new Promise(r => setTimeout(r, 1000));
        slot = extractorPool.find(s => !s.busy);
    }
    if (slot) { 
        slot.busy = true; 
        if (slot.resetPromise) {
            await slot.resetPromise.catch(() => {});
            slot.resetPromise = null;
        }
        try {
            if (slot.page.isClosed()) throw new Error('closed');
            await slot.page.evaluate('1');
        } catch {
            console.log('[ExtractorPool] Mendeteksi page mati di pool, memulihkan...');
            const browser = await getBrowser();
            slot.page = await createExtractorPage(browser);
        }
        return slot; 
    }
    while (activeTempPages >= MAX_TEMP_PAGES) {
        await new Promise(r => setTimeout(r, 1000));
    }
    activeTempPages++;
    console.log(`[ExtractorPool] Membuka temporary extractor page (${activeTempPages}/${MAX_TEMP_PAGES})...`);
    const browser = await getBrowser();
    const page = await createExtractorPage(browser);
    return { page, busy: true, temp: true, type: 'extractor' };
}

export function releaseToPool(slot) {
    if (!slot) return;
    if (slot.temp) { 
        if (activeTempPages > 0) activeTempPages--;
        slot.page.close().catch(() => { }); 
        return; 
    }
    try {
        slot.page.removeAllListeners('request');
        slot.page.removeAllListeners('response');
        slot.page.setRequestInterception(true).catch(() => {});
        slot.page.on('request', req => {
            if (req.isInterceptResolutionHandled && req.isInterceptResolutionHandled()) return;
            const type = req.resourceType();
            const url = req.url();
            const blockedTypes = slot.type === 'extractor' ? ['font', 'image', 'stylesheet', 'media'] : ['font', 'media'];
            if (blockedTypes.includes(type)) return req.abort().catch(() => {});
            if (url.includes('googlesyndication') || url.includes('doubleclick') ||
                url.includes('dtscout') || url.includes('facebook.com/tr')) return req.abort().catch(() => {});
            req.continue().catch(() => {});
        });
    } catch (e) {}

    if (slot.type === 'extractor' || slot.type === 'regular') {
        slot.resetPromise = slot.page.goto('about:blank').catch(() => {});
    }
    slot.busy = false;
}

export async function fetchPage(url) {
    const slot = await acquireFromPool();
    try {
        await slot.page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
        await waitForCloudflare(slot.page);
        return slot;
    } catch (err) {
        releaseToPool(slot);
        throw err;
    }
}


