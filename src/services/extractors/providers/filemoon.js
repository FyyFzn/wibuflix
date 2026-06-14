import axios from 'axios';
import vm from 'vm';

export const name = 'filemoon';

export function match(url) {
    return url.includes('filemoon');
}

export async function extract(embedUrl, req) {
    try {
        console.log(`[Filemoon] Extracting (Axios): ${embedUrl}`);
        let fetchUrl = embedUrl;
        
        // Normalize /f/ to /e/ if needed
        if (embedUrl.match(/\/f\/[^/]+\/?$/)) {
            fetchUrl = embedUrl.replace(/\/f\//, '/e/');
            console.log(`[Filemoon] Normalisasi URL: ${embedUrl} → ${fetchUrl}`);
        }

        const { data } = await axios.get(fetchUrl, {
            timeout: 10000,
            headers: {
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
                "Referer": "https://v2.samehadaku.how/"
            }
        });

        let htmlSource = data;
        
        // Match eval(function(p,a,c,k,e,d)...) or eval(function(p,a,c,k,e,r)...)
        const packRegex = /eval\s*\(\s*(function\s*\(\s*p\s*,\s*a\s*,\s*c\s*,\s*k\s*,\s*e\s*,\s*[^)]+\)[\s\S]*?\.split\s*\(\s*['"]\|['"]\s*\).*?\))\s*\)/;
        const packerMatch = data.match(packRegex);
        
        if (packerMatch) {
            try {
                // Execute the function in sandbox to unpack it
                const unpacked = vm.runInNewContext(`(${packerMatch[1]})`, {});
                htmlSource += "\n" + unpacked;
            } catch (e) {
                console.log('[Filemoon] Unpack error:', e.message);
            }
        }
        
        // Find .m3u8 or .mp4 link
        const videoMatch = htmlSource.match(/(https?:\/\/[^\s"'<>]+\.(?:m3u8|mp4)[^\s"'<>]*)/i) || 
                           htmlSource.match(/file:\s*["']([^"']+\.(?:m3u8|mp4)[^"']*)["']/i) ||
                           htmlSource.match(/["'](https?:\/\/[^"']+\.(?:m3u8|mp4)[^"']*)["']/i);
        
        if (videoMatch && videoMatch[1]) {
            const videoUrl = videoMatch[1].replace(/\\/g, '').replace(/&amp;/g, '&');
            console.info(`[Filemoon] Found direct URL: ${videoUrl}`);
            
            // Get base URL for Origin/Referer
            const parsedUrl = new URL(fetchUrl);
            const baseUrl = `${parsedUrl.protocol}//${parsedUrl.hostname}`;

            return {
                url: videoUrl,
                headers: { 
                    'Referer': fetchUrl,
                    'Origin': baseUrl,
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
                }
            };
        }
        throw new Error('Video source link not found in HTML or packed JS');
    } catch (e) {
        console.log(`[Filemoon] Extraction failed: ${e.message}, falling back to generic/Puppeteer`);
        return null;
    }
}
