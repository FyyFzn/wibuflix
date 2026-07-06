import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';

puppeteer.use(StealthPlugin());

let browserInstance = null;

// Batas konkurensi maksimal untuk VPS Azure B1 (RAM terbatas)
const MAX_REGULAR_CONCURRENCY = 2;
const MAX_EXTRACTOR_CONCURRENCY = 1;

let activeRegularCount = 0;
let activeExtractorCount = 0;
const regularQueue = [];
const extractorQueue = [];

let poolReady = false;

// ── Thread-safe Cookie Store dengan Mutex Lock ──
export let globalCfCookie = ''; // Dipertahankan untuk backward-compat
export const globalUserAgent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36';

const cfCookieStore = new Map(); // domain -> { cookieString, cookiesArray, timestamp }
const activeRefreshLocks = new Map(); // domain -> Promise

export function getCfCookie(domain = 'v2.samehadaku.how') {
    const entry = cfCookieStore.get(domain) || cfCookieStore.get('v2.samehadaku.how');
    return entry ? entry.cookieString : globalCfCookie;
}

export function getCfCookiesArray(domain = 'v2.samehadaku.how') {
    const entry = cfCookieStore.get(domain) || cfCookieStore.get('v2.samehadaku.how');
    return entry ? entry.cookiesArray : [];
}

export function setCfCookie(domain, cookieString, cookiesArray) {
    cfCookieStore.set(domain, { cookieString, cookiesArray, timestamp: Date.now() });
    if (domain.includes('samehadaku')) {
        globalCfCookie = cookieString;
    }
}

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
        try {
            browserInstance = await puppeteer.launch({
                headless: true,
                protocolTimeout: 300000,
                args: [
                    '--no-sandbox',
                    '--disable-setuid-sandbox',
                    '--disable-dev-shm-usage',
                    '--disable-gpu',
                    '--disable-software-rasterizer',
                    '--disable-extensions',
                    '--disable-background-networking',
                    '--disable-default-apps',
                    '--disable-sync',
                    '--disable-translate',
                    '--hide-scrollbars',
                    '--metrics-recording-only',
                    '--mute-audio',
                    '--no-first-run',
                    '--safebrowsing-disable-auto-update',
                    '--ignore-certificate-errors',
                    '--ignore-ssl-errors',
                    '--js-flags=--max-old-space-size=256',
                    '--disable-features=IsolateOrigins,site-per-process'
                ]
            });
        } catch (err) {
            console.error('[Browser] Gagal membuka browser instance:', err.message);
            browserInstance = null;
            throw err;
        }
    }
    return browserInstance;
}

function isBrowserFatalError(error) {
    if (!error) return false;
    const msg = (error.message || error.toString()).toLowerCase();
    return msg.includes('timed out') ||
           msg.includes('protocolerror') ||
           msg.includes('target.createtarget') ||
           msg.includes('addscripttoevaluateonnewdocument') ||
           msg.includes('network.enable') ||
           msg.includes('connection closed') ||
           msg.includes('session closed') ||
           msg.includes('target closed') ||
           msg.includes('disconnected') ||
           msg.includes('failed to launch') ||
           msg.includes('crashed') ||
           msg.includes('code: null') ||
           msg.includes('dbus') ||
           msg.includes('socket');
}

