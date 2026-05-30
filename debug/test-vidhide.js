const axios = require('axios');
const cheerio = require('cheerio');
async function run() {
    try {
        const res = await axios.get('https://v2.samehadaku.how/frieren-episode-1/', {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
            }
        });
        const $ = cheerio.load(res.data);
        const post = $('.east_player_option').attr('data-post');
        const nume = $('li:contains("Vidhide")').attr('data-nume') || $('li:contains("vidhide")').attr('data-nume');
        const servers = [];
        $('.east_player_option li').each((i, el) => {
            servers.push($(el).text().trim());
        });
        console.log('Available servers:', servers);
        return;

            `action=player_ajax&post=${post}&nume=${nume}&type=schtml`, 
            {
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded', 
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                    'Referer': 'https://v2.samehadaku.how/'
                }
            }
        );
        
        const iframeHtml = iframeRes.data;
        const iframeUrl = cheerio.load(iframeHtml)('iframe').attr('src');
        console.log('Embed URL:', iframeUrl);
        
        if (iframeUrl) {
            const { data } = await axios.get(iframeUrl, {
                headers: {
                    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
                    "Referer": "https://v2.samehadaku.how/"
                }
            });
            const m3Match = data.match(/(https?:\/\/[^\s"'<>]+\.(?:m3u8)[^\s"'<>]*)/i) || 
                            data.match(/file:\s*["']([^"']+\.m3u8[^"']*)["']/i);
            
            if (m3Match && m3Match[1]) {
                const vidhideUrl = m3Match[1].replace(/\\/g, '').replace(/&amp;/g, '&');
                console.log('Vidhide URL:', vidhideUrl);
                
                // Test fetching the M3U8 with different headers
                try {
                    await axios.get(vidhideUrl, {
                        headers: {
                            'Referer': iframeUrl,
                            'Origin': new URL(iframeUrl).origin,
                            'User-Agent': 'Mozilla/5.0'
                        }
                    });
                    console.log('M3U8 fetch with dynamic Origin and Referer: SUCCESS');
                } catch(e) {
                    console.log('M3U8 fetch with dynamic Origin and Referer: FAILED - ' + e.message);
                }
                
                try {
                    await axios.get(vidhideUrl, {
                        headers: {
                            'Referer': iframeUrl,
                            'Origin': 'https://vidhidepro.com',
                            'User-Agent': 'Mozilla/5.0'
                        }
                    });
                    console.log('M3U8 fetch with vidhidepro.com Origin: SUCCESS');
                } catch(e) {
                    console.log('M3U8 fetch with vidhidepro.com Origin: FAILED - ' + e.message);
                }
                
                try {
                    await axios.get(vidhideUrl, {
                        headers: {
                            'User-Agent': 'ExoPlayer/2.18.1' // Native player agent
                        }
                    });
                    console.log('M3U8 fetch with NO Referer/Origin (ExoPlayer): SUCCESS');
                } catch(e) {
                    console.log('M3U8 fetch with NO Referer/Origin (ExoPlayer): FAILED - ' + e.message);
                }
            } else {
                console.log('Vidhide m3u8 not found in HTML');
            }
        }
    } catch(e) {
        console.log(e.message);
    }
}
run();
