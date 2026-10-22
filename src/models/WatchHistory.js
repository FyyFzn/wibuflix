import mongoose from 'mongoose';

const WatchHistorySchema = new mongoose.Schema({
    judulSeri: { type: String, required: true },
    nomorEp: { type: String, default: '' },
    url: { type: String, required: true, index: true },
    seriUrl: { type: String, index: true },
    gambar: { type: String, default: '' },
    waktu: { type: Number, default: () => Date.now(), index: true },
    progress: { type: Number, default: 0 },
    duration: { type: Number, default: 0 },
    host: { type: String, default: '' },
    uniqueId: { type: String, default: '' }
}, { timestamps: true });

export default mongoose.model('WatchHistory', WatchHistorySchema);
