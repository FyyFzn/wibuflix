const { getNeosatsuServers } = require('./src/scraper/neosatsu');
const { extractVideo } = require('./src/scraper/extractor');

async function test() {
    try {
        console.log("Fetching servers for Ep 1...");
        const res = await getNeosatsuServers('neosatsu-merge:Kamen Rider Ghost___neosatsu_ep___Episode_01');
        const srv = res.servers.find(s => s.namaHost === 'acefile');
        if (!srv) {
            console.log("Acefile not found!");
            return;
        }
        
        console.log("Acefile iframe:", srv.iframeUrl);
        console.log("Extracting video...");
        const ext = await extractVideo(srv.iframeUrl, 'acefile');
        console.log("Extracted:", ext.success ? 'Success' : 'Failed', ext.url ? 'URL found' : 'No URL', ext.webviewOnly ? 'WebView Only' : '');
        
        if(ext.url) {
            console.log("URL:", ext.url.substring(0, 50) + "...");
        }
    } catch(e) {
        console.error(e);
    }
}
test();
