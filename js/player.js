import { State } from './state.js';
import { embedPlayer, playerOverlay, serverListContainer } from './ui.js';
import { resolveServer } from './api.js';

let hlsInstance = null;
let iframeReqId = 0;

export function stopVideo() {
    // Increment reqId so any pending extract callbacks become stale and no-op
    iframeReqId++;

    // Stop & unload iframe
    embedPlayer.src = '';

    // Stop & unload native player
    const nativePlayer = document.getElementById('nativePlayer');
    if (nativePlayer) {
        nativePlayer.pause();
        nativePlayer.removeAttribute('src');
        nativePlayer.load();
        nativePlayer.style.display = 'none';
    }

    // Destroy HLS instance
    if (hlsInstance) {
        hlsInstance.destroy();
        hlsInstance = null;
    }

    // Hide overlay
    const overlay = document.getElementById('playerOverlay');
    if (overlay) overlay.style.display = 'none';

    // Restore iframe visibility for next time
    embedPlayer.style.display = 'block';
}

export function muatIframe(url, serverName = '', targetUrl = '', onExtractFail = null) {
    if (!url) return;
    iframeReqId++;
    const currentReqId = iframeReqId;
    
    playerOverlay.style.display = 'flex';

    const iframe = embedPlayer;
    const nativePlayer = document.getElementById('nativePlayer');
    const namaServerLokal = (serverName || '').toLowerCase();

    if (typeof hlsInstance !== 'undefined' && hlsInstance) {
        hlsInstance.destroy();
        hlsInstance = null;
    }
    
    if (nativePlayer) {
        nativePlayer.pause();
        nativePlayer.removeAttribute('src');
        nativePlayer.load();

        const playPromise = nativePlayer.play();
        if (playPromise !== undefined) {
            playPromise.catch(() => {});
        }
    }

    function fallbackKeIframe() {
        if (nativePlayer) {
            nativePlayer.style.display = 'none';
        }
        iframe.style.display = 'block';
        iframe.src = url;
        iframe.onload = () => {
            playerOverlay.style.display = 'none';
        };
        setTimeout(() => { playerOverlay.style.display = 'none'; }, 8000);
    }

    if (namaServerLokal.includes('wibufile')) {
        fallbackKeIframe();
        return;
    }

    // Untuk Pucuk / Filedon yang di-embed langsung ke iframe,
    // kita akan ekstrak URL MP4/M3U8-nya via backend API
    const extractApiUrl = `http://localhost:3000/api/extract-video?url=${encodeURIComponent(url)}`;
    
    fetch(extractApiUrl)
        .then(r => r.json())
        .then(data => {
            if (currentReqId !== iframeReqId) return;

            if (data.success && data.url) {
                if (nativePlayer) {
                    iframe.style.display = 'none';
                    iframe.src = '';
                    nativePlayer.style.display = 'block';
                    playerOverlay.style.display = 'none';

                    if (data.url.includes('.m3u8')) {
                        if (typeof Hls !== 'undefined' && Hls.isSupported()) {
                            hlsInstance = new Hls();
                            hlsInstance.loadSource(data.url);
                            hlsInstance.attachMedia(nativePlayer);
                            hlsInstance.on(Hls.Events.MANIFEST_PARSED, function() {
                                nativePlayer.play().catch(e => console.log('Auto-play dicegah'));
                            });
                        } else if (nativePlayer.canPlayType('application/vnd.apple.mpegurl')) {
                            nativePlayer.src = data.url;
                            nativePlayer.addEventListener('loadedmetadata', function() {
                                nativePlayer.play().catch(e => console.log('Auto-play dicegah'));
                            });
                        } else {
                            if (onExtractFail) onExtractFail();
                            else fallbackKeIframe(); 
                        }
                    } else {
                        nativePlayer.src = data.url;
                        nativePlayer.play().catch(e => console.log('Auto-play dicegah browser'));
                    }
                }
            } else {
                if (onExtractFail) onExtractFail();
                else fallbackKeIframe();
            }
        })
        .catch(err => {
            if (currentReqId !== iframeReqId) return;
            if (onExtractFail) onExtractFail();
            else fallbackKeIframe();
        });
}

export function mainkanAntreanServer(antreanServer, targetUrl) {
    const cobaServerBerikutnya = () => {
        if (antreanServer.length === 0) {
            playerOverlay.style.display = 'none';
            serverListContainer.innerHTML = '<p class="empty-msg error-msg">Semua server gagal diputar atau video dihapus.</p>';
            return;
        }
        
        const s = antreanServer.shift();
        
        const onExtractFail = () => {
            console.warn(`[Auto-Play] Server ${s.namaHost || s.nama} gagal/error. Mencoba berikutnya...`);
            cobaServerBerikutnya();
        };

        if (s.iframeUrl) {
            muatIframe(s.iframeUrl, s.namaHost || s.nama, targetUrl, onExtractFail);
        } else {
            resolveServer(targetUrl, s.nume)
                .then(res => {
                    if (res.data && res.data.iframeUrl) {
                        muatIframe(res.data.iframeUrl, s.namaHost || s.nama, targetUrl, onExtractFail);
                    } else {
                        onExtractFail();
                    }
                })
                .catch(() => onExtractFail());
        }
    };

    cobaServerBerikutnya();
}
