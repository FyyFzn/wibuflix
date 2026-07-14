import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import { globalUserAgent, getCfCookiesArray, setCfCookie } from './cookieSessionStore.js';
import { PROVIDER_URLS } from '../config/providerUrls.js';

puppeteer.use(StealthPlugin());

let browserInstance = null;
let browserLaunchPromise = null;
let poolReady = false;
const activeRefreshLocks = new Map(); // domain -> Promise

const EXTENDED_BLACKLIST_DOMAINS = [
    'googlesyndication.com', 'doubleclick.net', 'dtscout.com', 'facebook.com',
    'google-analytics.com', 'googletagmanager.com', 'yandex.ru', 'mc.yandex.ru',
    'histats.com', 'popads.net', 'popcash.net', 'adsterra.com', 'exoclick.com',
    'propellerads.com', 'onclickmax.com', 'sentry.io', 'hotjar.com', 'clarity.ms'
];

async function configureOptimizedPage(page) {
    await page.setUserAgent(globalUserAgent);
    await page.setRequestInterception(true);
    page.on('request', req => {
        if (req.isInterceptResolutionHandled && req.isInterceptResolutionHandled()) return;
        const type = req.resourceType();
        const urlLower = req.url().toLowerCase();
        if (['font', 'image', 'stylesheet', 'media', 'manifest', 'other'].includes(type)) {
            return req.abort().catch(() => {});
        }
        if (EXTENDED_BLACKLIST_DOMAINS.some(domain => urlLower.includes(domain))) {
            return req.abort().catch(() => {});
        }
        req.continue().catch(() => {});
    });
    return page;
}

export async function createPage(targetContextOrBrowser) {
    const page = await targetContextOrBrowser.newPage();
    return await configureOptimizedPage(page);
}

export async function createExtractorPage(targetContextOrBrowser) {
    const page = await targetContextOrBrowser.newPage();
    return await configureOptimizedPage(page);
}

export async function getBrowser() {
    if (browserInstance) {
        try {
            await browserInstance.version();
            return browserInstance;
        } catch {
            console.log('[Browser] Instance lama mati, membuka yang baru...');
            try { browserInstance.close().catch(() => {}); } catch(e){}
            browserInstance = null;
        }
    }

    if (browserLaunchPromise) {
        console.log('[Browser] Menunggu instance browser yang sedang dibuka...');
        return await browserLaunchPromise;
    }

    console.log('[Browser] Membuka instance baru...');
    browserLaunchPromise = (async () => {
        try {
            const launchOptions = {
                headless: true,
                protocolTimeout: 120000,
                args: [
                    '--no-sandbox', 
                    '--disable-setuid-sandbox',
                    '--disable-dev-shm-usage',
                    '--disable-gpu',
                    '--password-store=basic',
                    '--use-mock-keychain',
                    '--disable-software-rasterizer',
                    '--disable-extensions',
                    '--disable-background-networking',
                    '--disable-default-apps',
                    '--disable-sync',
                    '--disable-translate',
                    '--metrics-recording-only',
                    '--mute-audio',
                    '--no-first-run',
                    '--safebrowsing-disable-auto-update',
                    '--disable-breakpad',
                    '--disable-crash-reporter',
                    '--no-zygote',
                    '--disable-gpu-sandbox',
                    '--disable-seccomp-filter-sandbox',
                    '--disable-namespace-sandbox',
                    '--disable-gpu-compositing',
                    '--disable-vulkan',
                    '--disable-gl-extensions',
                    '--use-gl=disabled',
                    '--js-flags=--max-old-space-size=256',
                    '--disable-ipc-flooding-protection',
                    '--disable-renderer-backgrounding',
                    '--enable-features=NetworkService,NetworkServiceInProcess',
                    '--disable-features=AudioServiceOutOfProcess,IsolateOrigins,site-per-process,Translate,OptimizationHints,MediaRouter,DialMediaRouteProvider,CalculateNativeWinOcclusion,InterestFeedContentSuggestions,CertificateTransparencyComponentUpdater,AutofillServerCommunication,UniversalFederatedAnalytics'
                ]
            };
            
            console.log('[Browser] Menggunakan official Chrome for Testing (CfT) bawaan Puppeteer...');
            
            let browser = null;
            const maxRetries = 3;
            for (let attempt = 1; attempt <= maxRetries; attempt++) {
                try {
                    browser = await puppeteer.launch(launchOptions);
                    break;
                } catch (err) {
                    console.warn(`[Browser] ⚠️ Percobaan ${attempt}/${maxRetries} gagal membuka browser (${err.message})...`);
                    if (attempt === maxRetries) throw err;
                    await new Promise(r => setTimeout(r, 3000));
                }
            }
            browserInstance = browser;
            
            const version = await browser.version().catch(() => 'unknown');
            console.log(`[Browser] ✅ Browser berhasil dibuka! Versi: ${version}`);
            
            browser.on('disconnected', () => {
                if (browserInstance === browser) {
                    console.error(`[Browser] ⚠️ BROWSER MATI TIBA-TIBA! (disconnected event) — Kemungkinan OOM Killer atau crash.`);
                    browserInstance = null;
                }
            });
            
            return browser;
        } finally {
            browserLaunchPromise = null;
        }
    })();

    return await browserLaunchPromise;
}

const CF_CHALLENGE_TITLES = ['just a moment', 'please wait', 'one moment', 'checking your browser', 'loader'];

