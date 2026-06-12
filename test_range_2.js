import axios from 'axios';

async function testRange() {
    const url = "https://phs2.krakencloud.net/play/video/YTI2NDcwZDEyMWU2YWU4ZlK-HQ9X3-7W-wFYG4Jw0bwD9be34YAqPKvjqU60PPneyNV6mOhJj5uR8_FO5efvznr990B9YJ5C_X8NjFGMnNH45-jDH4TIiOxfvOPFzjkjiN2ym4xLW5nNqgji3tx3qfRMGkIKash1amvvaW7M9cXBmkRN8IQabX4N8o0gDEHx";
    
    console.log('\nMengecek dukungan Multi-Connection (Range Header)...');
    try {
        const res = await axios({
            method: 'get',
            url: url,
            headers: { 
                'Range': 'bytes=0-102400',
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                'Referer': 'https://krakenfiles.com/'
            },
            responseType: 'stream',
            validateStatus: () => true
        });

        console.log(`Status Code: ${res.status}`);
        console.log(`Accept-Ranges: ${res.headers['accept-ranges']}`);
        console.log(`Content-Range: ${res.headers['content-range']}`);
        
        if (res.status === 206) {
            console.log('\n✅ URL VIDEO INI MENDUKUNG RANGE REQUEST!');
        } else {
            console.log('\n❌ TIDAK MENDUKUNG RANGE REQUEST.');
        }
        res.data.destroy();
    } catch (e) {
        console.error(e.message);
    }
}
testRange();