export async function createPage(targetContextOrBrowser) {
    const page = await targetContextOrBrowser.newPage();
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

export async function createExtractorPage(targetContextOrBrowser) {
    const page = await targetContextOrBrowser.newPage();
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
    const MAX_WAIT = 12000;
    const INTERVAL = 400;
    let elapsed = 0;
    while (elapsed < MAX_WAIT) {
        if (page.isClosed()) return;
        const judul = await page.title().catch(() => '');
        const titleLower = judul.toLowerCase();
        if (!titleLower.includes('just a moment') && !titleLower.includes('please wait')) return;
        await new Promise(r => setTimeout(r, INTERVAL));
        elapsed += INTERVAL;
    }
    if (!page.isClosed()) {
        const finalTitle = await page.title().catch(() => '');
        if (finalTitle.toLowerCase().includes('just a moment')) {
            console.warn('[waitForCloudflare] Timeout menunggu CF challenge selesai!');
        }
    }
}

export async function refreshCfCookie(targetUrl = 'https://v2.samehadaku.how/') {
    let domain = 'v2.samehadaku.how';
    try {
        domain = new URL(targetUrl).hostname;
    } catch (e) {}

    // Mutex Lock: Cegah race condition jika dua request merefresh domain yang sama
    if (activeRefreshLocks.has(domain)) {
        console.log(`[PagePool] Menunggu proses refresh CF cookie yang sedang berlangsung untuk ${domain}...`);
        return activeRefreshLocks.get(domain);
    }

    const refreshTask = (async () => {
        let browser, context, page;
        try {
            browser = await getBrowser();
            context = await browser.createBrowserContext();
            page = await createPage(context);
            console.log(`[PagePool] Me-refresh CF cookie untuk ${domain}...`);
            await page.goto(targetUrl, { waitUntil: 'networkidle2', timeout: 60000 }).catch(() =>
                page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 60000 })
            );
            await waitForCloudflare(page);
            const cookies = await page.cookies();
            const cfClearance = cookies.find(c => c.name === 'cf_clearance');
            if (cfClearance) {
                const cookieString = `cf_clearance=${cfClearance.value};`;
                setCfCookie(domain, cookieString, cookies);
                console.log(`[PagePool] cf_clearance cookie berhasil diperbarui untuk ${domain} ✓`);
            } else {
                console.warn(`[PagePool] cf_clearance cookie tidak ditemukan setelah refresh untuk ${domain}.`);
            }
        } catch (e) {
            console.warn(`[PagePool] Gagal me-refresh CF cookie untuk ${domain}:`, e.message);
            if (isBrowserFatalError(e)) {
                console.warn('[PagePool] Terdeteksi browser error/timeout saat refresh CF cookie. Me-restart browser instance...');
                await closeAllBrowsers();
            }
        } finally {
            if (page) await page.close().catch(() => {});
            if (context) await context.close().catch(() => {});
            activeRefreshLocks.delete(domain);
        }
    })();

    activeRefreshLocks.set(domain, refreshTask);
    return refreshTask;
}

export async function initPagePool() {
    if (poolReady) return;
    poolReady = true;
    
    console.log('[PagePool] Inisialisasi pool dan warming up CF cookie...');
    await getBrowser();
    await refreshCfCookie('https://v2.samehadaku.how/').catch(e => console.warn('[PagePool] Warm-up awal gagal:', e.message));

    // Auto-refresh cookie setiap 30 menit
    setInterval(async () => {
        console.log('[PagePool] Auto-refresh berkala CF cookie (30 menit)...');
        await refreshCfCookie('https://v2.samehadaku.how/').catch(e => console.warn('[PagePool] Auto-refresh gagal:', e.message));
    }, 30 * 60 * 1000);
}

// Helper untuk menyuntikkan cookie CF ke context baru
async function injectStoredCookies(page, domain) {
    const cookiesArray = getCfCookiesArray(domain);
    if (cookiesArray && cookiesArray.length > 0) {
        try {
            await page.setCookie(...cookiesArray);
        } catch (e) {}
    }
}

export async function acquireFromPool(domain = 'v2.samehadaku.how', signal = null) {
    if (signal && signal.aborted) {
        throw new Error('REQUEST_ABORTED_BEFORE_ACQUIRE');
    }
    while (activeRegularCount >= MAX_REGULAR_CONCURRENCY) {
        await new Promise((resolve, reject) => {
            const queueItem = { resolve, reject };
            regularQueue.push(queueItem);
            
            if (signal) {
                const onAbort = () => {
                    const index = regularQueue.indexOf(queueItem);
                    if (index > -1) {
                        regularQueue.splice(index, 1);
                        reject(new Error('REQUEST_ABORTED_BEFORE_ACQUIRE'));
                    }
                };
                signal.addEventListener('abort', onAbort, { once: true });
                const originalResolve = resolve;
                queueItem.resolve = () => {
                    signal.removeEventListener('abort', onAbort);
                    originalResolve();
                };
            }
        });
        if (signal && signal.aborted) {
            throw new Error('REQUEST_ABORTED_BEFORE_ACQUIRE');
        }
    }
    activeRegularCount++;

    try {
        const browser = await getBrowser();
        const context = await browser.createBrowserContext();
        const page = await createPage(context);

        if (domain) {
            await injectStoredCookies(page, domain);
        }

        const slot = {
            page,
            context,
            busy: true,
            type: 'regular',
            acquiredAt: Date.now()
        };

        // Safety timeout: jika slot tidak dilepas dalam 90 detik, lepas paksa
        slot.safetyTimer = setTimeout(() => {
            if (slot.busy) {
                console.warn('[PagePool] Safety timeout (90s): Melepaskan slot regular yang macet.');
                releaseToPool(slot);
            }
        }, 90000);

        return slot;
    } catch (error) {
        if (activeRegularCount > 0) activeRegularCount--;
        if (regularQueue.length > 0) {
            const next = regularQueue.shift();
            if (next && typeof next.resolve === 'function') next.resolve();
            else if (typeof next === 'function') next();
        }
        if (isBrowserFatalError(error)) {
            console.warn(`[PagePool] Terdeteksi browser error/timeout saat acquire regular (${error.message}). Me-restart browser instance...`);
            await closeAllBrowsers();
        }
        throw error;
    }
}

