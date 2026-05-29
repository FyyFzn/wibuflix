const http = require('http');

http.get('http://localhost:3000/api/katalog?page=2', (res) => {
    let data = '';
    res.on('data', (chunk) => data += chunk);
    res.on('end', () => {
        try {
            const json = JSON.parse(data);
            console.log('Status:', json.status);
            console.log('Message:', json.message);
            console.log('HasNext:', json.data.hasNext);
            console.log('List Length:', json.data.list.length);
            if (json.data.list.length > 0) {
                console.log('First Item:', json.data.list[0]);
            } else if (json.data.html) {
                console.log('HTML Preview:', json.data.html);
            }
        } catch(e) {
            console.log('Raw output:', data.substring(0, 500));
        }
    });
}).on('error', (err) => {
    console.error('Error:', err.message);
});
