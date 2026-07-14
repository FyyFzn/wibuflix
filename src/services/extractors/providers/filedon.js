import axios from 'axios';
import { PROVIDER_URLS } from '../../../config/providerUrls.js';
import { getExtractorReferer } from './utils.js';

export const name = 'filedon';

export function match(url) {
    return url.includes('filedon') || url.includes('pucuk') || url.includes('pucukmovie');
}

export async function extract(embedUrl, req) {
    try {
        let normalizedEmbedUrl = embedUrl;
        if (normalizedEmbedUrl.includes('/view/')) {
            normalizedEmbedUrl = normalizedEmbedUrl.replace('/view/', '/embed/');
            console.log(`[Filedon/Pucuk] Normalisasi URL view: ${embedUrl} → ${normalizedEmbedUrl}`);
        } else if (normalizedEmbedUrl.match(/\/f\/[^/]+\/?$/)) {
            normalizedEmbedUrl = normalizedEmbedUrl.replace(/\/f\//, '/e/');
            console.log(`[Filedon/Pucuk] Normalisasi URL: ${embedUrl} → ${normalizedEmbedUrl}`);
        }

        const originUrl = new URL(normalizedEmbedUrl);
        const baseUrl = `${originUrl.protocol}//${originUrl.hostname}`;
        const slug = originUrl.pathname.split('/').filter(Boolean).pop();
        console.log(`[Filedon/Pucuk] Extracting slug="${slug}" from: ${normalizedEmbedUrl}`);

        embedUrl = normalizedEmbedUrl;

        // ── Strategi 1: Fast HTML Parse (data-page) ──
        try {
            const { data } = await axios.get(embedUrl, {
                timeout: 8000,
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                    'Referer': getExtractorReferer(embedUrl, req)
                }
            });
            
            const m = data.match(/data-page="({.*?})"/);
            if (m && m[1]) {
                const decoded = m[1].replace(/&quot;/g, '"');
                const parsed = JSON.parse(decoded);
                
                if (parsed.props && parsed.props.url) {
                    const videoUrl = parsed.props.url.replace(/\\/g, '').replace(/&amp;/g, '&');
                    console.log(`[Filedon/Pucuk] Fast HTML Parse: Found URL!`);
                    return {
                        url: videoUrl,
                        headers: {
                            'Referer': `${baseUrl}/`,
                            'Origin': baseUrl,
                            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
                        }
                    };
                }
            }
            console.log('[Filedon/Pucuk] Fast HTML Parse tidak mengandung URL video');
        } catch (e) {
            console.log(`[Filedon/Pucuk] Fast HTML Parse gagal: ${e.message}`);
        }

        // ── Strategi 2: POST /embed/{slug}/download/start ──
        try {
            // Pertama ambil CSRF token
            const csrfRes = await axios.get(`${baseUrl}/sanctum/csrf-cookie`, {
                timeout: 8000,
                headers: { 'Referer': embedUrl, 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
                withCredentials: true
            });
            const cookies = csrfRes.headers['set-cookie'] || [];
            const xsrfToken = cookies.find(c => c.startsWith('XSRF-TOKEN='))?.slice('XSRF-TOKEN='.length)?.split(';')[0];
            const cookieStr = cookies.map(c => c.split(';')[0]).join('; ');

            const downloadRes = await axios.post(`${baseUrl}/embed/${slug}/download/start`, {}, {
                timeout: 10000,
                headers: {
                    'Accept': 'application/json',
                    'Content-Type': 'application/json',
                    'X-XSRF-TOKEN': xsrfToken ? decodeURIComponent(xsrfToken) : '',
                    'Referer': embedUrl,
                    'Origin': baseUrl,
                    'Cookie': cookieStr,
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                }
            });
            const downloadData = downloadRes.data;
            console.log(`[Filedon/Pucuk] Download API response:`, JSON.stringify(downloadData).substring(0, 200));
            const dlStr = JSON.stringify(downloadData);
            const dlMatch = dlStr.match(/"(https?:\/\/[^"]+\.(?:m3u8|mp4)[^"]*)"/i) ||
                            dlStr.match(/"url"\s*:\s*"([^"]+)"/i) ||
                            dlStr.match(/"download_url"\s*:\s*"([^"]+)"/i);
            if (dlMatch && dlMatch[1]) {
                const videoUrl = dlMatch[1].replace(/\\/g, '');
                console.log(`[Filedon/Pucuk] Download API: Found URL!`);
                return {
                    url: videoUrl,
                    headers: {
                        'Referer': `${baseUrl}/`,
                        'Origin': baseUrl,
                        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
                    }
                };
            }
        } catch (e) {
            console.log(`[Filedon/Pucuk] Download API gagal: ${e.message}`);
        }

        console.log('[Filedon/Pucuk] Semua Axios strategy gagal, falling back to Puppeteer generic');
    } catch (e) {
        console.log(`[Filedon/Pucuk] Error: ${e.message}, falling back to Puppeteer generic`);
    }
    return null; // triggers fallback to generic Puppeteer extractor
}
