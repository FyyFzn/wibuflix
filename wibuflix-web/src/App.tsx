import { useState } from 'react';
import { BrowserRouter, Routes, Route } from 'react-router-dom';
import Navbar from './components/Navbar';
import Footer from './components/Footer';
import SyncTokenModal from './components/SyncTokenModal';
import HomePage from './pages/HomePage';
import KatalogPage from './pages/KatalogPage';
import QueuePage from './pages/QueuePage';
import DetailPage from './pages/DetailPage';
import PlayerPage from './pages/PlayerPage';

// Temporary page placeholder for Phase 4; will be replaced in Step 6
function HistoryPlaceholder() {
  return (
    <div className="max-w-7xl mx-auto px-4 py-8">
      <h1 className="text-2xl font-bold">Riwayat</h1>
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
            <Route path="/" element={<HomePage />} />
            <Route path="/katalog" element={<KatalogPage />} />
            <Route path="/history" element={<HistoryPlaceholder />} />
            <Route path="/queue" element={<QueuePage />} />
            <Route path="/detail/:id" element={<DetailPage />} />
            <Route path="/player" element={<PlayerPage />} />
            <Route path="*" element={<HomePage />} />
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
