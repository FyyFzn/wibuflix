const { getNeosatsuEpisodes, getNeosatsuServers } = require('./src/scraper/neosatsu');

async function test() {
    try {
        const url = 'neosatsu-merge:Kamen Rider Ghost';
        const data = await getNeosatsuEpisodes(url);
        console.log('Episode count:', data.daftar_episode.length);
        
        // Print first 5
        for(let i=0; i<5; i++) {
            if(data.daftar_episode[i]) console.log(`[${i}] ${data.daftar_episode[i].judul}`);
        }
        console.log('---');
        // Print last 5
        for(let i=data.daftar_episode.length-5; i<data.daftar_episode.length; i++) {
            if(data.daftar_episode[i]) console.log(`[${i}] ${data.daftar_episode[i].judul}`);
        }

        // Test nav for the last one
        const lastEp = data.daftar_episode[data.daftar_episode.length-1];
        const res = await getNeosatsuServers(lastEp.url);
        console.log('\nNav Prev for last ep:', res.nav_prev ? 'YES' : 'NO');
        console.log('Nav Next for last ep:', res.nav_next ? 'YES' : 'NO');
    } catch(e) {
        console.error(e);
    }
}
test();