function isCfChallengeTitle(title) {
    const t = title.toLowerCase();
    return CF_CHALLENGE_TITLES.some(kw => t.includes(kw));
}

export async function waitForCloudflare(page, maxWait = 15000) {
    const INTERVAL = 400;
    let elapsed = 0;
    while (elapsed < maxWait) {
        if (page.isClosed()) return;
        const judul = await Promise.race([
            page.title().catch(() => ''),
            new Promise(r => setTimeout(() => r(''), 2000))
        ]);
        if (!isCfChallengeTitle(judul)) return;
        await new Promise(r => setTimeout(r, INTERVAL));
        elapsed += INTERVAL;
    }
    if (!page.isClosed()) {
        const finalTitle = await Promise.race([
            page.title().catch(() => ''),
            new Promise(r => setTimeout(() => r(''), 2000))
        ]);
        if (isCfChallengeTitle(finalTitle)) {
            console.warn(`[waitForCloudflare] Timeout menunggu CF challenge selesai! (title: "${finalTitle}")`);
        }
    }
}

export async function refreshCfCookie(targetUrl = 'https://v2.samehadaku.how/') {
    let domain = 'v2.samehadaku.how';
    try {
        domain = new URL(targetUrl).hostname;
    } catch (e) {}

    if (activeRefreshLocks.has(domain)) {
        console.log(`[PagePool] Menunggu proses refresh CF cookie yang sedang berlangsung untuk ${domain}...`);
        return activeRefreshLocks.get(domain);
    }

    const refreshTask = (async () => {
        const browser = await getBrowser();
        const context = await browser.createBrowserContext();
        const page = await createPage(context);
        try {
            console.log(`[PagePool] Me-refresh CF cookie untuk ${domain}...`);
            await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 25000 }).catch(() =>
                page.goto(targetUrl, { waitUntil: 'networkidle2', timeout: 25000 })
            );
            await waitForCloudflare(page);
            await new Promise(r => setTimeout(r, 2000));
            const cookies = await context.cookies().catch(async () => await page.cookies());
            if (cookies && cookies.length > 0) {
                const cfClearance = cookies.find(c => c.name === 'cf_clearance');
                const cookieString = cfClearance
                    ? `cf_clearance=${cfClearance.value};`
                    : cookies.map(c => `${c.name}=${c.value}`).join('; ');
                setCfCookie(domain, cookieString, cookies);
                const label = cfClearance ? 'cf_clearance' : `session (${cookies.length} cookies)`;
                console.debug(`[PagePool] Cookie berhasil diperbarui untuk ${domain} ✓ [${label}]`);
            } else {
                const title = await page.title().catch(() => '');
                if (!title.toLowerCase().includes('just a moment') && !title.toLowerCase().includes('please wait')) {
                    setCfCookie(domain, '', []);
                    console.debug(`[PagePool] ${domain} merespons normal tanpa cookie tantangan Cloudflare (Public Edge CDN) ✓`);
                } else {
                    console.warn(`[PagePool] ⚠️ Tantangan Cloudflare masih aktif namun tidak ada cookie yang didapat untuk ${domain}.`);
                }
            }
        } catch (e) {
            console.warn(`[PagePool] Gagal me-refresh CF cookie untuk ${domain}:`, e.message);
        } finally {
            await page.close().catch(() => {});
            await context.close().catch(() => {});
            activeRefreshLocks.delete(domain);
        }
    })();

    activeRefreshLocks.set(domain, refreshTask);
    return refreshTask;
}

export async function initPagePool() {
    if (poolReady) return;
    poolReady = true;

    // Provider yang butuh CF cookie warm-up (diambil dari SSOT providerUrls.js)
    const CF_WARMUP_PROVIDERS = [
        { name: PROVIDER_URLS.SAMEHADAKU.NAME, url: PROVIDER_URLS.SAMEHADAKU.BASE_URL + '/' },
        { name: PROVIDER_URLS.KURONIME.NAME,   url: PROVIDER_URLS.KURONIME.BASE_URL + '/' },
        { name: PROVIDER_URLS.OTAKUDESU.NAME,  url: PROVIDER_URLS.OTAKUDESU.BASE_URL + '/' },
    ];

    console.log(`[PagePool] Inisialisasi pool dan warming up CF cookie untuk ${CF_WARMUP_PROVIDERS.map(p => p.name).join(', ')}...`);
    await getBrowser().catch(e => console.error('[PagePool] Gagal membuka browser awal:', e.message));

    for (const provider of CF_WARMUP_PROVIDERS) {
        await refreshCfCookie(provider.url).catch(e =>
            console.warn(`[PagePool] Warm-up ${provider.name} gagal:`, e.message)
        );
    }

    setInterval(async () => {
        console.log('[PagePool] Auto-refresh berkala CF cookie (30 menit)...');
        for (const provider of CF_WARMUP_PROVIDERS) {
            await refreshCfCookie(provider.url).catch(e =>
                console.warn(`[PagePool] Auto-refresh ${provider.name} gagal:`, e.message)
            );
        }
    }, 30 * 60 * 1000);
}

export async function closeAllBrowsers() {
    console.log('[PagePool] Menutup semua instance browser...');
    if (browserInstance) {
        const instanceToClose = browserInstance;
        browserInstance = null;
        try {
            await instanceToClose.close();
        } catch (e) {
            console.warn('[PagePool] Error menutup browser:', e.message);
        }
    }
}
