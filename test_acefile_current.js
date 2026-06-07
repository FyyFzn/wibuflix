const axios = require('axios');
const vm = require('vm');

async function test() {
    try {
        const url = 'https://acefile.co/player/111526118';
        const { data: html } = await axios.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
        const packRegex = /eval\((function\(p,a,c,k,e,?[d]?\)[\s\S]*?\.split\('\|'\).*?\))\)/;
        const match = html.match(packRegex);
        if (!match) return console.log('no eval');
        
        const unpacked = vm.runInNewContext(`(${match[1]})`, {});
        
        // Coba rute cepat (Google Drive API) jika ada variabel DUAR
        const duarMatch = unpacked.match(/var\s+[a-zA-Z0-9_]+\s*=\s*\[\{.*?"code"\s*:\s*"([^"]+)".*?\}\]/);
        const apiKeyMatch = unpacked.match(/key=(AIza[a-zA-Z0-9_-]+)/); // kalau ada atob yang di-decode secara manual, atau kita cari dari source
        
        let driveId = '';
        if (duarMatch && duarMatch[1]) {
            driveId = Buffer.from(duarMatch[1], 'base64').toString('utf8');
        }
        
        // Cari string atob untuk API key
        let apiKey = 'AIzaSyBkK04Xe0ZzIRSx1TcZyHvkkTGEtkPgugw'; // default
        const atobMatches = [...unpacked.matchAll(/atob\("([^"]+)"\)/g)];
        for (const m of atobMatches) {
            try {
                const decoded = Buffer.from(m[1], 'base64').toString('utf8');
                const keyMatch = decoded.match(/key=(AIza[a-zA-Z0-9_-]+)/);
                if (keyMatch) {
                    apiKey = keyMatch[1];
                    break;
                }
            } catch(e){}
        }

        if (driveId && apiKey) {
            const finalUrl = `https://www.googleapis.com/drive/v3/files/${driveId}?alt=media&key=${apiKey}`;
            console.log('[Acefile] Fast Route URL:', finalUrl);
            return;
        }

        // Coba rute lambat (Local -> Service Play)
        let mirrorArr = [];
        const mirrorMatch = unpacked.match(/\[\{"v":".*?\}\]/);
        if (mirrorMatch) {
            mirrorArr = JSON.parse(mirrorMatch[0]);
        } else {
            const idMatch = unpacked.match(/"id"\s*:\s*"(\d+)"/);
            const keyMatch = unpacked.match(/var\s+[a-zA-Z0-9_]+\s*=\s*["']([a-f0-9]{32,})["']/g);
            if (idMatch && keyMatch && keyMatch.length > 0) {
                // Biasanya key adalah nfck
                let foundKey = '';
                for (const k of keyMatch) {
                    if (k.includes('nfck')) {
                        foundKey = k.match(/["']([a-f0-9]{32,})["']/)[1];
                        break;
                    }
                }
                if (!foundKey) {
                    foundKey = keyMatch[keyMatch.length-1].match(/["']([a-f0-9]{32,})["']/)[1];
                }
                mirrorArr = [{ v: idMatch[1], J: foundKey }];
            }
        }
        
        if (mirrorArr.length === 0) return console.log('no mirror found');
        console.log('Mirror found:', mirrorArr);
        
        for (const m of mirrorArr) {
            const localUrl = `https://acefile.co/local/${m.v}?key=${m.J}`;
            const { data: localHtml } = await axios.get(localUrl, { timeout: 10000, headers: { 'User-Agent': 'Mozilla/5.0' } });
            
            const sourceMatch = localHtml.match(/sources:\s*JSON\.parse\(atob\("([^"]+)"\)\)/);
            if (sourceMatch) {
                const decoded = Buffer.from(sourceMatch[1], 'base64').toString('utf8');
                const sources = JSON.parse(decoded);
                console.log('sources', sources);
                if (sources.length > 0) {
                    const serviceUrl = 'https://acefile.co' + sources[0].file;
                    console.log(`[Acefile] Menelusuri redirect: ${serviceUrl}`);
                    const redirectRes = await axios.get(serviceUrl, { maxRedirects: 0, validateStatus: null, headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://acefile.co/' } });
                    if (redirectRes.status === 307 || redirectRes.status === 302) {
                        const directUrl = redirectRes.headers.location;
                        console.log(`[Acefile] Direct URL ditemukan: ${directUrl.substring(0, 50)}...`);
                    }
                }
            } else {
                console.log('no source match');
            }
        }
    } catch(e) { console.error(e.message); }
}
test();
