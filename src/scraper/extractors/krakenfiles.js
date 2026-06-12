import axios from 'axios';
import * as cheerio from 'cheerio';

export const name = 'krakenfiles';

export function match(url) {
    return url.includes('krakenfiles.com');
}

export async function extract(embedUrl, req) {
    console.info(`[Kraken] Extracting: ${embedUrl}`);
    
    const controller = new AbortController();
    if (req) req.on('close', () => controller.abort());

    try {
        let viewUrl = embedUrl;
        if (embedUrl.includes('/embed-video/')) {
            viewUrl = embedUrl.replace('/embed-video/', '/view/') + '/file.html';
        }
        
        const response = await axios.get(viewUrl, {
            signal: controller.signal,
            headers: {
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
                "Referer": viewUrl,
                "Accept": "*/*"
            }
        });
        
        const data = response.data;
        const resHeaders = response.headers;
        const cookies = resHeaders['set-cookie'] || [];
        const cookieStr = cookies.map(c => c.split(';')[0]).join('; ');
        
        const $ = cheerio.load(data);
        const token = $("#dl-token").val();
        
        let hashMatch = viewUrl.match(/view\/(.*)\/file\.html/);
        if (!hashMatch) {
            throw new Error('Hash KrakenFiles tidak ditemukan dari URL');
        }
        
        const hash = hashMatch[1];
        
        // JDownloader method: POST ke /download/{hash} untuk mendapat direct link
        const postResponse = await axios.post(`${new URL(viewUrl).origin}/download/${hash}`, `token=${token}`, {
            headers: { 
                'hash': hash,
                'Content-Type': 'application/x-www-form-urlencoded',
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                'Referer': viewUrl,
                'Cookie': cookieStr
            }
        });
        
        if (postResponse.data && postResponse.data.url) {
            let directUrl = postResponse.data.url;
            if (directUrl.startsWith('//')) directUrl = 'https:' + directUrl;
            
            console.info(`[Kraken] ✓ Direct link berhasil diekstrak via POST: ${directUrl.substring(0, 60)}...`);
            
            return {
                url: directUrl,
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                    'Referer': viewUrl,
                    'Cookie': cookieStr
                }
            };
        }
        
        throw new Error('Gagal mengekstrak video dari Krakenfiles');
    } catch (err) {
        console.error(`[Kraken] Error mengekstrak URL ${embedUrl}:`, err.message);
        return null;
    }
}
