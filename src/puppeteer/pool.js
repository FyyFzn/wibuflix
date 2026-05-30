const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');

puppeteer.use(StealthPlugin());

let browserInstance = null;
const PAGE_POOL_SIZE = 4;
const pagePool = [];
let poolReady = false;

async function getBrowser() {
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

async function buatPageBaru(browser) {
    const page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36');
    await page.setRequestInterception(true);
    page.on('request', req => {
        const type = req.resourceType();
        const url = req.url();
        if (['image', 'font', 'media', 'stylesheet'].includes(type)) return req.abort();
        if (url.includes('googlesyndication') || url.includes('doubleclick') ||
            url.includes('dtscout') || url.includes('facebook.com/tr')) return req.abort();
        req.continue();
    });
    return page;
}

async function tungguCF(page) {
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

async function initPagePool() {
    if (poolReady) return;
    poolReady = true;
    const browser = await getBrowser();
    for (let i = 0; i < PAGE_POOL_SIZE; i++) {
        const page = await buatPageBaru(browser);
        try {
            await page.goto('https://v2.samehadaku.how/', { waitUntil: 'domcontentloaded', timeout: 60000 });
            await tungguCF(page);
            console.log(`[PagePool] Page ${i + 1} siap`);
        } catch (e) {
            console.warn(`[PagePool] Warm-up page ${i + 1} gagal:`, e.message);
        }
        pagePool.push({ page, busy: false });
    }
}

async function ambilDariPool() {
    const slot = pagePool.find(s => !s.busy);
    if (slot) { slot.busy = true; return slot; }
    const browser = await getBrowser();
    const page = await buatPageBaru(browser);
    return { page, busy: true, temp: true };
}

function kembalikanKePool(slot) {
    if (slot.temp) { slot.page.close().catch(() => { }); return; }
    // Jangan navigasi ke about:blank agar page tetap berada di domain samehadaku 
    // dan bisa digunakan untuk fetch() berulang kali dengan cepat tanpa race condition.
    slot.busy = false;
}

async function fetchPage(url) {
    const slot = await ambilDariPool();
    try {
        await slot.page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
        await tungguCF(slot.page);
        return slot;
    } catch (err) {
        kembalikanKePool(slot);
        throw err;
    }
}

module.exports = {
    initPagePool,
    fetchPage,
    ambilDariPool,
    kembalikanKePool,
    getBrowser
};
