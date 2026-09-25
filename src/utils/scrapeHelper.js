import { acquireFromPool, releaseToPool, getCfCookie, getCfCookiesArray, globalUserAgent, refreshCfCookie, waitForCloudflare } from '../puppeteer/pool.js';
import * as cheerio from 'cheerio';
import axios from 'axios';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { circuitBreaker } from './circuitBreaker.js';

export function getAxiosProxyConfig(url) {
    if (process.env.PROXY_URL && url && url.toLowerCase().includes('ylnime')) {
        return {
            httpsAgent: new HttpsProxyAgent(process.env.PROXY_URL),
            proxy: false
        };
    }
    return {};
}
import { PROVIDER_URLS } from '../config/providerUrls.js';

const DEFAULT_HOSTNAME = new URL(PROVIDER_URLS.SAMEHADAKU.BASE_URL).hostname;

/**
 * Cek apakah HTML adalah halaman Cloudflare challenge.
 */
function isCloudflareHtml(html) {
    if (!html) return false;
    return (
        html.includes('Just a moment') ||
        html.includes('One moment, please') ||
        html.includes('cf-browser-verification') ||
        html.includes('Ray ID:') ||
        html.includes('Checking your browser') ||
        html.includes('jschl-answer') ||
        html.includes('turnstile') ||
        html.includes('cf_chl_opt')
    );
}

/**
 * Inject CF cookie yang ada ke dalam Puppeteer page sebelum navigasi.
 * Ini membantu agar Cloudflare langsung mengenali session yang sudah verified.
 */
async function injectCFCookies(page, targetUrl) {
    try {
        const urlObj = new URL(targetUrl);
        const domain = urlObj.hostname;
        const storedCookies = getCfCookiesArray(domain);
        if (storedCookies && storedCookies.length > 0) {
            await page.setCookie(...storedCookies);
            return;
        }
        const cookieStr = getCfCookie(domain);
        if (!cookieStr) return;
        const cookieParts = cookieStr.split(';').map(c => c.trim()).filter(Boolean);
        const cookies = cookieParts.map(part => {
            const [name, ...valueParts] = part.split('=');
            return {
                name: name.trim(),
                value: valueParts.join('=').trim(),
                domain: urlObj.hostname,
                path: '/'
            };
        }).filter(c => c.name && c.value);
        if (cookies.length > 0) {
            await page.setCookie(...cookies);
        }
    } catch (e) {
        // Abaikan error inject cookie
    }
}

/**
 * Status kode HTTP dari server origin yang menandakan server benar-benar down.
 * Tidak ada gunanya fallback ke Puppeteer untuk status ini karena CF sendiri
 * tidak bisa menjangkau origin — Puppeteer akan melihat halaman error CF juga.
 */
const ORIGIN_DOWN_STATUS_CODES = new Set([521, 522, 523, 524, 530]);

/**
 * Mengambil HTML dari target URL menggunakan Axios + CF Cookie dengan Puppeteer fallback.
 * @param {string} url - Target URL yang akan di-scrape
 * @param {object} options - Opsi konfigurasi (timeout, fetchTimeout, dll)
 * @returns {Promise<{$: cheerio.CheerioAPI, html: string, slot: object}>}
 */
