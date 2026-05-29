const axios = require('axios');
const vm = require('vm');

async function test() {
    try {
        const { data } = await axios.get('https://vidhidepro.com/v/ny05w9n90i7e', {
            headers: { 'User-Agent': 'Mozilla/5.0' }
        });

        const packRegex = /eval\((function\(p,a,c,k,e,?[d]?\)[\s\S]*?\.split\('\|'\).*?\))\)/;
        const packerMatch = data.match(packRegex);
        
        let htmlSource = data;

        if (packerMatch) {
            console.log('Found packed script');
            try {
                const unpacked = vm.runInNewContext('(' + packerMatch[1] + ')', {});
                htmlSource += '\n' + unpacked;
                console.log('Unpacked successfully');
            } catch (e) {
                console.log('Unpack error:', e.message);
            }
        }
        
        const m3Match = htmlSource.match(/(https?:\/\/[^\s"'<>]+\.(?:m3u8)[^\s"'<>]*)/i) || 
                        htmlSource.match(/file:\s*["']([^"']+\.m3u8[^"']*)["']/i);
        
        if (m3Match) {
            console.log('Found m3u8:', m3Match[1].replace(/\\/g, ''));
        } else {
            console.log('m3u8 not found');
        }

    } catch (e) {
        console.error('Axios error:', e.message);
    }
}

test();
