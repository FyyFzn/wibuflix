import { useState, useEffect } from 'react';
import { X, KeyRound, Check } from 'lucide-react';
import { getSyncToken, setSyncToken } from '../services/api';

interface SyncTokenModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export default function SyncTokenModal({ isOpen, onClose }: SyncTokenModalProps) {
  const [token, setToken] = useState('');
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (isOpen) {
      setToken(getSyncToken());
      setSaved(false);
    }
  }, [isOpen]);

  if (!isOpen) return null;

  const handleSave = () => {
    setSyncToken(token);
    setSaved(true);
    setTimeout(() => {
      onClose();
    }, 600);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/70 backdrop-blur-sm">
      <div className="relative w-full max-w-md bg-card rounded-2xl p-6 border border-white/10 shadow-2xl">
        <button
          onClick={onClose}
          className="absolute top-4 right-4 text-gray-400 hover:text-white transition-colors"
          aria-label="Tutup"
        >
          <X className="w-5 h-5" />
        </button>

        <div className="flex items-center gap-3 mb-4">
          <div className="p-2.5 rounded-xl bg-accent/20 text-accent">
            <KeyRound className="w-6 h-6" />
          </div>
          <div>
            <h2 className="text-lg font-bold text-white">Sinkronisasi Cloud</h2>
            <p className="text-xs text-gray-400">Hubungkan riwayat tontonan dengan aplikasi mobile</p>
          </div>
        </div>

        <div className="space-y-4">
          <div>
            <label className="block text-xs font-medium text-gray-300 mb-1.5">
              Sync Token
            </label>
            <input
              type="text"
              value={token}
              onChange={(e) => setToken(e.target.value)}
              placeholder="Masukkan sync token rahasia..."
              className="w-full px-3.5 py-2.5 rounded-xl bg-surface border border-white/10 text-white placeholder-gray-500 text-sm focus:outline-none focus:border-accent transition-colors"
            />
          </div>

          <p className="text-xs text-gray-400 leading-relaxed">
            Masukkan token yang sama dengan yang diatur di aplikasi Android/iOS Anda untuk menyinkronkan progress dan episode terakhir yang ditonton secara otomatis.
          </p>

          <div className="flex gap-2 justify-end pt-2">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 rounded-xl text-sm font-medium text-gray-400 hover:text-white hover:bg-white/5 transition-colors"
            >
              Batal
            </button>
            <button
              type="button"
              onClick={handleSave}
              className="flex items-center gap-2 px-5 py-2 rounded-xl text-sm font-medium bg-accent hover:bg-accent-hover text-white transition-colors shadow-lg shadow-accent/20"
            >
              {saved ? (
                <>
                  <Check className="w-4 h-4" /> Tersimpan
                </>
              ) : (
                'Simpan'
              )}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
