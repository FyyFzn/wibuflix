import { State, loadState, saveState, getRiwayat, simpanKeRiwayat } from './state.js';
import * as UI from './ui.js';
import { fetchKatalog, fetchEpisodes, scrapeVideo, resolveServer } from './api.js';
import { muatIframe, mainkanAntreanServer, stopVideo } from './player.js';

// ── Inisialisasi State ─────────────────────────────────────────
const savedState = loadState();
    if (savedState) {
        if (savedState.layarId === 'layarPlayer' && State.episodeUrlSaatIni) {
            putarEpisode(State.episodeUrlSaatIni, State.gambarSeriSaatIni);
        } else if (savedState.layarId === 'layarDaftarEpisode' && State.urlSeriSaatIni) {
            bukaSeriAnime(State.urlSeriSaatIni, State.gambarSeriSaatIni);
        } else if (savedState.layarId === 'layarHistory') {
            renderHistoryPage();
            UI.tampilkan(UI.layarHistory);
        } else {
            muatKatalog();
        }
    } else {
        muatKatalog();
    }
    renderHistoryDropdown();

    // ── Event Listener: Katalog ───────────────────────────────────
    UI.btnSearch.addEventListener('click', () => {
        State.currentSearch = UI.inputSearch.value.trim();
        State.currentPage = 1;
        muatKatalog();
    });

    UI.inputSearch.addEventListener('keypress', e => {
        if (e.key === 'Enter') UI.btnSearch.click();
    });

    UI.btnPagePrev.addEventListener('click', () => {
        if (State.currentPage > 1) { State.currentPage--; muatKatalog(); }
    });

    UI.btnPageNext.addEventListener('click', () => {
        State.currentPage++;
        muatKatalog();
    });

    // ── Event Listener: Navigasi ──────────────────────────────────
    UI.btnKembaliKatalog.addEventListener('click', () => UI.tampilkan(UI.layarKatalog));
    
    UI.btnKembaliEps.addEventListener('click', () => {
        stopVideo();
        UI.tampilkan(State.urlSeriSaatIni ? UI.layarDaftarEpisode : UI.layarKatalog);
    });

    UI.logoTitle.addEventListener('click', () => {
        stopVideo();
        UI.tampilkan(UI.layarKatalog);
    });

    UI.historyIconBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        renderHistoryPage();
        UI.tampilkan(UI.layarHistory);
    });

    UI.btnKembaliDariHistory.addEventListener('click', () => UI.tampilkan(UI.layarKatalog));

    UI.btnHistoryPrev.addEventListener('click', () => {
        if (State.historyPage > 1) { State.historyPage--; renderHistoryPage(); }
    });

    UI.btnHistoryNext.addEventListener('click', () => {
        State.historyPage++;
        renderHistoryPage();
    });

    // ── Katalog Logic ─────────────────────────────────────────────
    async function muatKatalog() {
        UI.setLoading('Memuat daftar anime...');
        try {
            const json = await fetchKatalog(State.currentPage, State.currentSearch);
            if (json.status !== 'success') throw new Error(json.message);
            
            UI.katalogGrid.innerHTML = '';
            
            if (!json.data.list || json.data.list.length === 0) {
                UI.katalogGrid.innerHTML = '<p class="empty-msg">Tidak ada anime yang ditemukan.</p>';
            } else {
                json.data.list.forEach(item => {
                    const card = document.createElement('div');
                    card.className = 'anime-card';

                    const tipe = (item.tipe || 'TV').toUpperCase();
                    let badgeClass = 'badge-type';
                    if (tipe === 'MOVIE') badgeClass += ' movie';
                    else if (tipe === 'OVA' || tipe === 'ONA' || tipe === 'SPECIAL') badgeClass += ' special';

                    card.innerHTML = `
                        <div class="img-container">
                            <img src="${item.gambar}"
                                 alt="${item.judul}"
                                 loading="lazy"
                                 onerror="this.onerror=null;this.src='${item.gambarScraper || item.gambar}'">
                            <span class="${badgeClass}">${tipe}</span>
                            ${item.skor && item.skor !== '-' ? `<span class="badge-score"><span>★</span>${item.skor}</span>` : ''}
                            ${item.status ? `<span class="badge-ep">${item.status}</span>` : ''}
                        </div>
                        <div class="card-title">${item.judul}</div>
                    `;
                    card.addEventListener('click', () => bukaSeriAnime(item.url, item.gambar));
                    UI.katalogGrid.appendChild(card);
                });
            }

            UI.pageInfo.textContent = `Hal ${State.currentPage}`;
            UI.btnPagePrev.disabled = State.currentPage === 1;
            UI.btnPageNext.disabled = !json.data.hasNext;

            UI.tampilkan(UI.layarKatalog);
            window.scrollTo(0, 0);
        } catch (err) {
            console.error('[Katalog]', err);
            UI.katalogGrid.innerHTML = '<p class="empty-msg error-msg">Gagal memuat katalog.</p>';
            UI.tampilkan(UI.layarKatalog);
        }
    }

    // ── Episode List Logic ────────────────────────────────────────
    let _fullEpisodeList = [];
    let _epsSort = 'desc'; // 'desc' = terbaru, 'asc' = terlama

    function renderEpisodeList(list) {
        UI.epsListContainer.innerHTML = '';
        if (!list.length) {
            UI.epsListContainer.innerHTML = '<p class="empty-msg">Tidak ada episode yang ditemukan.</p>';
            return;
        }
        list.forEach(eps => {
            const item = document.createElement('div');
            item.className = 'eps-item';
            item.innerHTML = `
                <div class="eps-main">
                    <div class="eps-title">${eps.judul}</div>
                    ${eps.malJudul ? `<div class="eps-mal-title">${eps.malJudul}</div>` : ''}
                </div>
                <div class="eps-date">${eps.tanggal}</div>
            `;
            item.addEventListener('click', () => putarEpisode(eps.url, State.gambarSeriSaatIni));
            UI.epsListContainer.appendChild(item);
        });
    }

    function applyEpsFilter() {
        const query = (document.getElementById('inputEpsSearch')?.value || '').trim().toLowerCase();
        let list = [..._fullEpisodeList];
        if (query) {
            list = list.filter(e => e.judul.toLowerCase().includes(query));
        }
        if (_epsSort === 'asc') list = list.reverse();
        renderEpisodeList(list);
    }

    document.getElementById('inputEpsSearch')?.addEventListener('input', applyEpsFilter);

    document.getElementById('btnEpsSort')?.addEventListener('click', () => {
        const btn = document.getElementById('btnEpsSort');
        _epsSort = _epsSort === 'desc' ? 'asc' : 'desc';
        btn.textContent = _epsSort === 'desc' ? 'Terbaru ↑' : 'Terlama ↓';
        applyEpsFilter();
    });


    async function bukaSeriAnime(targetUrl, gambarFallback = '') {
        UI.setLoading('Mengambil daftar episode & info MAL...');
        State.urlSeriSaatIni = targetUrl;
        State.gambarSeriSaatIni = gambarFallback;

        // Reset search/sort state
        const searchInput = document.getElementById('inputEpsSearch');
        const sortBtn = document.getElementById('btnEpsSort');
        if (searchInput) searchInput.value = '';
        if (sortBtn) sortBtn.textContent = 'Terbaru ↑';
        _epsSort = 'desc';

        try {
            const json = await fetchEpisodes(targetUrl);
            if (json.status !== 'success') throw new Error(json.message);
            const data = json.data;

            // ── Render MAL Panel ──────────────────────────────
            const malPanel   = document.getElementById('malPanel');
            const malCover   = document.getElementById('malCover');
            const malScoreEl = document.getElementById('malScore');
            const malScoreVal= document.getElementById('malScoreVal');
            const malStatus  = document.getElementById('malStatus');
            const malYear    = document.getElementById('malYear');
            const malEpsEl   = document.getElementById('malEps');
            const malLink    = document.getElementById('malLink');
            const malGenres  = document.getElementById('malGenres');
            const malSynopsis= document.getElementById('malSynopsis');
            const malStudios = document.getElementById('malStudios');
            const btnToggle  = document.getElementById('btnToggleSynopsis');

            if (data.mal) {
                const m = data.mal;

                // Cover — MAL default, fallback ke gambar scraper / katalog
                const coverSrc = m.cover || data.cover_scraper || gambarFallback || '';
                malCover.src = coverSrc;
                malCover.onerror = () => {
                    malCover.src = data.cover_scraper || gambarFallback || '';
                };
                State.gambarSeriSaatIni = coverSrc;

                // Judul
                UI.judulSeriAnime.textContent = data.judul_seri;

                // Score
                if (m.malScore) {
                    malScoreVal.textContent = m.malScore;
                    malScoreEl.classList.remove('hidden');
                } else {
                    malScoreEl.classList.add('hidden');
                }

                // Status
                if (m.status) {
                    malStatus.textContent = m.status;
                    malStatus.classList.remove('hidden');
                } else { malStatus.classList.add('hidden'); }

                // Year
                if (m.year) {
                    malYear.textContent = m.year;
                    malYear.classList.remove('hidden');
                } else { malYear.classList.add('hidden'); }

                // Episodes count
                if (m.episodes) {
                    malEpsEl.textContent = `${m.episodes} Eps`;
                    malEpsEl.classList.remove('hidden');
                } else { malEpsEl.classList.add('hidden'); }

                // MAL link
                if (m.malUrl) {
                    malLink.href = m.malUrl;
                    malLink.classList.remove('hidden');
                } else { malLink.classList.add('hidden'); }

                // Genres
                malGenres.innerHTML = '';
                (m.genres || []).forEach(g => {
                    const chip = document.createElement('span');
                    chip.className = 'genre-chip';
                    chip.textContent = g;
                    malGenres.appendChild(chip);
                });

                // Synopsis + toggle
                if (m.synopsis) {
                    malSynopsis.textContent = m.synopsis;
                    malSynopsis.classList.remove('hidden');
                    malSynopsis.classList.add('synopsis-collapsed');
                    btnToggle.classList.remove('hidden');
                    btnToggle.textContent = 'Tampilkan sinopsis ▾';

                    btnToggle.onclick = () => {
                        const collapsed = malSynopsis.classList.toggle('synopsis-collapsed');
                        btnToggle.textContent = collapsed ? 'Tampilkan sinopsis ▾' : 'Sembunyikan sinopsis ▴';
                    };
                } else {
                    malSynopsis.classList.add('hidden');
                    btnToggle.classList.add('hidden');
                }

                // Studios
                if (m.studios && m.studios.length > 0) {
                    malStudios.textContent = '🎬 ' + m.studios.join(', ');
                    malStudios.classList.remove('hidden');
                } else { malStudios.classList.add('hidden'); }

                malPanel.classList.remove('hidden');
                UI.judulSeriAnimeFallback.classList.add('hidden');
            } else {
                // Tidak ada MAL — fallback ke tampilan judul biasa
                malPanel.classList.add('hidden');
                UI.judulSeriAnimeFallback.textContent = data.judul_seri;
                UI.judulSeriAnimeFallback.classList.remove('hidden');
                // Tetap update gambar dari scraper / katalog
                State.gambarSeriSaatIni = data.cover_scraper || gambarFallback || '';
            }

            _fullEpisodeList = data.daftar_episode || [];
            applyEpsFilter();

            UI.tampilkan(UI.layarDaftarEpisode);
            window.scrollTo(0, 0);
        } catch (err) {
            console.error('[Episodes]', err);
            alert('Gagal memuat daftar episode.');
            UI.tampilkan(UI.layarKatalog);
        }
    }



    // ── Player Logic ──────────────────────────────────────────────
    async function putarEpisode(targetUrl, gambar = '') {
        UI.setLoading('Menembus Cloudflare & mengambil server video...');
        
        stopVideo();
        document.getElementById('overlayBtnPrev').classList.add('hidden');
        document.getElementById('overlayBtnNext').classList.add('hidden');
        
        UI.serverListContainer.innerHTML = '';
        UI.btnPrev.disabled = true;
        UI.btnNext.disabled = true;
        State.episodeUrlSaatIni = targetUrl;


        try {
            const json = await scrapeVideo(targetUrl);
            if (json.status !== 'success') throw new Error(json.message);
            const data = json.data;

            UI.judulEpisode.textContent = data.judul;

            if (data.servers && data.servers.length > 0) {
                const prioritas = ['pucuk', 'wibufile'];
                const getRes = (n) => {
                    const m = (n || '').match(/(\d+)p/i);
                    return m ? parseInt(m[1]) : 0;
                };

                data.servers.sort((a, b) => {
                    const snA = (a.namaHost || a.nama || '').toLowerCase();
                    const snB = (b.namaHost || b.nama || '').toLowerCase();
                    let idxA = prioritas.findIndex(p => snA.includes(p));
                    let idxB = prioritas.findIndex(p => snB.includes(p));
                    if (idxA === -1) idxA = 999;
                    if (idxB === -1) idxB = 999;
                    
                    if (idxA !== idxB) return idxA - idxB;
                    return getRes(b.nama) - getRes(a.nama);
                });

                simpanKeRiwayat(data.judul, targetUrl, gambar || '');
                renderHistoryDropdown();
                renderTombolServer(data.servers, targetUrl);

                let antreanServer = [];
                if (State.lastUsedServer) {
                    const memServers = data.servers.filter(s => {
                        const sn = (s.namaHost || s.nama || '').toLowerCase();
                        return sn.includes(State.lastUsedServer) || State.lastUsedServer.includes(sn);
                    });
                    antreanServer.push(...memServers);
                }

                for (const s of data.servers) {
                    if (!antreanServer.includes(s)) antreanServer.push(s);
                }

                mainkanAntreanServer(antreanServer, targetUrl);

            } else {
                UI.serverListContainer.innerHTML = '<p class="empty-msg error-msg">Tidak ada server video yang ditemukan.</p>';
            }

            UI.btnPrev.disabled = !data.nav_prev;
            UI.btnNext.disabled = !data.nav_next;

            const onPrev = data.nav_prev ? () => putarEpisode(data.nav_prev, gambar) : null;
            const onNext = data.nav_next ? () => putarEpisode(data.nav_next, gambar) : null;

            UI.btnPrev.onclick = onPrev;
            UI.btnNext.onclick = onNext;

            const overlayPrev = document.getElementById('overlayBtnPrev');
            const overlayNext = document.getElementById('overlayBtnNext');
            
            if (onPrev) {
                overlayPrev.classList.remove('hidden');
                overlayPrev.onclick = onPrev;
            }
            if (onNext) {
                overlayNext.classList.remove('hidden');
                overlayNext.onclick = onNext;
            }

            UI.tampilkan(UI.layarPlayer);
            window.scrollTo(0, 0);
        } catch (err) {
            console.error('[Player]', err);
            alert('Gagal memuat video.');
            UI.tampilkan(State.urlSeriSaatIni ? UI.layarDaftarEpisode : UI.layarKatalog);
        }
    }

    // ── Server Dropdown Logic ─────────────────────────────────────
    function renderTombolServer(servers, episodeUrl) {
        UI.serverListContainer.innerHTML = '';
        const grup = {};
        servers.forEach((srv, i) => {
            let kunci;
            if (srv.namaHost) {
                kunci = srv.namaHost.toLowerCase();
            } else {
                const nama = srv.nama || '';
                const bagian = nama.split('·');
                const kandidat = bagian[bagian.length - 1].trim().split(' ')[0];
                kunci = kandidat.toLowerCase() || `server_${i}`;
            }

            if (!grup[kunci]) {
                grup[kunci] = {
                    label: srv.namaHost || kunci.charAt(0).toUpperCase() + kunci.slice(1),
                    items: []
                };
            }
            grup[kunci].items.push({ ...srv, _index: i });
        });

        Object.entries(grup).forEach(([kunci, g]) => {
            const wrapper = document.createElement('div');
            wrapper.className = 'server-wrapper';

            const btnMaster = document.createElement('button');
            btnMaster.className = 'btn-server';
            btnMaster.textContent = g.label;

            const dropdown = document.createElement('div');
            dropdown.className = 'server-dropdown hidden';

            function renderItemDropdown() {
                dropdown.innerHTML = '';
                g.items.forEach((srv) => {
                    const item = document.createElement('div');
                    item.className = 'dropdown-item';
                    const resolusi = (srv.nama || '').replace(/·.*$/, '').trim() || srv.namaHost || 'Default';

                    if (!srv.iframeUrl) {
                        item.textContent = '⏳ ' + resolusi;
                        item.style.opacity = '0.5';
                        item.style.pointerEvents = 'none';
                    } else {
                        item.textContent = resolusi;
                        item.addEventListener('click', () => {
                            State.lastUsedServer = (srv.namaHost || srv.nama || '').toLowerCase().trim();
                            muatIframe(srv.iframeUrl, srv.namaHost || srv.nama, episodeUrl);
                            document.querySelectorAll('.btn-server').forEach(b => b.classList.remove('active'));
                            btnMaster.classList.add('active');
                            dropdown.classList.add('hidden');
                        });
                    }
                    dropdown.appendChild(item);
                });
            }

            renderItemDropdown();

            btnMaster.addEventListener('click', async () => {
                document.querySelectorAll('.server-dropdown').forEach(d => {
                    if (d !== dropdown) d.classList.add('hidden');
                });
                dropdown.classList.toggle('hidden');

                const belumResolve = g.items.filter(srv => !srv.iframeUrl);
                if (belumResolve.length > 0) {
                    belumResolve.forEach(async (srv) => {
                        try {
                            const res = await resolveServer(episodeUrl, srv.nume);
                            if (res.data && res.data.iframeUrl) {
                                srv.iframeUrl = res.data.iframeUrl;
                                srv.namaHost = res.data.namaHost || srv.namaHost;
                                if (!g.label || g.label === kunci) {
                                    g.label = srv.namaHost;
                                    btnMaster.textContent = g.label;
                                }
                                renderItemDropdown();
                            }
                        } catch (e) {}
                    });
                }

                if (g.items.length === 1 && g.items[0].iframeUrl) {
                    State.lastUsedServer = (g.items[0].namaHost || g.items[0].nama || '').toLowerCase().trim();
                    muatIframe(g.items[0].iframeUrl, g.items[0].namaHost || g.items[0].nama, episodeUrl);
                    document.querySelectorAll('.btn-server').forEach(b => b.classList.remove('active'));
                    btnMaster.classList.add('active');
                    dropdown.classList.add('hidden');
                }
            });
            wrapper.appendChild(btnMaster);
            wrapper.appendChild(dropdown);
            UI.serverListContainer.appendChild(wrapper);
        });

        document.addEventListener('click', (e) => {
            if (!e.target.closest('.server-wrapper')) {
                document.querySelectorAll('.server-dropdown').forEach(d => d.classList.add('hidden'));
            }
        }, { once: false });
    }

    // ── History Logic ─────────────────────────────────────────────
    function renderHistoryDropdown() {
        const d = document.getElementById('historyDropdown');
        const c = document.getElementById('historyDropdownList');
        const count = document.getElementById('historyCount');
        const r = getRiwayat();
        
        if (count) count.textContent = r.length;
        if (r.length === 0) {
            if (c) c.innerHTML = '<div style="padding:1rem;color:var(--text-dim);">Belum ada riwayat tontonan.</div>';
            return;
        }

        if (c) c.innerHTML = '';
        r.slice(0, 5).forEach(item => {
            const div = document.createElement('div');
            div.className = 'hist-drop-item';
            div.innerHTML = `
                <img src="${item.gambar}" alt="">
                <div class="hist-drop-info">
                    <div class="hist-drop-title">${item.judulSeri}</div>
                    <div class="hist-drop-ep">Episode ${item.nomorEp}</div>
                </div>
            `;
            div.addEventListener('click', (e) => {
                e.stopPropagation();
                if (d) d.classList.add('hidden');
                putarEpisode(item.url, item.gambar);
            });
            if (c) c.appendChild(div);
        });
        
        if (r.length > 5) {
            const b = document.createElement('div');
            b.className = 'hist-drop-more';
            b.textContent = `Lihat semua (${r.length})`;
            b.addEventListener('click', (e) => {
                e.stopPropagation();
                if (d) d.classList.add('hidden');
                renderHistoryPage();
                UI.tampilkan(UI.layarHistory);
            });
            if (c) c.appendChild(b);
        }
    }

    function renderHistoryPage() {
        const grid = document.getElementById('historyGrid');
        const r = getRiwayat();
        if (grid) grid.innerHTML = '';

        if (r.length === 0) {
            if (grid) grid.innerHTML = '<div class="empty-msg" style="grid-column: 1/-1;">Belum ada riwayat.</div>';
            if (UI.historyPaginationArea) UI.historyPaginationArea.style.display = 'none';
            return;
        }

        if (UI.historyPaginationArea) UI.historyPaginationArea.style.display = 'flex';
        const w = window.innerWidth;
        if (w >= 1200) State.historyPerPage = 12;
        else if (w >= 768) State.historyPerPage = 9;
        else State.historyPerPage = 6;

        const maxPage = Math.ceil(r.length / State.historyPerPage);
        if (State.historyPage > maxPage) State.historyPage = maxPage;

        const start = (State.historyPage - 1) * State.historyPerPage;
        const end = start + State.historyPerPage;
        const slice = r.slice(start, end);

        slice.forEach(item => {
            const card = document.createElement('div');
            card.className = 'history-card';
            card.innerHTML = `
                <div class="img-container">
                    <img src="${item.gambar}" alt="" loading="lazy">
                    <span class="hist-ep-badge">Eps ${item.nomorEp}</span>
                </div>
                <div class="history-info">
                    <div class="history-title">${item.judulSeri}</div>
                    <div class="history-time">${UI.formatWaktuYangLalu(item.waktu)}</div>
                </div>
            `;
            card.addEventListener('click', () => putarEpisode(item.url, item.gambar));
            if (grid) grid.appendChild(card);
        });

        if (UI.historyPageInfo) UI.historyPageInfo.textContent = `Hal ${State.historyPage} dari ${maxPage}`;
        if (UI.btnHistoryPrev) UI.btnHistoryPrev.disabled = State.historyPage === 1;
        if (UI.btnHistoryNext) UI.btnHistoryNext.disabled = State.historyPage === maxPage;
    }

    const histWrapper = document.getElementById('historyTopbar');
    const histDrop = document.getElementById('historyDropdown');
    if (histWrapper) {
        histWrapper.addEventListener('click', (e) => {
            e.stopPropagation();
            if (histDrop) histDrop.classList.toggle('hidden');
        });
    }

    document.addEventListener('click', (e) => {
        if (!e.target.closest('#historyTopbar')) {
            if (histDrop) histDrop.classList.add('hidden');
        }
    });
