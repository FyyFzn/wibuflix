import axios from 'axios';
import * as cheerio from 'cheerio';

async function testOldAndRange(url) {
    let htmlRes = await axios.get(url, {
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
    });
    let data = htmlRes.data;
    const cookies = htmlRes.headers['set-cookie'] || [];
    const cookieStr = cookies.map(c => c.split(';')[0]).join('; ');
    
    let $ = cheerio.load(data);
    let src;
    if ($("video source").length > 0) {
        src = $("video source").attr("src");
    } else if ($("video").attr("src")) {
        src = $("video").attr("src");
    } else if ($(".lightgallery a").length > 0) {
        src = $(".lightgallery a").attr("href");
    } else if ($("a[data-type='video']").length > 0) {
        src = $("a[data-type='video']").attr("href");
    } else {
        const m = data.match(/(https?:\/\/[^\s"'<>]+\.(?:mp4|mkv))/i);
        if (m) src = m[1];
    }

    if (src) {
        if (src.startsWith('//')) src = 'https:' + src;
        console.log("Extracted URL:", src);
        
        console.log('\nMengecek Range...');
        try {
            const res = await axios({
                method: 'get',
                url: src,
                headers: { 
                    'Range': 'bytes=0-102400',
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                    'Referer': url,
                    'Cookie': cookieStr
                },
                responseType: 'stream',
                validateStatus: () => true
            });

            console.log(`Status Code: ${res.status}`);
            console.log(`Accept-Ranges: ${res.headers['accept-ranges']}`);
            console.log(`Content-Range: ${res.headers['content-range']}`);
            res.data.destroy();
        } catch (e) {
            console.error(e.message);
        }
    } else {
        console.log("No URL found");
    }
}

testOldAndRange("https://krakenfiles.com/view/tm01fExY37/file.html");
