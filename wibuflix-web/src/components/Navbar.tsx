import { useState } from 'react';
import { NavLink, Link } from 'react-router-dom';
import { PlaySquare, Flame, Clock, Layers, Cloud, Menu, X } from 'lucide-react';

interface NavbarProps {
  onOpenSyncModal: () => void;
}

export default function Navbar({ onOpenSyncModal }: NavbarProps) {
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

  const navLinks = [
    { to: '/', label: 'Beranda', icon: Flame },
    { to: '/katalog', label: 'Katalog', icon: PlaySquare },
    { to: '/history', label: 'Riwayat', icon: Clock },
    { to: '/queue', label: 'Antrean', icon: Layers },
  ];

  return (
    <header className="sticky top-0 z-40 w-full bg-background/80 backdrop-blur-md border-b border-white/5">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 h-16 flex items-center justify-between">
        {/* Brand Logo */}
        <Link to="/" className="flex items-center gap-2 group">
          <div className="w-9 h-9 rounded-xl bg-gradient-to-tr from-accent to-orange-400 flex items-center justify-center shadow-lg shadow-accent/25 group-hover:scale-105 transition-transform">
            <span className="font-black text-white text-lg tracking-wider">W</span>
          </div>
          <span className="text-xl font-extrabold tracking-tight text-white group-hover:text-accent transition-colors">
            WIBU<span className="text-accent">FLIX</span>
          </span>
        </Link>

        {/* Desktop Nav Items */}
        <nav className="hidden md:flex items-center gap-1">
          {navLinks.map(({ to, label, icon: Icon }) => (
            <NavLink
              key={to}
              to={to}
              className={({ isActive }) =>
                `flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-medium transition-all ${
                  isActive
                    ? 'bg-accent/15 text-accent font-semibold shadow-inner'
                    : 'text-gray-300 hover:text-white hover:bg-white/5'
                }`
              }
            >
              <Icon className="w-4 h-4" />
              <span>{label}</span>
            </NavLink>
          ))}
        </nav>

        {/* Desktop Right Actions */}
        <div className="hidden md:flex items-center gap-3">
          <button
            onClick={onOpenSyncModal}
            className="flex items-center gap-2 px-3.5 py-1.5 rounded-xl text-xs font-medium bg-surface hover:bg-white/10 text-gray-200 border border-white/10 hover:border-accent/40 transition-all shadow-sm"
            title="Kelola Token Sinkronisasi"
          >
            <Cloud className="w-4 h-4 text-accent" />
            <span>Sync Cloud</span>
          </button>
        </div>

        {/* Mobile Hamburger Button */}
        <div className="flex md:hidden items-center gap-2">
          <button
            onClick={onOpenSyncModal}
            className="p-2 rounded-xl text-gray-300 hover:text-white bg-surface border border-white/10"
            title="Sync Cloud"
          >
            <Cloud className="w-5 h-5 text-accent" />
          </button>
          <button
            onClick={() => setMobileMenuOpen(!mobileMenuOpen)}
            className="p-2 rounded-xl text-gray-300 hover:text-white bg-surface border border-white/10"
            aria-label="Toggle Menu"
          >
            {mobileMenuOpen ? <X className="w-6 h-6" /> : <Menu className="w-6 h-6" />}
          </button>
        </div>
      </div>

      {/* Mobile Nav Drawer */}
      {mobileMenuOpen && (
        <div className="md:hidden border-b border-white/5 bg-background/95 px-4 pt-2 pb-4 space-y-1">
          {navLinks.map(({ to, label, icon: Icon }) => (
            <NavLink
              key={to}
              to={to}
              onClick={() => setMobileMenuOpen(false)}
              className={({ isActive }) =>
                `flex items-center gap-3 px-4 py-2.5 rounded-xl text-sm font-medium transition-colors ${
                  isActive
                    ? 'bg-accent/15 text-accent font-semibold'
                    : 'text-gray-300 hover:text-white hover:bg-white/5'
                }`
              }
            >
              <Icon className="w-5 h-5" />
              <span>{label}</span>
            </NavLink>
          ))}
        </div>
      )}
    </header>
  );
}
