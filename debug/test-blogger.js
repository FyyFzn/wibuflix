const axios = require('axios');

async function test() {
    const url = 'https://www.blogger.com/video.g?token=AD6v5dzNyZkwasxcVeb0u33ndBPRT-Jo7F7iUdEFOMtEU5S2aBzfsBDyoYWjQ8GmrqChRg2qF0gQTyEsjaV3gwpMZT3fwQEocAginReGiNlLC8chc9BRlKbtXIux6ZzhWDhW7QvM0Mfa';
    const { data } = await axios.get(url);
    
    const match = data.match(/"play_url"\s*:\s*"([^"]+)"/);
    if(match) console.log("play_url found via regex 1");
    else console.log("Regex 1 failed");
    
    const match2 = data.match(/VIDEO_CONFIG\s*=\s*(\{.*?\});/);
    if(match2) {
        try {
            const config = JSON.parse(match2[1]);
            console.log("Config streams found. Length:", config.streams?.length);
            if (config.streams && config.streams.length > 0) {
                console.log("Best stream URL:", config.streams[0].play_url);
            }
        } catch(e) {
            console.log("JSON Parse failed:", e.message);
        }
    } else {
        console.log("Regex 2 failed");
        
        // Let's try matching play_url from anywhere
        const allUrls = data.match(/https:\/\/redirector\.googlevideo\.com\/videoplayback\?[^"']+/g);
        if (allUrls && allUrls.length > 0) {
            console.log("Found raw googlevideo URLs:", allUrls.length);
            console.log(allUrls[0]);
        } else {
            console.log("No googlevideo URLs found in raw text.");
        }
    }
}
test();
