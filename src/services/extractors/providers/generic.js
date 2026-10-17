import axios from 'axios';
import { getExtractorReferer } from './utils.js';

export const name = 'generic';

export function match(url) {
    return true; // Fallback
}

export async function extract(embedUrl, req) {
    // 1. Fast Generic HTML Parse (Untuk Nakama, Kuro, dll)
    try {
        console.log(`[Fast Generic] Mencoba ekstrak langsung dari HTML: ${embedUrl}`);
        const { data } = await axios.get(embedUrl, {
            timeout: 8000,
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
                'Referer': getExtractorReferer(embedUrl, req)
            }
        });
        
        const m3Match = data.match(/(https?:\/\/[^\s"'<>]+\.(?:m3u8|mp4)[^\s"'<>]*)/i) || 
                        data.match(/file:\s*["']([^"']+\.(?:m3u8|mp4)[^"']*)["']/i) ||
                        data.match(/source:\s*["']([^"']+\.(?:m3u8|mp4)[^"']*)["']/i);
                        
        if (m3Match && m3Match[1] && !m3Match[1].includes('google')) {
            let fastUrl = m3Match[1].replace(/\\/g, '').replace(/&amp;/g, '&');
            console.log(`[Fast Generic] Ditemukan URL langsung!`);
            return { url: fastUrl };
        }
    } catch (e) {
        console.log(`[Fast Generic] Gagal/Terblokir: ${e.message}`);
    }
    return null;
}
