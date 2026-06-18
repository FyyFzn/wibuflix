import { acquireFromPool, releaseToPool, globalCfCookie, globalUserAgent, refreshCfCookie, waitForCloudflare } from '../puppeteer/pool.js';
import * as cheerio from 'cheerio';
import axios from 'axios';

/**
 * Cek apakah HTML adalah halaman Cloudflare challenge.
 */
function isCloudflareHtml(html) {
    if (!html) return false;
    return (
        html.includes('Just a moment') ||
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
    if (!globalCfCookie) return;
    try {
        const urlObj = new URL(targetUrl);
        const cookieParts = globalCfCookie.split(';').map(c => c.trim()).filter(Boolean);
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
 * Mengambil HTML dari target URL menggunakan Axios + CF Cookie dengan Puppeteer fallback.
 * @param {string} url - Target URL yang akan di-scrape
 * @param {object} options - Opsi konfigurasi (timeout, fetchTimeout, dll)
 * @returns {Promise<{$: cheerio.CheerioAPI, html: string, slot: object}>}
 */
export async function fetchWithCF(url, options = {}) {
    const timeout = options.timeout || 60000;
    
    let html = '';
    try {
        const response = await axios.get(url, {
            headers: {
                'User-Agent': globalUserAgent,
                'Cookie': globalCfCookie,
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
                'Accept-Language': 'en-US,en;q=0.5',
                'Accept-Encoding': 'gzip, deflate, br',
                'Connection': 'keep-alive',
            },
            timeout: options.fetchTimeout || 8000
        });
        html = response.data;
    } catch (err) {
        if (err.response && err.response.status === 404) {
            return { html: '404_NOT_FOUND', $: null, slot: null };
        }
        console.log(`[scrapeHelper] Axios gagal (${err.message}). Fallback ke Puppeteer untuk: ${url}`);
        if (err.response && (err.response.status === 403 || err.response.status === 503 || err.response.status === 429)) {
            await refreshCfCookie();
        }
    }

    // Jika Axios berhasil tapi mengembalikan halaman CF challenge
    if (html && isCloudflareHtml(html)) {
        console.log(`[scrapeHelper] Axios mendapat halaman CF challenge. Refresh cookie & fallback Puppeteer...`);
        html = ''; // paksa masuk ke Puppeteer fallback
        await refreshCfCookie();
    }

    let slot = null;
    try {
        if (!html || html.trim() === '') {
            console.log(`[scrapeHelper] Fallback ke Puppeteer page.goto: ${url}`);
            slot = await acquireFromPool();
            const page = slot.page;

            // ⚠️ FIX 1: Inject cookie CF yang ada sebelum navigasi
            // agar Cloudflare langsung mengenali session ini sebagai sudah terverifikasi
            await injectCFCookies(page, url);

            // ⚠️ FIX 2: Gunakan 'networkidle2' bukan 'domcontentloaded'
            // CF challenge butuh request JS tambahan setelah DOM siap
            const response = await page.goto(url, { waitUntil: 'networkidle2', timeout }).catch(async () => {
                // Jika networkidle2 timeout, coba domcontentloaded sebagai fallback
                return page.goto(url, { waitUntil: 'domcontentloaded', timeout });
            });

            if (response && response.status() === 404) {
                // Pastikan slot dilepas agar pool tidak bocor
                releaseToPool(slot);
                slot = null;
                return { html: '404_NOT_FOUND', $: null, slot: null };
            }

            // ⚠️ FIX 3: Tunggu CF challenge selesai (timeout 12 detik)
            await waitForCloudflare(page);
            html = await page.content();

            // ⚠️ FIX 4: Jika CF masih lolos, coba refresh cookie & retry SEKALI
            if (isCloudflareHtml(html)) {
                console.warn(`[scrapeHelper] CF challenge masih aktif setelah Puppeteer. Mencoba refresh cookie & retry...`);
                releaseToPool(slot);
                slot = null;
                await refreshCfCookie();

                // Retry dengan cookie baru
                slot = await acquireFromPool();
                const retryPage = slot.page;
                await injectCFCookies(retryPage, url);
                await retryPage.goto(url, { waitUntil: 'networkidle2', timeout }).catch(() =>
                    retryPage.goto(url, { waitUntil: 'domcontentloaded', timeout })
                );
                await waitForCloudflare(retryPage);
                html = await retryPage.content();

                if (isCloudflareHtml(html)) {
                    throw new Error('Cloudflare challenge tidak dapat diselesaikan setelah retry. Samehadaku mungkin memperketat proteksi.');
                }
            }
        }

        if (!html) throw new Error('Gagal mengambil HTML dari target');

        const $ = cheerio.load(html);
        return { $, html, slot };
    } catch (err) {
        if (slot) {
            releaseToPool(slot);
        }
        throw err;
    }
}
