const { extractVideoUrl } = require('./src/scraper/extractor');

(async () => {
  try {
    const res = await extractVideoUrl('https://krakenfiles.com/embed-video/9gpqbM7Jd7');
    console.log('RESULT:', res);
  } catch (err) {
    console.error('ERROR:', err);
  } process.exit(0);
})();
