import axios from 'axios';
import * as cheerio from 'cheerio';

async function krakenDl(url) {
    console.log("Fetching URL:", url);
    const parsedUrl = new URL(url);
    if (parsedUrl.host !== 'krakenfiles.com') throw new Error('Invalid url');
    
    let hashMatch = parsedUrl.pathname.match(/view\/(.*)\/file\.html/);
    if (!hashMatch) throw new Error('Hash not found');
    const hash = hashMatch[1];
    console.log("Hash:", hash);
    
    let htmlRes = await axios.get(url);
    let html = htmlRes.data;
    
    const cookies = htmlRes.headers['set-cookie'] || [];
    const cookieStr = cookies.map(c => c.split(';')[0]).join('; ');
    
    let $ = cheerio.load(html);
    const token = $('#dl-token').attr('value');
    console.log("Token:", token);
    
    console.log("Sending POST Request...");
    try {
        let response = await axios.post(`${parsedUrl.origin}/download/${hash}`, `token=${token}`, {
            headers: { 
                'hash': hash,
                'Content-Type': 'application/x-www-form-urlencoded',
                // 'Cookie': cookieStr // Let's see if cookie breaks it
            }
        });
        console.log("POST Success! Data:");
        console.log(response.data);
    } catch (err) {
        console.error("POST Error:", err.message);
        if (err.response) {
            console.error(err.response.data);
        }
    }
}

krakenDl("https://krakenfiles.com/view/tm01fExY37/file.html");
