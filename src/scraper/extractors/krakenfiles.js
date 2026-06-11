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
        
        const { data } = await axios.get(viewUrl, {
            signal: controller.signal,
            headers: {
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
                "Referer": viewUrl,
                "Accept": "*/*"
            }
        });
        
        const $ = cheerio.load(data);
        const token = $("#dl-token").val();
        
        let src;
        if ($("video source").length > 0) {
            src = $("video source").attr("src");
        } else if ($("video").attr("src")) {
            src = $("video").attr("src");
        } else if ($(".lightgallery a").length > 0) {
            src = $(".lightgallery a").attr("href");
        } else if ($("a[data-type='video']").length > 0) {
            src = $("a[data-type='video']").attr("href");
        } else {
            // Regex match as last resort
            const m = data.match(/(https?:\/\/[^\s"'<>]+\.(?:mp4|mkv))/i);
            if (m) src = m[1];
        }
        
        if (src) {
            if (src.startsWith('//')) src = 'https:' + src;
            
            return {
                url: src,
                headers: token ? { 
                    'token': token,
                    'Referer': viewUrl
                } : {
                    'Referer': viewUrl
                }
            };
        }
        
        throw new Error('Gagal mengekstrak video dari Krakenfiles');
    } catch (err) {
        console.error(`[Kraken] Error mengekstrak URL ${embedUrl}:`, err.message);
        return null;
    }
}
