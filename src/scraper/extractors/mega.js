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
        
        const proxyUrl = `${req.protocol}://${req.get('host')}/api/proxy/mega?url=${encodeURIComponent(cleanUrl)}`;
        
        return {
            url: proxyUrl,
            isM3U8: false
        };
    } catch (error) {
        console.error('[Mega Extractor Error]', error.message);
        return null;
    }
};
