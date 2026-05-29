const { extractVideoUrl } = require('./src/scraper/extractor');

(async () => {
  try {
    const res = await extractVideoUrl('https://www.blogger.com/video.g?token=AD6v5dwTGTgJfD-lOE-THF1oTZgPq79CNsb9KDF5jydrZdLtaUjYo6YpNb82jNUyd-hBZGTgPRdAQtBzhzDgmxNG_9H4IG03SQ1CwXXvVJj6mThAUn-_N6XhWrkC1iev_KgrPmWaI-Y');
    console.log('RESULT:', res);
  } catch (err) {
    console.error('ERROR:', err);
  } process.exit(0);
})();
