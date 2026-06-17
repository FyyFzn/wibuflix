import { acquireFromPool, releaseToPool, globalCfCookie, globalUserAgent, refreshCfCookie, waitForCloudflare } from '../puppeteer/pool.js';
import * as cheerio from 'cheerio';
import axios from 'axios';

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
                'Cookie': globalCfCookie
            },
            timeout: options.fetchTimeout || 8000
        });
        html = response.data;
    } catch (err) {
        if (err.response && err.response.status === 404) {
            return { html: '404_NOT_FOUND', $: null, slot: null };
        }
        console.log(`[scrapeHelper] Axios gagal (${err.message}). Fallback ke Puppeteer untuk: ${url}`);
        if (err.response && (err.response.status === 403 || err.response.status === 503)) {
            await refreshCfCookie();
        }
    }

    let slot = null;
    try {
        const isCloudflare = html.includes('Just a moment') || html.includes('cloudflare') || html.includes('cf-browser-verification') || html.includes('Ray ID:');
        if (!html || html.trim() === '' || isCloudflare) {
            console.log(`[scrapeHelper] Fetch Axios gagal/terblokir Cloudflare. Fallback ke page.goto...`);
            slot = await acquireFromPool();
            const page = slot.page;
            const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout });
            if (response && response.status() === 404) {
                return { html: '404_NOT_FOUND', $: null, slot };
            }
            // ⚠️ FIX: Tunggu sampai Cloudflare JS challenge selesai sebelum membaca HTML
            // waitUntil:'domcontentloaded' terlalu cepat — halaman CF masih bertuliskan
            // "Just a moment..." saat page.content() dipanggil tanpa tunggu ini.
            await waitForCloudflare(page);
            html = await page.content();

            // Validasi tambahan: jika CF masih lolos setelah tunggu, jangan cache hasilnya
            if (html.includes('Just a moment') || html.includes('cf-browser-verification')) {
                throw new Error('Cloudflare challenge tidak dapat diselesaikan oleh Puppeteer.');
            }
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
