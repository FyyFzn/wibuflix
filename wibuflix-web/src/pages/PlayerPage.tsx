import { useState, useEffect, useRef, useCallback } from 'react';
import { useSearchParams, useNavigate } from 'react-router-dom';
import Hls from 'hls.js';
import { RefreshCw, AlertTriangle, Server, ArrowLeft, X } from 'lucide-react';
import { fetchSmartPlay, scrapeVideo } from '../services/api';
import { simpanKeRiwayat, updateProgress, getProgress } from '../services/storage';
import { ServerItem } from '../types';
import PlayerControls from '../components/PlayerControls';

export default function PlayerPage() {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();

  const episodeUrl = searchParams.get('url') || '';
  const seriesUrl = searchParams.get('seriUrl') || '';
  const episodeTitle = searchParams.get('judul') || 'Episode';
  const seriesTitle = searchParams.get('seriJudul') || episodeTitle;
  const coverImage = searchParams.get('gambar') || '';
  const uniqueId = searchParams.get('uniqueId') || '';

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const hlsRef = useRef<Hls | null>(null);

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [playerMode, setPlayerMode] = useState<'hls' | 'iframe' | 'none'>('none');
  const [videoSrc, setVideoSrc] = useState<string>('');
  const [iframeSrc, setIframeSrc] = useState<string>('');

  const [playing, setPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [volume, setVolume] = useState(1);
  const [muted, setMuted] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);

  const [servers, setServers] = useState<ServerItem[]>([]);
  const [activeServerName, setActiveServerName] = useState('Default Direct');
  const [serverModalOpen, setServerModalOpen] = useState(false);

  const [navPrev, setNavPrev] = useState<string | null>(null);
  const [navNext, setNavNext] = useState<string | null>(null);

  // Resume progress reference
  const initialSeekDone = useRef(false);

  // Cleanup HLS on unmount or src change
  const destroyHls = () => {
    if (hlsRef.current) {
      hlsRef.current.destroy();
      hlsRef.current = null;
    }
  };

  const loadStream = useCallback(async () => {
    if (!episodeUrl) return;
    setLoading(true);
    setError(null);
    setPlayerMode('none');
    setVideoSrc('');
    setIframeSrc('');
    destroyHls();
    initialSeekDone.current = false;

    // Save initial watch state to local history immediately
    simpanKeRiwayat(
      episodeTitle,
      episodeUrl,
      seriesUrl,
      coverImage,
      0,
      0,
      'Azure Cloud',
      seriesTitle,
      uniqueId
    );

    try {
      // 1. Try Smart-Play first (Fast Azure Stream)
      const smartPlay = await fetchSmartPlay(
        episodeUrl,
        seriesUrl,
        undefined,
        undefined,
        seriesTitle,
        episodeTitle,
        uniqueId
      ).catch(() => null);

      if (smartPlay) {
        if (smartPlay.nav_prev) setNavPrev(smartPlay.nav_prev);
        if (smartPlay.nav_next) setNavNext(smartPlay.nav_next);
        if (smartPlay.servers?.length) setServers(smartPlay.servers);

        if (smartPlay.status === 'READY' && smartPlay.url) {
          setVideoSrc(smartPlay.url);
          setPlayerMode('hls');
          setActiveServerName('Azure Direct HLS');
          setLoading(false);
          return;
        }
      }

      // 2. Fallback to Scrape UI servers
      const scrape = await scrapeVideo(episodeUrl, seriesTitle, episodeTitle).catch(() => null);
      if (scrape?.status === 'success' && scrape.data) {
        if (scrape.data.nav_prev) setNavPrev(scrape.data.nav_prev);
        if (scrape.data.nav_next) setNavNext(scrape.data.nav_next);
        if (scrape.data.servers?.length) setServers(scrape.data.servers);

        // Check if there is an active iframe or direct server
        const activeServer = scrape.data.servers.find(s => s.aktif) || scrape.data.servers[0];
        if (activeServer) {
          setActiveServerName(activeServer.namaHost || activeServer.nama);
          if (activeServer.iframeUrl) {
            setIframeSrc(activeServer.iframeUrl);
            setPlayerMode('iframe');
            setLoading(false);
            return;
          }
        }

        if (scrape.data.iframeAktif) {
          setIframeSrc(scrape.data.iframeAktif);
          setPlayerMode('iframe');
          setLoading(false);
          return;
        }
      }

      // If smartPlay was still transcoding
      if (smartPlay && smartPlay.status === 'UPLOADING') {
        setError(`Sedang transcoding ke HLS (${smartPlay.progress || 0}%). Silakan tunggu sebentar atau coba server lain.`);
      } else {
        setError('Video stream belum tersedia untuk episode ini. Silakan pilih server alternatif.');
      }
    } catch (err: any) {
      setError(err?.message || 'Gagal memuat video stream');
    } finally {
      setLoading(false);
    }
  }, [episodeUrl, seriesUrl, episodeTitle, seriesTitle, coverImage, uniqueId]);

  useEffect(() => {
    loadStream();
    return () => {
      destroyHls();
    };
  }, [loadStream]);

  // Attach HLS or native video when videoSrc changes
  useEffect(() => {
    if (playerMode !== 'hls' || !videoSrc || !videoRef.current) return;
    const video = videoRef.current;

    destroyHls();

    const resumeInfo = getProgress(episodeUrl);
    const startProgress = resumeInfo?.progress || 0;

    const onMediaAttached = () => {
      if (!initialSeekDone.current && startProgress > 5) {
        video.currentTime = startProgress;
        initialSeekDone.current = true;
      }
      video.play().catch(() => {});
    };

    if (Hls.isSupported()) {
      const hls = new Hls({
        enableWorker: true,
        lowLatencyMode: true,
        backBufferLength: 90
      });
      hlsRef.current = hls;
      hls.loadSource(videoSrc);
      hls.attachMedia(video);

      hls.on(Hls.Events.MANIFEST_PARSED, () => {
        onMediaAttached();
      });

      hls.on(Hls.Events.ERROR, (_event, data) => {
        if (data.fatal) {
          switch (data.type) {
            case Hls.ErrorTypes.NETWORK_ERROR:
              hls.startLoad();
              break;
            case Hls.ErrorTypes.MEDIA_ERROR:
              hls.recoverMediaError();
              break;
            default:
              destroyHls();
              setError('Terjadi kendala saat memutar stream HLS. Silakan pilih server cadangan.');
              break;
          }
        }
      });
    } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
      // Native Safari HLS
      video.src = videoSrc;
      video.addEventListener('loadedmetadata', onMediaAttached, { once: true });
    } else {
      video.src = videoSrc;
    }

    return () => {
      destroyHls();
    };
  }, [playerMode, videoSrc, episodeUrl]);

  // Periodic watch progress persistence (every 5 seconds)
  useEffect(() => {
    if (playerMode !== 'hls' || !playing || !videoRef.current || !episodeUrl) return;

    const interval = setInterval(() => {
      if (videoRef.current) {
        const cur = videoRef.current.currentTime;
        const dur = videoRef.current.duration || duration;
        if (cur > 0 && dur > 0) {
          updateProgress(episodeUrl, cur, dur, activeServerName);
        }
      }
    }, 5000);

    return () => clearInterval(interval);
  }, [playerMode, playing, episodeUrl, duration, activeServerName]);

  // Save on pause or unload
  const saveCurrentProgress = useCallback(() => {
    if (videoRef.current && episodeUrl) {
      const cur = videoRef.current.currentTime;
      const dur = videoRef.current.duration || duration;
      if (cur > 0 && dur > 0) {
        updateProgress(episodeUrl, cur, dur, activeServerName);
      }
    }
  }, [episodeUrl, duration, activeServerName]);

  useEffect(() => {
    const handleBeforeUnload = () => {
      saveCurrentProgress();
    };
    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => {
      saveCurrentProgress();
      window.removeEventListener('beforeunload', handleBeforeUnload);
    };
  }, [saveCurrentProgress]);

  // Player controls handlers
  const handlePlayPause = () => {
    if (!videoRef.current) return;
    if (playing) {
      videoRef.current.pause();
      saveCurrentProgress();
    } else {
      videoRef.current.play().catch(() => {});
    }
  };

  const handleSeek = (time: number) => {
    if (!videoRef.current) return;
    videoRef.current.currentTime = time;
    setCurrentTime(time);
  };

  const handleVolumeChange = (vol: number) => {
    if (!videoRef.current) return;
    videoRef.current.volume = vol;
    setVolume(vol);
    setMuted(vol === 0);
  };

  const handleToggleMute = () => {
    if (!videoRef.current) return;
    const newMuted = !muted;
    videoRef.current.muted = newMuted;
    setMuted(newMuted);
  };

  const handleToggleFullscreen = () => {
    if (!containerRef.current) return;
    if (!document.fullscreenElement) {
      containerRef.current.requestFullscreen().then(() => setIsFullscreen(true)).catch(() => {});
    } else {
      document.exitFullscreen().then(() => setIsFullscreen(false)).catch(() => {});
    }
  };

  const handleSelectServer = (server: ServerItem) => {
    setServerModalOpen(false);
    setActiveServerName(server.namaHost || server.nama);

    if (server.iframeUrl) {
      destroyHls();
      setPlayerMode('iframe');
      setIframeSrc(server.iframeUrl);
      setError(null);
    } else {
      // Direct stream
      loadStream();
    }
  };

  const navigateToEpisode = (targetUrl: string) => {
    saveCurrentProgress();
    navigate(
      `/player?url=${encodeURIComponent(targetUrl)}&seriUrl=${encodeURIComponent(seriesUrl)}&seriJudul=${encodeURIComponent(seriesTitle)}&gambar=${encodeURIComponent(coverImage)}&uniqueId=${encodeURIComponent(uniqueId)}`
    );
  };

  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-6 space-y-6">
      {/* Back button and Episode Header */}
      <div className="flex items-center justify-between gap-4">
        <button
          onClick={() => navigate(-1)}
          className="flex items-center gap-2 px-3 py-1.5 rounded-xl bg-surface hover:bg-white/10 text-xs font-semibold text-gray-300 hover:text-white border border-white/5 transition-colors"
        >
          <ArrowLeft className="w-4 h-4" />
          <span>Kembali</span>
        </button>

        <div className="text-right">
          <h1 className="text-base md:text-lg font-bold text-white line-clamp-1">{seriesTitle}</h1>
          <p className="text-xs text-accent font-medium">{episodeTitle}</p>
        </div>
      </div>

      {/* Main Video Viewport Container */}
      <div
        ref={containerRef}
        className="relative w-full aspect-video bg-black rounded-2xl overflow-hidden shadow-2xl border border-white/10 flex items-center justify-center group"
      >
        {loading ? (
          <div className="flex flex-col items-center justify-center gap-3">
            <RefreshCw className="w-8 h-8 text-accent animate-spin" />
            <p className="text-xs text-gray-400">Mempersiapkan pemutar video...</p>
          </div>
        ) : error && playerMode === 'none' ? (
          <div className="max-w-md p-6 text-center space-y-4">
            <AlertTriangle className="w-10 h-10 text-amber-400 mx-auto" />
            <p className="text-xs text-gray-300 leading-relaxed">{error}</p>
            {servers.length > 0 && (
              <button
                onClick={() => setServerModalOpen(true)}
                className="inline-flex items-center gap-2 px-4 py-2 rounded-xl bg-accent hover:bg-accent-hover text-white text-xs font-semibold shadow-lg shadow-accent/20 transition-colors"
              >
                <Server className="w-4 h-4" />
                <span>Pilih Server Alternatif</span>
              </button>
            )}
          </div>
        ) : playerMode === 'iframe' ? (
          <div className="relative w-full h-full">
            <iframe
              src={iframeSrc}
              title={episodeTitle}
              allowFullScreen
              className="w-full h-full border-0"
              allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
            />
          </div>
        ) : (
          <>
            <video
              ref={videoRef}
              playsInline
              className="w-full h-full object-contain"
              onTimeUpdate={() => {
                if (videoRef.current) setCurrentTime(videoRef.current.currentTime);
              }}
              onDurationChange={() => {
                if (videoRef.current) setDuration(videoRef.current.duration);
              }}
              onPlay={() => setPlaying(true)}
              onPause={() => {
                setPlaying(false);
                saveCurrentProgress();
              }}
              onEnded={() => {
                setPlaying(false);
                saveCurrentProgress();
                if (navNext) navigateToEpisode(navNext);
              }}
            />

            {/* Custom Overlay Controls */}
            <PlayerControls
              playing={playing}
              currentTime={currentTime}
              duration={duration}
              volume={volume}
              muted={muted}
              isFullscreen={isFullscreen}
              title={`${seriesTitle} — ${episodeTitle}`}
              activeServerName={activeServerName}
              hasPrev={Boolean(navPrev)}
              hasNext={Boolean(navNext)}
              onPlayPause={handlePlayPause}
              onSeek={handleSeek}
              onVolumeChange={handleVolumeChange}
              onToggleMute={handleToggleMute}
              onToggleFullscreen={handleToggleFullscreen}
              onPrev={() => navPrev && navigateToEpisode(navPrev)}
              onNext={() => navNext && navigateToEpisode(navNext)}
              onOpenServerModal={() => setServerModalOpen(true)}
              onBack={() => navigate(-1)}
            />
          </>
        )}
      </div>

      {/* Episode Navigation and Server Switcher Row */}
      <div className="flex flex-wrap items-center justify-between gap-4 p-4 rounded-2xl bg-surface border border-white/5">
        <div className="flex items-center gap-2">
          <button
            onClick={() => setServerModalOpen(true)}
            className="flex items-center gap-2 px-3.5 py-2 rounded-xl bg-card hover:bg-white/10 text-xs font-semibold text-white border border-white/10 transition-colors"
          >
            <Server className="w-4 h-4 text-accent" />
            <span>Server: {activeServerName}</span>
          </button>
        </div>

        <div className="flex items-center gap-2 ml-auto">
          {navPrev && (
            <button
              onClick={() => navigateToEpisode(navPrev)}
              className="px-4 py-2 rounded-xl bg-card hover:bg-white/10 text-xs font-semibold text-gray-300 hover:text-white border border-white/10 transition-colors"
            >
              &larr; Ep Sebelumnya
            </button>
          )}

          {navNext && (
            <button
              onClick={() => navigateToEpisode(navNext)}
              className="px-4 py-2 rounded-xl bg-accent hover:bg-accent-hover text-xs font-semibold text-white shadow-lg shadow-accent/20 transition-colors"
            >
              Ep Selanjutnya &rarr;
            </button>
          )}
        </div>
      </div>

      {/* Server Selection Modal */}
      {serverModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/70 backdrop-blur-sm">
          <div className="relative w-full max-w-md bg-card rounded-2xl p-6 border border-white/10 shadow-2xl">
            <button
              onClick={() => setServerModalOpen(false)}
              className="absolute top-4 right-4 text-gray-400 hover:text-white"
            >
              <X className="w-5 h-5" />
            </button>

            <h3 className="text-base font-bold text-white mb-1">Pilih Server Video</h3>
            <p className="text-xs text-gray-400 mb-4">Ganti server jika video lambat atau gagal diputar</p>

            <div className="space-y-2 max-h-72 overflow-y-auto">
              {/* Native Direct Option */}
              <button
                onClick={() => {
                  setServerModalOpen(false);
                  loadStream();
                }}
                className={`w-full flex items-center justify-between p-3 rounded-xl border text-xs font-semibold transition-colors ${
                  playerMode === 'hls'
                    ? 'bg-accent/15 border-accent text-accent'
                    : 'bg-surface border-white/5 text-gray-300 hover:text-white hover:bg-white/5'
                }`}
              >
                <span>Azure Direct HLS (Rekomendasi)</span>
                <span className="text-[10px] uppercase font-bold text-emerald-400">Direk Cepat</span>
              </button>

              {/* Other servers */}
              {servers.map((s, idx) => (
                <button
                  key={s.post || idx}
                  onClick={() => handleSelectServer(s)}
                  className={`w-full flex items-center justify-between p-3 rounded-xl border text-xs font-semibold transition-colors ${
                    activeServerName === (s.namaHost || s.nama)
                      ? 'bg-accent/15 border-accent text-accent'
                      : 'bg-surface border-white/5 text-gray-300 hover:text-white hover:bg-white/5'
                  }`}
                >
                  <span>{s.namaHost || s.nama}</span>
                  <span className="text-[10px] text-gray-400 uppercase">{s.type || 'Embed'}</span>
                </button>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
