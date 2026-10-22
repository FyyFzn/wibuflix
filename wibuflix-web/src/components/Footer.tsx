import { Link } from 'react-router-dom';
import { Heart } from 'lucide-react';

export default function Footer() {
  return (
    <footer className="w-full border-t border-white/5 bg-surface/50 mt-16 py-8">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 text-center text-sm text-gray-400 space-y-4">
        <div className="flex items-center justify-center gap-2">
          <span className="font-bold text-white tracking-wide">WIBU<span className="text-accent">FLIX</span></span>
          <span>— Nonton Anime Subtitle Indonesia</span>
        </div>
        <p className="max-w-2xl mx-auto text-xs text-gray-500 leading-relaxed">
          Wibuflix tidak menyimpan berkas video apa pun di server kami. Semua konten disediakan oleh pihak ketiga yang tidak berafiliasi.
        </p>
        <div className="flex justify-center gap-6 text-xs text-gray-400">
          <Link to="/" className="hover:text-white transition-colors">Beranda</Link>
          <Link to="/katalog" className="hover:text-white transition-colors">Katalog</Link>
          <Link to="/history" className="hover:text-white transition-colors">Riwayat</Link>
          <Link to="/queue" className="hover:text-white transition-colors">Antrean Transcoding</Link>
        </div>
        <div className="flex items-center justify-center gap-1 text-xs text-gray-500 pt-2">
          <span>Dibuat dengan</span>
          <Heart className="w-3.5 h-3.5 text-accent fill-accent" />
          <span>untuk komunitas wibu</span>
        </div>
      </div>
    </footer>
  );
}
