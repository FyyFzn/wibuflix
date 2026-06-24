export function extractIframeSrc(html) {
    const match = html.match(/<iframe[^>]+src=["']([^"']+)["']/i);
    return match ? match[1] : null;
}

export function namaServer(url) {
    if (!url) return '';
    try {
        const u = new URL(url);
        const host = u.hostname.toLowerCase();
        if (host.includes('wibufile')) return 'wibufile';
        if (host.includes('kraken')) return 'krakenfiles';
        if (host.includes('mega.nz')) return 'mega';
        if (host.includes('bili')) return 'bilibili';
        if (host.includes('blog')) return 'blogger';
        if (host.includes('mp4upload')) return 'mp4upload';
        if (host.includes('gdrive') || host.includes('google')) return 'gdrive';
        if (host.includes('vidhide')) return 'vidhide';
        if (host.includes('filemoon')) return 'filemoon';
        if (host.includes('filelions')) return 'filelions';
        if (host.includes('moonplayer')) return 'moonplayer';
        if (host.includes('filedon') || host.includes('pucuk')) return 'pucuk';
        
        return host.replace('www.', '').split('.')[0];
    } catch {
        return '';
    }
}
