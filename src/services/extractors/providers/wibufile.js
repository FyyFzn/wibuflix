import axios from 'axios';
import { PROVIDER_URLS } from '../../../config/providerUrls.js';

export const name = 'wibufile';

export function match(url) {
    return url.includes('wibufile');
}

export async function extract(embedUrl, req) {
    try {
        console.log(`[Wibufile] Mencoba ekstrak direct URL dari: ${embedUrl}`);
        let fetchUrl = embedUrl;
        if (embedUrl.match(/\/f\/[^/]+\/?$/)) {
            fetchUrl = embedUrl.replace(/\/f\//, '/e/');
            console.log(`[Wibufile] Konversi ke embed URL: ${fetchUrl}`);
        }

        const { data } = await axios.get(fetchUrl, {
            timeout: 10000,
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
                'Referer': `${PROVIDER_URLS.SAMEHADAKU.BASE_URL}/`
            }
        });

        const videoSrcMatch = data.match(/<source[^>]+src=["']([^"']+\.(?:mp4|m3u8)[^"']*)["']/i) ||
                              data.match(/<video[^>]+src=["']([^"']+\.(?:mp4|m3u8)[^"']*)["']/i) ||
                              data.match(/file:\s*["']([^"']+\.(?:mp4|m3u8)[^"']*)["']/i) ||
                              data.match(/["'](https?:\/\/[^"']+\.(?:mp4|m3u8)[^"']*)["']/i);

        if (videoSrcMatch && videoSrcMatch[1]) {
            const videoUrl = videoSrcMatch[1].replace(/\\/g, '').replace(/&amp;/g, '&');
            console.log(`[Wibufile] Direct URL ditemukan!`);
            return {
                url: videoUrl,
                headers: {
                    'Referer': fetchUrl,
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
                }
            };
        }
        console.log('[Wibufile] Tidak ada URL video di HTML, fallback ke WebView');
    } catch (e) {
        console.log(`[Wibufile] Axios gagal: ${e.message}, fallback ke WebView`);
    }
    return null; // triggers WebView fallback in server.js/frontend
}
