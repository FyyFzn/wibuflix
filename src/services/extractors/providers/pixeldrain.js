import axios from 'axios';

export const name = 'pixeldrain';

export function match(url) {
    return url.includes('pixeldrain.com/u/') || 
           url.includes('pixeldrain.net/u/') || 
           url.includes('pixeldra.in/u/');
}

export async function extract(embedUrl, req) {
    const idMatch = embedUrl.match(/(?:pixeldrain\.(?:com|net)|pixeldra\.in)\/u\/([a-zA-Z0-9_-]+)/);
    if (!idMatch || !idMatch[1]) {
        console.log(`[Pixeldrain] Gagal mengekstrak ID dari URL: ${embedUrl}`);
        return null;
    }

    const id = idMatch[1];
    
    // Ambil host asal
    let mainHost = 'pixeldrain.com';
    try {
        mainHost = new URL(embedUrl).host;
    } catch (e) {}

    const hosts = [mainHost, 'pixeldrain.com', 'pixeldrain.net', 'pixeldra.in'];
    const uniqueHosts = [...new Set(hosts)];

    console.log(`[Pixeldrain] Extracting file ID: ${id}. Memeriksa host: ${uniqueHosts.join(', ')}`);

    for (const host of uniqueHosts) {
        const checkUrl = `https://${host}/api/file/${id}`;
        try {
            // Lakukan HEAD request untuk verifikasi status download link
            const res = await axios.head(checkUrl, {
                timeout: 5000,
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
                }
            });

            if (res.status === 200) {
                console.info(`[Pixeldrain] Host [${host}] aktif & dapat diakses (status 200).`);
                return {
                    url: checkUrl,
                    headers: {
                        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
                    }
                };
            }
        } catch (err) {
            const status = err.response ? err.response.status : 'No Response';
            console.log(`[Pixeldrain] Host [${host}] tidak dapat digunakan (status: ${status}): ${err.message}`);
        }
    }

    // Fallback jika semua HEAD request gagal
    const fallbackUrl = `https://${uniqueHosts[0]}/api/file/${id}`;
    console.log(`[Pixeldrain] Semua host gagal divalidasi. Fallback ke URL asal: ${fallbackUrl}`);
    return {
        url: fallbackUrl,
        headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
        }
    };
}
