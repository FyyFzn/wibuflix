const axios = require('axios');
const cheerio = require('cheerio');

async function extractAcefile(url) {
    try {
        console.log('Fetching', url);
        const { data: html } = await axios.get(url, {
            headers: { 'User-Agent': 'Mozilla/5.0' }
        });
        
        // Find eval(function(p,a,c,k,e,d)...
        const evalRegex = /eval\(function\(p,a,c,k,e,d\).*?\)\)/s;
        const match = html.match(evalRegex);
        if (match) {
            let evalCode = match[0];
            // Override eval to capture the script
            let unpacked = '';
            evalCode = evalCode.replace(/^eval/, 'unpacked = ');
            eval(evalCode);
            
            // console.log('Unpacked JS:', unpacked);
            
            // Look for URL patterns in unpacked JS
            // var 9=[{"v":"111526527","J":"d4eeded80ec66461154d5d7695360a993b1c0ba4","m":"\/u\/m\/111526118\/e94cadf7e52bee60a42dec5493b56f1f"}];
            const mirrorMatch = unpacked.match(/\[\{"v":".*?\}\]/);
            if (mirrorMatch) {
                const mirrorArr = JSON.parse(mirrorMatch[0]);
                console.log('Mirrors found:', mirrorArr);
                
                // Usually it makes an ajax call to `/u/m/111526118/...` or directly builds iframe src
                // f(cb, internalMirror) -> internalMirror = {"v":"111526527","J":"d4eeded80ec66461154d5d7695360a993b1c0ba4","m":"\/u\/m\/111526118\/e94cadf7e52bee60a42dec5493b56f1f"}
                // F("p","/p/"+9.v+"?1q="+P)  -> F is set iframe src.  /p/111526527?1q=MEME
                // Let's try to fetch the local mirror URL: https://acefile.co/local/111528251?key=d4eeded80ec66461154d5d7695360a993b1c0ba4
                // Oh wait, the local mirror uses "J" as key!
                
                for (const m of mirrorArr) {
                    const localUrl = `https://acefile.co/local/${m.v}?key=${m.J}`;
                    console.log('Trying local URL:', localUrl);
                    
                    try {
                        const { data: localHtml } = await axios.get(localUrl, {
                            headers: { 'User-Agent': 'Mozilla/5.0' }
                        });
                        
                        const sourceMatch = localHtml.match(/sources:\s*JSON\.parse\(atob\("([^"]+)"\)\)/);
                        if (sourceMatch) {
                            const decoded = Buffer.from(sourceMatch[1], 'base64').toString('utf8');
                            const sources = JSON.parse(decoded);
                            console.log('EXTRACTED SOURCES:', sources);
                            return sources;
                        } else {
                            console.log('No sources found in local HTML');
                        }
                    } catch(e) {
                        console.log('Local URL fetch error:', e.message);
                    }
                }
            }
        } else {
            console.log('No eval found');
        }
    } catch(e) {
        console.error(e.message);
    }
}

extractAcefile('https://acefile.co/player/111526118');
