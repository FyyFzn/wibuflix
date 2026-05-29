const { scrapeVideoServers, resolveSingleServer } = require('./src/scraper/extractor');

(async () => {
  try {
    const data = await scrapeVideoServers('https://v2.samehadaku.how/2-5-jigen-no-ririsa-episode-1/');
    console.log(data.servers);
    const bloggerServer = data.servers.find(s => s.nama.toLowerCase().includes('blogger'));
    if (bloggerServer) {
        console.log('Found blogger:', bloggerServer);
        const resolved = await resolveSingleServer('https://v2.samehadaku.how/2-5-jigen-no-ririsa-episode-1/', bloggerServer.nume);
        console.log('Resolved iframe:', resolved.iframeUrl);
        
        const { extractVideoUrl } = require('./src/scraper/extractor');
        const finalUrl = await extractVideoUrl(resolved.iframeUrl);
        console.log('Final URL:', finalUrl);
    }
  } catch (err) {
    console.error('ERROR:', err);
  } process.exit(0);
})();
