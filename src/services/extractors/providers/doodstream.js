import axios from 'axios';

export const name = 'doodstream';

export function match(url) {
    return url.includes('dood.com') ||
           url.includes('dooood.com') ||
           url.includes('doood.com') ||
           url.includes('dood.la') ||
           url.includes('dood.to') ||
           url.includes('dood.so') ||
           url.includes('doodstream.com') ||
           url.includes('dood.watch') ||
           url.includes('dood.pm') ||
           url.includes('dood.wf');
}

export async function extract(embedUrl, req) {
    console.info(`[Doodstream] Extracting: ${embedUrl}`);

    try {
        // Step 1: Fetch the embed page to extract the pass_md5 path and token
        const { data: html, headers: resHeaders } = await axios.get(embedUrl, {
            timeout: 10000,
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
                'Referer': embedUrl
            }
        });

        // Doodstream stores the download path in: var pass_md5 = '/pass_md5/...';
        const passMd5Match = html.match(/var\s+pass_md5\s*=\s*['"](\/pass_md5\/[^'"]+)['"]/);
        if (!passMd5Match) {
            console.log(`[Doodstream] pass_md5 path tidak ditemukan di: ${embedUrl}`);
            return null;
        }
        const passMd5Path = passMd5Match[1];

        // Extract the token from: var token = '...';
        const tokenMatch = html.match(/var\s+token\s*=\s*['"]([^'"]+)['"]/);
        const token = tokenMatch ? tokenMatch[1] : '';

        // Resolve the base origin from the embed URL
        let origin;
        try {
            origin = new URL(embedUrl).origin;
        } catch (e) {
            origin = 'https://dood.com';
        }

        const passMd5Url = `${origin}${passMd5Path}`;

        // Extract cookies from the initial response for session continuity
        const cookies = (resHeaders['set-cookie'] || []).map(c => c.split(';')[0]).join('; ');

        // Step 2: Fetch the pass_md5 endpoint — it returns a base URL for the stream
        const { data: baseUrl } = await axios.get(passMd5Url, {
            timeout: 10000,
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
                'Referer': embedUrl,
                ...(cookies ? { 'Cookie': cookies } : {})
            }
        });

        if (!baseUrl || typeof baseUrl !== 'string' || !baseUrl.startsWith('http')) {
            console.log(`[Doodstream] pass_md5 endpoint tidak mengembalikan URL valid: ${baseUrl}`);
            return null;
        }

        // Step 3: Construct the final streaming URL
        // Doodstream appends a random salt + token + expiry timestamp
        const salt = Math.random().toString(36).substring(2, 14);
        const expiry = Date.now();
        const finalUrl = `${baseUrl.trim()}${salt}?token=${token}&expiry=${expiry}`;

        console.info(`[Doodstream] ✓ Berhasil mengekstrak URL stream dari: ${embedUrl}`);
        return {
            url: finalUrl,
            headers: {
                'Referer': embedUrl,
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
                ...(cookies ? { 'Cookie': cookies } : {})
            }
        };
    } catch (err) {
        console.error(`[Doodstream] Error mengekstrak URL ${embedUrl}:`, err.message);
        return null;
    }
}
