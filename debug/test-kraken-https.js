const https = require('https');

https.get('https://krakenfiles.com/embed-video/9gpqbM7Jd7', {
    headers: { 'User-Agent': 'Mozilla/5.0' }
}, (res) => {
    let data = '';
    res.on('data', chunk => data += chunk);
    res.on('end', () => {
        const tokenMatch = data.match(/id="dl-token"[^>]*value="([^"]+)"/);
        const token = tokenMatch ? tokenMatch[1] : null;
        let dlMatch = data.match(/<video[^>]*><source[^>]*src="([^"]+)"/);
        let dl = dlMatch ? dlMatch[1] : null;
        if(dl && dl.startsWith('//')) dl = 'https:' + dl;
        
        console.log('Token:', token);
        console.log('DL:', dl);
        
        if (dl && token) {
            https.get(dl, {
                headers: {
                    'User-Agent': 'Mozilla/5.0',
                    'Referer': 'https://krakenfiles.com/embed-video/9gpqbM7Jd7',
                    'token': token
                }
            }, (res2) => {
                console.log('Status:', res2.statusCode);
                console.log('Headers:', res2.headers);
            }).on('error', console.error);
        }
    });
}).on('error', console.error);
