import WatchHistory from '../models/WatchHistory.js';

/**
 * Get saved watch history items sorted by waktu descending.
 */
export async function getHistory(req, res) {
    try {
        const data = await WatchHistory.find().sort({ waktu: -1 }).limit(100).lean();
        return res.json({ status: 'success', data });
    } catch (err) {
        return res.status(500).json({ status: 'error', message: err.message });
    }
}

/**
 * Upsert a watch history entry by episode URL or series URL.
 */
export async function upsertHistory(req, res) {
    try {
        const {
            judulSeri,
            nomorEp,
            url,
            seriUrl,
            gambar,
            progress,
            duration,
            host,
            uniqueId,
            waktu
        } = req.body;

        if (!url && !seriUrl && !judulSeri) {
            return res.status(400).json({ status: 'error', message: 'Missing url, seriUrl, or judulSeri' });
        }

        let filter;
        if (url && seriUrl) {
            filter = { $or: [{ url }, { seriUrl }] };
        } else if (url) {
            filter = { url };
        } else if (seriUrl) {
            filter = { seriUrl };
        } else {
            filter = { judulSeri };
        }

        const updateDoc = {
            $set: {
                judulSeri: judulSeri || '',
                nomorEp: nomorEp || '',
                url: url || '',
                seriUrl: seriUrl || '',
                gambar: gambar || '',
                progress: Number(progress) || 0,
                duration: Number(duration) || 0,
                host: host || '',
                uniqueId: uniqueId || '',
                waktu: waktu ? Number(waktu) : Date.now()
            }
        };

        const item = await WatchHistory.findOneAndUpdate(filter, updateDoc, {
            upsert: true,
            new: true,
            setDefaultsOnInsert: true
        });

        return res.json({ status: 'success', data: item });
    } catch (err) {
        return res.status(500).json({ status: 'error', message: err.message });
    }
}

/**
 * Delete a specific watch history item by identifier (url, seriUrl, or judulSeri).
 */
export async function deleteHistoryItem(req, res) {
    try {
        const { identifier } = req.params;
        if (!identifier) {
            return res.status(400).json({ status: 'error', message: 'Identifier is required' });
        }
        const decoded = decodeURIComponent(identifier);
        const result = await WatchHistory.deleteMany({
            $or: [
                { url: decoded },
                { seriUrl: decoded },
                { judulSeri: decoded },
                { url: identifier },
                { seriUrl: identifier },
                { judulSeri: identifier }
            ]
        });

        return res.json({ status: 'success', deletedCount: result.deletedCount });
    } catch (err) {
        return res.status(500).json({ status: 'error', message: err.message });
    }
}

/**
 * Clear all watch history items.
 */
export async function clearHistory(req, res) {
    try {
        const result = await WatchHistory.deleteMany({});
        return res.json({ status: 'success', deletedCount: result.deletedCount, message: 'All history cleared' });
    } catch (err) {
        return res.status(500).json({ status: 'error', message: err.message });
    }
}
