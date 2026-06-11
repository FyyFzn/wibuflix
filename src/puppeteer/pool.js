import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';

puppeteer.use(StealthPlugin());

let browserInstance = null;
const PAGE_POOL_SIZE = 4;
const EXTRACTOR_POOL_SIZE = 2;
const pagePool = [];
const extractorPool = [];
let poolReady = false;

export async function getBrowser() {
    if (browserInstance) {
        try {
            await browserInstance.version();
        } catch {
            console.log('[Browser] Instance lama mati, membuka yang baru...');
            browserInstance = null;
        }
    }
    if (!browserInstance) {
        console.log('[Browser] Membuka instance baru...');
        browserInstance = await puppeteer.launch({
            headless: true,
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
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36');
    await page.setRequestInterception(true);
    page.on('request', req => {
        const type = req.resourceType();
        const url = req.url();
        if (['font', 'media'].includes(type)) return req.abort();
        if (url.includes('googlesyndication') || url.includes('doubleclick') ||
            url.includes('dtscout') || url.includes('facebook.com/tr')) return req.abort();
        req.continue();
    });
    return page;
}

export async function createExtractorPage(browser) {
    const page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36');
    await page.setRequestInterception(true);
    page.on('request', req => {
        const type = req.resourceType();
        const url = req.url();
        if (['font'].includes(type)) return req.abort();
        if (url.includes('googlesyndication') || url.includes('doubleclick') ||
            url.includes('dtscout') || url.includes('facebook.com/tr')) return req.abort();
        req.continue();
    });
    return page;
}

export async function waitForCloudflare(page) {
    const MAX_WAIT = 4000;
    const INTERVAL = 300;
    let elapsed = 0;
    while (elapsed < MAX_WAIT) {
        const judul = await page.title().catch(() => '');
        if (!judul.toLowerCase().includes('just a moment')) return;
        await new Promise(r => setTimeout(r, INTERVAL));
        elapsed += INTERVAL;
    }
}

export async function initPagePool() {
    if (poolReady) return;
    poolReady = true;
    const browser = await getBrowser();
    
    // ── Fase 1: Warm-up 1 page untuk bypass Cloudflare ──
    const firstPage = await createPage(browser);
    try {
        console.log(`[PagePool] Warming up CF cookie...`);
        await firstPage.goto('https://v2.samehadaku.how/', { waitUntil: 'domcontentloaded', timeout: 60000 });
        await waitForCloudflare(firstPage);
        console.log(`[PagePool] CF cookie berhasil didapat ✓`);
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
}

export async function acquireFromPool() {
    const slot = pagePool.find(s => !s.busy);
    if (slot) { slot.busy = true; return slot; }
    const browser = await getBrowser();
    const page = await createPage(browser);
    return { page, busy: true, temp: true, type: 'regular' };
}

export async function acquireFromExtractorPool() {
    const slot = extractorPool.find(s => !s.busy);
    if (slot) { slot.busy = true; return slot; }
    const browser = await getBrowser();
    const page = await createExtractorPage(browser);
    return { page, busy: true, temp: true, type: 'extractor' };
}

export function releaseToPool(slot) {
    if (slot.temp) { slot.page.close().catch(() => { }); return; }
    if (slot.type === 'extractor') {
        slot.page.goto('about:blank').catch(() => {});
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


