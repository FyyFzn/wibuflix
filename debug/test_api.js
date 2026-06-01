const { startServer } = require('./server');
const { scrapeVideoServers } = require('./scraper/extractor');
const { initPagePool, destroyPagePool } = require('./puppeteer/pool');

async function testApi() {
    try {
        console.log("Init pool...");
        await initPagePool();
        const url = 'https://v2.samehadaku.how/one-piece-episode-1107/';
        console.log("Scraping", url);
        const data = await scrapeVideoServers(url);
        console.log("SERVERS FOUND:");
        console.log(JSON.stringify(data.servers, null, 2));
    } catch(e) {
        console.error(e);
    } finally {
        await destroyPagePool();
        process.exit(0);
    }
}
testApi();
