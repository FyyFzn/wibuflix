import mongoose from 'mongoose';

const TMDBCacheSchema = new mongoose.Schema({
    key: { type: String, required: true, unique: true, index: true },
    data: { type: mongoose.Schema.Types.Mixed, required: true },
    createdAt: { type: Date, default: Date.now, expires: 86400 } // TTL 24 jam (86400 detik)
});

export default mongoose.model('TMDBCache', TMDBCacheSchema);
