const axios = require('axios');
axios.get('https://www.neosatsu.com/feeds/posts/default/-/Gavv?alt=json&max-results=50').then(res => {
    res.data.feed.entry.forEach((e, i) => {
        if(e.title.$t.includes('Episode')) {
            console.log(`[${i}]`, e.title.$t);
        }
    });
});