export async function acquireFromExtractorPool(domain = null, signal = null) {
    if (signal && signal.aborted) {
        throw new Error('REQUEST_ABORTED_BEFORE_ACQUIRE');
    }
    while (activeExtractorCount >= MAX_EXTRACTOR_CONCURRENCY) {
        await new Promise((resolve, reject) => {
            const queueItem = { resolve, reject };
            extractorQueue.push(queueItem);
            
            if (signal) {
                const onAbort = () => {
                    const index = extractorQueue.indexOf(queueItem);
                    if (index > -1) {
                        extractorQueue.splice(index, 1);
                        reject(new Error('REQUEST_ABORTED_BEFORE_ACQUIRE'));
                    }
                };
                signal.addEventListener('abort', onAbort, { once: true });
                const originalResolve = resolve;
                queueItem.resolve = () => {
                    signal.removeEventListener('abort', onAbort);
                    originalResolve();
                };
            }
        });
        if (signal && signal.aborted) {
            throw new Error('REQUEST_ABORTED_BEFORE_ACQUIRE');
        }
    }
    activeExtractorCount++;

    try {
        const browser = await getBrowser();
        const context = await browser.createBrowserContext();
        const page = await createExtractorPage(context);

        if (domain) {
            await injectStoredCookies(page, domain);
        }

        const slot = {
            page,
            context,
            busy: true,
            type: 'extractor',
            acquiredAt: Date.now()
        };

        slot.safetyTimer = setTimeout(() => {
            if (slot.busy) {
                console.warn('[ExtractorPool] Safety timeout (90s): Melepaskan slot extractor yang macet.');
                releaseToPool(slot);
            }
        }, 90000);

        return slot;
    } catch (error) {
        if (activeExtractorCount > 0) activeExtractorCount--;
        if (extractorQueue.length > 0) {
            const next = extractorQueue.shift();
            if (next && typeof next.resolve === 'function') next.resolve();
            else if (typeof next === 'function') next();
        }
        if (isBrowserFatalError(error)) {
            console.warn(`[ExtractorPool] Terdeteksi browser error/timeout saat acquire extractor (${error.message}). Me-restart browser instance...`);
            await closeAllBrowsers();
        }
        throw error;
    }
}

export async function releaseToPool(slot) {
    if (!slot || !slot.busy) return;
    slot.busy = false;

    if (slot.safetyTimer) {
        clearTimeout(slot.safetyTimer);
        slot.safetyTimer = null;
    }

    try {
        // Hapus listeners, hapus DOM reference, dan await penutupan
        await slot.page.removeAllListeners();
        await slot.page.goto('about:blank', { timeout: 3000 }).catch(()=>{});
        await slot.page.close({ runBeforeUnload: false }).catch(()=>{});
        if (slot.context) {
            await slot.context.close().catch(()=>{});
        }
    } catch (error) {
        console.warn(`[PagePool] Gagal membersihkan slot memori: ${error.message}`);
    } finally {
        if (slot.type === 'extractor') {
            if (activeExtractorCount > 0) activeExtractorCount--;
            if (extractorQueue.length > 0) {
                const next = extractorQueue.shift();
                if (next && typeof next.resolve === 'function') next.resolve();
                else if (typeof next === 'function') next();
            }
        } else {
            if (activeRegularCount > 0) activeRegularCount--;
            if (regularQueue.length > 0) {
                const next = regularQueue.shift();
                if (next && typeof next.resolve === 'function') next.resolve();
                else if (typeof next === 'function') next();
            }
        }
    }
}

export async function fetchPage(url, signal = null) {
    let domain = 'v2.samehadaku.how';
    try { domain = new URL(url).hostname; } catch (e) {}
    const slot = await acquireFromPool(domain, signal);
    try {
        await slot.page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
        await waitForCloudflare(slot.page);
        return slot;
    } catch (err) {
        await releaseToPool(slot);
        if (isBrowserFatalError(err)) {
            console.warn(`[PagePool] Terdeteksi browser error/timeout saat fetchPage (${err.message}). Me-restart browser instance...`);
            await closeAllBrowsers();
        }
        throw err;
    }
}

export async function closeAllBrowsers() {
    console.log('[PagePool] Menutup semua instance browser...');
    if (browserInstance) {
        try {
            await browserInstance.close();
        } catch (e) {
            console.warn('[PagePool] Error menutup browser:', e.message);
        }
        browserInstance = null;
    }
}



