export const name = 'blogger';

export function match(url) {
    return url.includes('blogger.com/video') || url.includes('blogger.com/video.g');
}

export async function extract(embedUrl, req) {
    console.log(`[Blogger] Extracting: ${embedUrl}`);
    return null;
}
