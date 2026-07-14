import axios from 'axios';
import vm from 'vm';
import { PROVIDER_URLS } from '../../../config/providerUrls.js';
import { getExtractorReferer } from './utils.js';

export const name = 'vidhide';

export function match(url) {
    return url.includes('vidhide') || url.includes('vidlion');
}

export async function extract(embedUrl, req) {
    try {
        console.log(`[Vidhide] Extracting (Axios): ${embedUrl}`);
        const { data } = await axios.get(embedUrl, {
            headers: {
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
                "Referer": getExtractorReferer(embedUrl, req)
            }
        });

        let htmlSource = data;
        const packRegex = /eval\((function\(p,a,c,k,e,?[d]?\)[\s\S]*?\.split\('\|'\).*?\))\)/;
        const packerMatch = data.match(packRegex);
        
        if (packerMatch) {
            try {
                const unpacked = vm.runInNewContext(`(${packerMatch[1]})`, {});
                htmlSource += "\n" + unpacked;
            } catch (e) {
                console.log('[Vidhide] Unpack error:', e.message);
            }
        }
        
        const m3Match = htmlSource.match(/(https?:\/\/[^\s"'<>]+\.(?:m3u8)[^\s"'<>]*)/i) || 
                        htmlSource.match(/file:\s*["']([^"']+\.m3u8[^"']*)["']/i);
        
        if (m3Match && m3Match[1]) {
            const vidhideUrl = m3Match[1].replace(/\\/g, '').replace(/&amp;/g, '&');
            console.log(`[Vidhide] Found direct URL!`);
            return {
                url: vidhideUrl,
                headers: { 
                    'Referer': embedUrl,
                    'Origin': 'https://vidhidepro.com'
                }
            };
        }
        throw new Error('M3U8 link not found in HTML or packed JS');
    } catch (e) {
        console.log(`[Vidhide] Axios failed: ${e.message}, falling back to generic/Puppeteer`);
        return null; // fall back to generic
    }
}
