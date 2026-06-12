import * as kraken from './src/scraper/extractors/krakenfiles.js';

async function test() {
    // Karena URL dummy kemarin 404, kita ambil dari argumen (misal: node test_kraken_extractor.js "URL_KRAKEN")
    const url = process.argv[2];
    
    if (!url) {
        console.error('Harap masukkan URL KrakenFiles!');
        console.error('Contoh: node test_kraken_extractor.js "https://krakenfiles.com/view/abcde/file.html"');
        return;
    }

    console.log(`Menguji extractor Krakenfiles untuk URL: ${url}`);
    
    try {
        const result = await kraken.extract(url);
        console.log('\n--- HASIL EKSTRAKSI ---');
        console.log(result);
        
        if (result && result.url) {
            console.log('\nExtractor BERHASIL mendapatkan direct link!');
        } else {
            console.log('\nExtractor GAGAL (URL tidak didapatkan).');
        }
    } catch (err) {
        console.error('Error saat tes extractor:', err.message);
    }
}

test();
