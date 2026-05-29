const axios = require('axios');
const cheerio = require('cheerio');

(async () => {
    try {
        const url = 'https://krakenfiles.com/view/mnoLH7793Y/file.html';
        const { data } = await axios.get(url, {
            headers: {
                "User-Agent": "Mozilla/5.0",
                "Referer": url,
                "Accept": "*/*"
            }
        });
        const $ = cheerio.load(data);
        const token = $("#dl-token").val();
        
        let downloads;
        if ($("video").html()) {
            downloads = $("video source").attr("src");
            if (downloads.startsWith('//')) downloads = 'https:' + downloads;
        }
        
        console.log('Token:', token);
        console.log('DL:', downloads);
        
        console.log('Fetching first time...');
        const videoRes1 = await axios.get(downloads, {
            responseType: 'stream',
            headers: {
                "User-Agent": "Mozilla/5.0",
                "Referer": url,
                "Accept": "*/*",
                "token": token
            }
        });
        console.log('Video Status 1:', videoRes1.status);
        
        console.log('Fetching second time...');
        const videoRes2 = await axios.get(downloads, {
            responseType: 'stream',
            headers: {
                "User-Agent": "Mozilla/5.0",
                "Referer": url,
                "Accept": "*/*",
                "token": token
            }
        }).catch(e => e.response);
        console.log('Video Status 2:', videoRes2 ? videoRes2.status : 'Error');
    } catch(e) {
        console.error('Video Error:', e.message);
    }
})();
