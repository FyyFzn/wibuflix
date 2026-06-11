export const name = 'pixeldrain';

export function match(url) {
    return url.includes('pixeldrain.com/u/');
}

export async function extract(embedUrl, req) {
    const idMatch = embedUrl.match(/pixeldrain\.com\/u\/([a-zA-Z0-9]+)/);
    if (idMatch && idMatch[1]) {
        const directUrl = `https://pixeldrain.com/api/file/${idMatch[1]}`;
        console.log(`[Pixeldrain] Fast API URL: ${directUrl}`);
        return {
            url: directUrl,
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'
            }
        };
    }
    return null;
}
