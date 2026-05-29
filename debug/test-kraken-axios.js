const axios = require('axios');
const cheerio = require('cheerio');

(async () => {
    try {
        const url = 'https://krakenfiles.com/view/9gpqbM7Jd7/file.html';
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
            downloads = "https:" + $("video source").attr("src");
        } else {
            downloads = "https:" + $(".lightgallery a").attr("href");
        }
        
        console.log('Token:', token);
        console.log('DL:', downloads);
    } catch(e) {
        console.error(e.message);
    }
})();
