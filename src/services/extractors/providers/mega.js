export const match = (url) => {
    return url.includes('mega.nz');
};

export const extract = async (url, req) => {
    try {
        let cleanUrl = url;
        if (cleanUrl.includes('/embed/')) {
            const parts = cleanUrl.split('/embed/')[1].split('!');
            cleanUrl = `https://mega.nz/file/${parts[0]}#${parts[1]}`;
        }
        
        let localBaseUrl = `http://127.0.0.1:${process.env.PORT || 3000}`;
        if (process.env.APP_URL) {
            localBaseUrl = process.env.APP_URL.replace(/\/$/, '');
        } else if (process.env.WEBSITE_HOSTNAME) {
            // Azure WebApp environment
            localBaseUrl = `https://${process.env.WEBSITE_HOSTNAME}`;
        }
        const baseUrl = req ? `${req.protocol}://${req.get('host')}` : localBaseUrl;
        const proxyUrl = `${baseUrl}/api/proxy/mega?url=${encodeURIComponent(cleanUrl)}`;
        
        return {
            url: proxyUrl,
            isM3U8: false
        };
    } catch (error) {
        console.error('[Mega Extractor Error]', error.message);
        return null;
    }
};