export async function fetchWithCF(url, options = {}) {
    const cbCheck = circuitBreaker.canExecute(url);
    if (!cbCheck.allowed) {
        const err = new Error(cbCheck.reason);
        err.status = 503;
        throw err;
    }

    const timeout = options.timeout || 60000;
    
    // Coba Axios terlebih dahulu untuk semua domain (termasuk Samehadaku & Otakudesu) kecuali jika forcePuppeteer=true diminta secara spesifik
    const isCloudflareStrict = Boolean(options.forcePuppeteer);
    
    let html = '';
    if (!isCloudflareStrict) {
        try {
            let hostname = DEFAULT_HOSTNAME;
            try { hostname = new URL(url).hostname; } catch (e) {}
            const cookieStr = getCfCookie(hostname);

            const axiosConfig = {
                headers: {
                    'User-Agent': globalUserAgent,
                    'Cookie': cookieStr,
                    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
                    'Accept-Language': 'en-US,en;q=0.5',
                    'Accept-Encoding': 'gzip, deflate, br',
                    'Connection': 'keep-alive',
                },
                timeout: options.fetchTimeout || 8000
            };
            
            if (process.env.PROXY_URL) {
                const proxyConfig = getAxiosProxyConfig(url);
                Object.assign(axiosConfig, proxyConfig);
            }

            const response = await axios.get(url, axiosConfig);
            html = response.data;
            if (html && isCloudflareHtml(html)) {
                console.log(`[scrapeHelper] Axios mendapat halaman CF challenge. Langsung fallback ke Puppeteer...`);
                html = ''; // paksa masuk ke Puppeteer fallback tanpa refresh cookie di sini
            }
        } catch (err) {
            if (err.response && err.response.status === 404) {
                return { html: '404_NOT_FOUND', $: null, slot: null };
            }
            // Fix 1: Jika server origin down (522, 523, dll), Puppeteer tidak bisa membantu.
            // CF akan menampilkan halaman error-nya sendiri yang terdeteksi sebagai CF challenge.
            // Langsung lempar error agar circuit breaker mencatat kegagalan tanpa membuang slot Puppeteer.
            if (err.response && ORIGIN_DOWN_STATUS_CODES.has(err.response.status)) {
                throw new Error(`Request failed with status code ${err.response.status}`);
            }
            console.log(`[scrapeHelper] Axios gagal (${err.message}). Langsung fallback ke Puppeteer untuk: ${url}`);
        }
    } else {
        console.log(`[scrapeHelper] Domain Cloudflare ketat terdeteksi. Melewati Axios, langsung ke Puppeteer...`);
    }

    let slot = null;
    let hostname = DEFAULT_HOSTNAME;
    try { hostname = new URL(url).hostname; } catch (e) {}

    try {
        if (!html || html.trim() === '') {
            console.log(`[scrapeHelper] Fallback ke Puppeteer page.goto: ${url}`);
            slot = await acquireFromPool(hostname);
            const page = slot.page;

            // ⚠️ FIX 1: Inject cookie CF yang ada sebelum navigasi
            // agar Cloudflare langsung mengenali session ini sebagai sudah terverifikasi
            await injectCFCookies(page, url);

            // Gunakan 'domcontentloaded' dan handle frame detached.
            // CF challenge butuh request JS tambahan, jika me-refresh otomatis akan trigger 'Navigating frame was detached'
            const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout }).catch(async (e) => {
                if (e.message && (e.message.includes('Navigating frame was detached') || e.message.includes('Execution context was destroyed'))) {
                    // Biarkan saja, browser sedang me-refresh ke halaman challenge
                    return null;
                }
                // Jika error lain (timeout), coba lagi tanpa waitUntil
                return page.goto(url, { timeout }).catch(() => null);
            });

            if (response && response.status() === 404) {
                // Pastikan slot dilepas agar pool tidak bocor
                releaseToPool(slot);
                slot = null;
                return { html: '404_NOT_FOUND', $: null, slot: null };
            }

            // ⚠️ FIX 3: Tunggu CF challenge selesai (timeout 12 detik)
            await waitForCloudflare(page);
            if (url.includes('kuronime')) {
                await page.waitForFunction(() => {
                    return typeof window._0xa100d42aa !== 'undefined' || document.documentElement.innerHTML.includes('_0xa100d42aa');
                }, { timeout: 10000 }).catch(() => {});
            }
            html = await page.content();

            // ⚠️ FIX 4: Jika CF masih lolos, coba refresh cookie & retry SEKALI
            if (isCloudflareHtml(html)) {
                console.warn(`[scrapeHelper] CF challenge masih aktif setelah Puppeteer. Mencoba refresh cookie & retry untuk ${hostname}...`);
                releaseToPool(slot);
                slot = null;
                await refreshCfCookie(url);

                // Retry dengan cookie baru
                slot = await acquireFromPool(hostname);
                const retryPage = slot.page;
                await injectCFCookies(retryPage, url);
                await retryPage.goto(url, { waitUntil: 'domcontentloaded', timeout }).catch(async (e) => {
                    if (e.message && (e.message.includes('Navigating frame was detached') || e.message.includes('Execution context was destroyed'))) return null;
                    return retryPage.goto(url, { timeout }).catch(() => null);
                });
                await waitForCloudflare(retryPage);
                if (url.includes('kuronime')) {
                    await retryPage.waitForFunction(() => {
                        return typeof window._0xa100d42aa !== 'undefined' || document.documentElement.innerHTML.includes('_0xa100d42aa');
                    }, { timeout: 10000 }).catch(() => {});
                }
                html = await retryPage.content();

                if (isCloudflareHtml(html)) {
                    throw new Error('Cloudflare challenge tidak dapat diselesaikan setelah retry. Samehadaku mungkin memperketat proteksi.');
                }
            }
        }

        if (!html) throw new Error('Gagal mengambil HTML dari target');

        const $ = cheerio.load(html);
        circuitBreaker.recordSuccess(url);
        return { $, html, slot };
    } catch (err) {
        if (slot) {
            releaseToPool(slot);
        }
        // Fix 3: Error "detached Frame" adalah race condition internal Puppeteer,
        // bukan kegagalan provider. Tandai agar tidak dihitung oleh circuit breaker.
        if (err.message && (err.message.includes('detached Frame') || err.message.includes('Detached Frame'))) {
            err.skipCircuit = true;
        }
        circuitBreaker.recordFailure(url, err);
        throw err;
    }
}

