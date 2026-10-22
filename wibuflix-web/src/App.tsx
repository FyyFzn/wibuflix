import { useState } from 'react';
import { BrowserRouter, Routes, Route } from 'react-router-dom';
import Navbar from './components/Navbar';
import Footer from './components/Footer';
import SyncTokenModal from './components/SyncTokenModal';

// Temporary page placeholders for Phase 2; will be replaced in Phases 3 & 4
function HomePlaceholder() {
  return (
    <div className="max-w-7xl mx-auto px-4 py-8">
      <h1 className="text-2xl font-bold">Beranda</h1>
    </div>
  );
}

function KatalogPlaceholder() {
  return (
    <div className="max-w-7xl mx-auto px-4 py-8">
      <h1 className="text-2xl font-bold">Katalog</h1>
    </div>
  );
}

function HistoryPlaceholder() {
  return (
    <div className="max-w-7xl mx-auto px-4 py-8">
      <h1 className="text-2xl font-bold">Riwayat</h1>
    </div>
  );
}

function QueuePlaceholder() {
  return (
    <div className="max-w-7xl mx-auto px-4 py-8">
      <h1 className="text-2xl font-bold">Antrean</h1>
    </div>
  );
}

function DetailPlaceholder() {
  return (
    <div className="max-w-7xl mx-auto px-4 py-8">
      <h1 className="text-2xl font-bold">Detail</h1>
    </div>
  );
}

function PlayerPlaceholder() {
  return (
    <div className="max-w-7xl mx-auto px-4 py-8">
      <h1 className="text-2xl font-bold">Player</h1>
    </div>
  );
}

export default function App() {
  const [syncModalOpen, setSyncModalOpen] = useState(false);

  return (
    <BrowserRouter>
      <div className="min-h-screen flex flex-col bg-background text-white selection:bg-accent selection:text-white">
        <Navbar onOpenSyncModal={() => setSyncModalOpen(true)} />

        <main className="flex-1">
          <Routes>
            <Route path="/" element={<HomePlaceholder />} />
            <Route path="/katalog" element={<KatalogPlaceholder />} />
            <Route path="/history" element={<HistoryPlaceholder />} />
            <Route path="/queue" element={<QueuePlaceholder />} />
            <Route path="/detail/:id" element={<DetailPlaceholder />} />
            <Route path="/player" element={<PlayerPlaceholder />} />
            <Route path="*" element={<HomePlaceholder />} />
          </Routes>
        </main>

        <Footer />

        <SyncTokenModal
          isOpen={syncModalOpen}
          onClose={() => setSyncModalOpen(false)}
        />
      </div>
    </BrowserRouter>
  );
}
