import axios from 'axios';
import vm from 'vm';

export const name = 'mp4upload';

export function match(url) {
    return url.includes('mp4upload.com');
}

export async function extract(embedUrl, req) {
    console.info(`[Mp4Upload] Extracting: ${embedUrl}`);

    try {
        const { data: html } = await axios.get(embedUrl, {
            timeout: 10000,
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
                'Referer': 'https://www.mp4upload.com/'
            }
        });

        // Strategy 1: Direct <source> tag
        const sourceMatch = html.match(/<source[^>]+src=["']([^"']+\.(?:mp4|m3u8)[^"']*)["']/i);
        if (sourceMatch && sourceMatch[1]) {
            console.info(`[Mp4Upload] ✓ Ditemukan via <source> tag`);
            return {
                url: sourceMatch[1].replace(/&amp;/g, '&'),
                headers: { 'Referer': embedUrl }
            };
        }

        // Strategy 2: Packed eval JS (p,a,c,k,e,d pattern)
        const packRegex = /eval\((function\(p,a,c,k,e,(?:[d])\)[\s\S]*?\.split\('\|'\).*?\))\)/;
        const packerMatch = html.match(packRegex);
        if (packerMatch) {
            try {
                const unpacked = vm.runInNewContext(`(${packerMatch[1]})`, {});
                const m3Match = unpacked.match(/(https?:\/\/[^\s"'<>]+\.(?:mp4|m3u8)[^\s"'<>]*)/i) ||
                                unpacked.match(/file:\s*["']([^"']+\.(?:mp4|m3u8)[^"']*)["']/i);
                if (m3Match && m3Match[1]) {
                    console.info(`[Mp4Upload] ✓ Ditemukan via packed JS`);
                    return {
                        url: m3Match[1].replace(/\\/g, '').replace(/&amp;/g, '&'),
                        headers: { 'Referer': embedUrl }
                    };
                }
            } catch (e) {
                console.log(`[Mp4Upload] Gagal unpack JS: ${e.message}`);
            }
        }

        // Strategy 3: Regex fallback looking for videojs src or jwplayer file config
        const rawMatch = html.match(/src:\s*["'](https?:\/\/[^"']+\.mp4[^"']*)["']/i) ||
                         html.match(/file:\s*["'](https?:\/\/[^"']+\.mp4[^"']*)["']/i);
        if (rawMatch && rawMatch[1] && !rawMatch[1].includes('.css') && !rawMatch[1].includes('.js')) {
            console.info(`[Mp4Upload] ✓ Ditemukan via regex fallback`);
            return {
                url: rawMatch[1].replace(/\\/g, '').replace(/&amp;/g, '&'),
                headers: { 'Referer': embedUrl }
            };
        }

        console.log(`[Mp4Upload] Tidak ditemukan URL video di: ${embedUrl}`);
        return null;
    } catch (err) {
        console.error(`[Mp4Upload] Error mengekstrak URL ${embedUrl}:`, err.message);
        return null;
    }
}
