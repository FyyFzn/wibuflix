(async () => {
  try {
    const url = 'https://krakenfiles.com/embed-video/9gpqbM7Jd7';
    const res = await fetch(url, { headers: { 'User-Agent': 'Posify/1.0.0', 'Referer': url } });
    const text = await res.text();
    
    const tokenMatch = text.match(/id="dl-token"[^>]*value="([^"]+)"/);
    const token = tokenMatch ? tokenMatch[1] : null;
    
    let dlMatch = text.match(/<video[^>]*><source[^>]*src="([^"]+)"/);
    let dl = dlMatch ? dlMatch[1] : null;
    if(dl && dl.startsWith('//')) dl = 'https:' + dl;
    
    console.log('Download URL:', dl);
    console.log('Token:', token);
    
    const streamRes = await fetch(dl, {
        method: 'HEAD',
        headers: {
            'User-Agent': 'Posify/1.0.0',
            'Referer': url,
            'token': token
        }
    });
    console.log('Stream HEAD status:', streamRes.status);
    
  } catch(e){
    console.error(e);
  }
})();
