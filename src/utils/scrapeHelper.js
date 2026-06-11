import { acquireFromPool, releaseToPool } from '../puppeteer/pool.js';
import * as cheerio from 'cheerio';

/**
 * Mengambil HTML dari target URL menggunakan Puppeteer pool dengan bypass Cloudflare fallback.
 * @param {string} url - Target URL yang akan di-scrape
 * @param {object} options - Opsi konfigurasi (timeout, fetchTimeout, dll)
 * @returns {Promise<{$: cheerio.CheerioAPI, html: string, slot: object}>}
 */
export async function fetchWithCF(url, options = {}) {
    const timeout = options.timeout || 60000;
    const fetchTimeout = options.fetchTimeout || 6000;
    const slot = await acquireFromPool();
    
    try {
        const page = slot.page;
        let html = await page.evaluate(async (targetUrl, fTimeout) => {
            try {
                const controller = new AbortController();
                const timeoutId = setTimeout(() => controller.abort(), fTimeout);
                const res = await fetch(targetUrl, { signal: controller.signal });
                clearTimeout(timeoutId);
                if (res.status === 404) return '404_NOT_FOUND';
                return await res.text();
            } catch(e) {
                return '';
            }
        }, url, fetchTimeout);

        if (html === '404_NOT_FOUND') {
            return { html: '404_NOT_FOUND', $: null, slot };
        }

        const isCloudflare = html.includes('Just a moment') || html.includes('cloudflare') || html.includes('cf-browser-verification') || html.includes('Ray ID:');
        if (!html || html.trim() === '' || isCloudflare) {
            console.log(`[scrapeHelper] Fetch gagal/terblokir Cloudflare. Fallback ke page.goto untuk: ${url}`);
            const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout });
            if (response && response.status() === 404) {
                return { html: '404_NOT_FOUND', $: null, slot };
            }
            html = await page.content();
        }

        if (!html) throw new Error("Gagal mengambil HTML dari target");

        const $ = cheerio.load(html);
        return { $, html, slot };
    } catch (err) {
        if (slot) {
            releaseToPool(slot);
        }
        throw err;
    }
}
