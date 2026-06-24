import axios from 'axios';

export const name = 'mediafire';

export function match(url) {
    return url.includes('mediafire.com');
}

/**
 * Ekstrak direct download link dari halaman MediaFire.
 * MediaFire menyembunyikan link di tombol "Download" di dalam HTML.
 */
export async function extract(url, req) {
    try {
        console.log(`[MediaFire] Mengekstrak direct link dari: ${url}`);
        
        const { data: html } = await axios.get(url, {
            timeout: 15000,
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
                'Accept': 'text/html,application/xhtml+xml',
                'Accept-Language': 'en-US,en;q=0.9',
            }
        });

        // MediaFire menyimpan link di atribut `href` dari tombol download
        // Format: <a class="input" id="downloadButton" href="https://download...mediafire.com/...">
        const patterns = [
            /id="downloadButton"[^>]+href="([^"]+)"/i,
            /href="(https:\/\/download[^"]+mediafire\.com[^"]+)"/i,
            /href="(https:\/\/[^"]+\.mediafire\.com\/[^"]+\.(?:mp4|mkv|avi)[^"]*)"/i,
            /"downloadUrl"\s*:\s*"([^"]+)"/i,
        ];

        for (const pattern of patterns) {
            const match = html.match(pattern);
            if (match && match[1]) {
                const directUrl = match[1].replace(/&amp;/g, '&');
                console.log(`[MediaFire] ✓ Direct link ditemukan: ${directUrl.substring(0, 80)}...`);
                return { url: directUrl, isM3U8: false };
            }
        }

        console.warn(`[MediaFire] Tidak bisa menemukan direct link. Halaman mungkin memerlukan autentikasi.`);
        return null;
    } catch (err) {
        console.error(`[MediaFire] Error:`, err.message);
        return null;
    }
}
