import { getBrowser, createPage, createExtractorPage, waitForCloudflare } from './browserPool.js';
import { getCfCookiesArray } from './cookieSessionStore.js';
import { isCircuitOpen, recordProviderFailure, recordProviderSuccess } from './circuitBreaker.js';

// Batas konkurensi maksimal untuk VPS Azure B1 (RAM terbatas)
const MAX_REGULAR_CONCURRENCY = 2;
const MAX_EXTRACTOR_CONCURRENCY = 1;

let activeRegularCount = 0;
let activeExtractorCount = 0;
const regularQueue = [];
const extractorQueue = [];

async function injectStoredCookies(page, domain) {
    const cookiesArray = getCfCookiesArray(domain);
    if (cookiesArray && cookiesArray.length > 0) {
        try {
            await page.setCookie(...cookiesArray);
        } catch (e) {}
    }
}

export async function acquireFromPool(domain = 'v2.samehadaku.how', signal = null) {
    if (domain && isCircuitOpen(domain)) {
        throw new Error(`PROVIDER_CIRCUIT_OPEN: Domain ${domain} sedang dalam Circuit Breaker cooldown.`);
    }
    if (signal && signal.aborted) {
        throw new Error('REQUEST_ABORTED_BEFORE_ACQUIRE');
    }
    const QUEUE_TIMEOUT = 30000;
    while (activeRegularCount >= MAX_REGULAR_CONCURRENCY) {
        await new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                const idx = regularQueue.indexOf(queueItem);
                if (idx > -1) regularQueue.splice(idx, 1);
                reject(new Error('QUEUE_TIMEOUT_EXCEEDED'));
            }, QUEUE_TIMEOUT);
            const queueItem = { 
                resolve: () => { clearTimeout(timer); resolve(); }, 
                reject: (err) => { clearTimeout(timer); reject(err); } 
            };
            regularQueue.push(queueItem);
            
            if (signal) {
                const onAbort = () => {
                    clearTimeout(timer);
                    const index = regularQueue.indexOf(queueItem);
                    if (index > -1) {
                        regularQueue.splice(index, 1);
                        reject(new Error('REQUEST_ABORTED_BEFORE_ACQUIRE'));
                    }
                };
                signal.addEventListener('abort', onAbort, { once: true });
                const originalResolve = queueItem.resolve;
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

        slot.safetyTimer = setTimeout(() => {
            if (slot.busy) {
                console.warn('[PagePool] Safety timeout (90s): Melepaskan slot regular yang macet.');
                releaseToPool(slot);
            }
        }, 90000);

        return slot;
    } catch (err) {
        if (activeRegularCount > 0) activeRegularCount--;
        if (regularQueue.length > 0) {
            const next = regularQueue.shift();
            if (next && typeof next.resolve === 'function') next.resolve();
            else if (typeof next === 'function') next();
        }
        console.error(`[PagePool Fatal] Gagal menginisialisasi slot regular browser (${err.message}). Counter di-rollback.`);
        throw err;
    }
}

export async function acquireFromExtractorPool(domain = null, signal = null) {
    if (domain && isCircuitOpen(domain)) {
        throw new Error(`PROVIDER_CIRCUIT_OPEN: Domain ${domain} sedang dalam Circuit Breaker cooldown.`);
    }
    if (signal && signal.aborted) {
        throw new Error('REQUEST_ABORTED_BEFORE_ACQUIRE');
    }
    const QUEUE_TIMEOUT = 30000;
    while (activeExtractorCount >= MAX_EXTRACTOR_CONCURRENCY) {
        await new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                const idx = extractorQueue.indexOf(queueItem);
                if (idx > -1) extractorQueue.splice(idx, 1);
                reject(new Error('QUEUE_TIMEOUT_EXCEEDED'));
            }, QUEUE_TIMEOUT);
            const queueItem = { 
                resolve: () => { clearTimeout(timer); resolve(); }, 
                reject: (err) => { clearTimeout(timer); reject(err); } 
            };
            extractorQueue.push(queueItem);
            
            if (signal) {
                const onAbort = () => {
                    clearTimeout(timer);
                    const index = extractorQueue.indexOf(queueItem);
                    if (index > -1) {
                        extractorQueue.splice(index, 1);
                        reject(new Error('REQUEST_ABORTED_BEFORE_ACQUIRE'));
                    }
                };
                signal.addEventListener('abort', onAbort, { once: true });
                const originalResolve = queueItem.resolve;
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
    } catch (err) {
        if (activeExtractorCount > 0) activeExtractorCount--;
        if (extractorQueue.length > 0) {
            const next = extractorQueue.shift();
            if (next && typeof next.resolve === 'function') next.resolve();
            else if (typeof next === 'function') next();
        }
        console.error(`[ExtractorPool Fatal] Gagal menginisialisasi slot extractor browser (${err.message}). Counter di-rollback.`);
        throw err;
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
    
    if (isCircuitOpen(domain)) {
        throw new Error(`PROVIDER_CIRCUIT_OPEN: Domain ${domain} sedang dalam Circuit Breaker cooldown.`);
    }

    const slot = await acquireFromPool(domain, signal);
    try {
        await slot.page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
        await waitForCloudflare(slot.page);
        recordProviderSuccess(domain);
        return slot;
    } catch (err) {
        releaseToPool(slot);
        recordProviderFailure(domain, err);
        throw err;
    }
}
