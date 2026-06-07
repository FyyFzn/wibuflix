const puppeteer = require('puppeteer');

(async () => {
  const browser = await puppeteer.launch({ headless: 'new' });
  const page = await browser.newPage();
  
  await page.goto('https://acefile.co/player/111526118', { waitUntil: 'networkidle2' });
  
  await new Promise(r => setTimeout(r, 2000)); // wait extra
  
  const iframes = await page.evaluate(() => {
      return Array.from(document.querySelectorAll('iframe')).map(i => i.src);
  });
  console.log('IFRAMES:', iframes);
  
  // click default
  try {
     await page.evaluate(() => {
         document.querySelector('.linkserver[data-holder="default"]').click();
     });
     await new Promise(r => setTimeout(r, 3000));
     
     const iframes2 = await page.evaluate(() => {
         return Array.from(document.querySelectorAll('iframe')).map(i => i.src);
     });
     console.log('IFRAMES AFTER CLICK:', iframes2);
     
  } catch(e) {
      console.log('Err click:', e.message);
  }

  await page.screenshot({ path: 'acefile.png' });
  await browser.close();
})();
