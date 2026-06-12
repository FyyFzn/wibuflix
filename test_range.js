import axios from 'axios';
import * as cheerio from 'cheerio';

async function krakenDl(url) {
    url = new URL(url);
    let hash = url.pathname.match(/view\/(.*)\/file\.html/);
    let html = (await axios.get(url.toString())).data;
    let $ = cheerio.load(html);
    let data = (await axios.post(`${url.origin}/download/${hash[1]}`, 'token=' + $('#dl-token').attr('value'), {
        headers: { 'hash': hash[1], 'Content-Type': 'application/x-www-form-urlencoded' }
    })).data;
    return data.url;
}

async function testRange() {
    try {
        const url = await krakenDl('https://krakenfiles.com/view/e7c2e36b8e/file.html');
        console.log(`URL Download: ${url}`);
        
        console.log('\nMengecek dukungan Multi-Connection (Range Header)...');
        const res = await axios({
            method: 'get',
            url: url,
            headers: { 'Range': 'bytes=0-102400' },
            responseType: 'stream',
            validateStatus: () => true
        });

        console.log(`Status Code: ${res.status}`);
        console.log(`Accept-Ranges: ${res.headers['accept-ranges']}`);
        console.log(`Content-Range: ${res.headers['content-range']}`);
        
        if (res.status === 206) {
            console.log('\n✅ KRAKENFILES MENDUKUNG RANGE REQUEST! Kita bisa meniru JDownloader!');
        } else {
            console.log('\n❌ KRAKENFILES TIDAK MENDUKUNG RANGE REQUEST.');
        }
        res.data.destroy();
    } catch (err) {
        console.error(err.message);
    }
}
testRange();
