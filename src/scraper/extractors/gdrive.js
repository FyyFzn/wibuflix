import axios from 'axios';

export const name = 'gdrive';

export function match(url) {
    return url.includes('drive.google.com');
}

export async function extract(embedUrl, req) {
    try {
        console.log(`[GDrive] Mencoba ekstrak direct URL dari: ${embedUrl}`);
        let fileId = '';
        
        const urlObj = new URL(embedUrl);
        if (embedUrl.includes('/file/d/')) {
            fileId = embedUrl.split('/file/d/')[1].split('/')[0];
        } else if (urlObj.searchParams.has('id')) {
            fileId = urlObj.searchParams.get('id');
        }
        
        if (fileId) {
            const apiUrl = `https://drive.google.com/uc?export=download&id=${fileId}`;
            const res = await axios.get(apiUrl, {
                maxRedirects: 0,
                validateStatus: (status) => status >= 200 && status < 400,
                headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' }
            });
            
            let directUrl = '';
            let usercontentUrl = '';
            
            if (res.status === 302 || res.status === 303) {
                usercontentUrl = res.headers.location;
            } else if (res.status === 200) {
                usercontentUrl = apiUrl; 
            }
            
            if (usercontentUrl) {
                const res2 = await axios.get(usercontentUrl, {
                    maxRedirects: 0,
                    validateStatus: (status) => status >= 200 && status < 400,
                    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' }
                });
                
                if (res2.status === 302 || res2.status === 303) {
                    directUrl = res2.headers.location;
                } else if (res2.status === 200) {
                    const html = res2.data;
                    const uuidMatch = html.match(/name="uuid"\s+value="([^"]+)"/i);
                    if (uuidMatch && uuidMatch[1]) {
                        const uuid = uuidMatch[1];
                        directUrl = `${usercontentUrl}&confirm=t&uuid=${uuid}`;
                    } else {
                        const confirmMatch = html.match(/confirm=([0-9A-Za-z_-]+)/);
                        if (confirmMatch && confirmMatch[1]) {
                            directUrl = `${usercontentUrl}&confirm=${confirmMatch[1]}`;
                        }
                    }
                }
            }
            
            if (directUrl) {
                console.log(`[GDrive] Direct URL berhasil diekstrak: ${directUrl}`);
                return {
                    url: directUrl,
                    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
                };
            }
        }
    } catch (e) {
        console.error(`[GDrive] Gagal ekstrak:`, e.message);
    }
    throw new Error('Gagal mengekstrak video dari GDrive');
}
