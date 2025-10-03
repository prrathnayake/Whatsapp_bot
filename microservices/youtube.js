const express = require('express');
const ytSearch = require('yt-search');

function startYouTubeService({ port }) {
    const app = express();
    app.use(express.json({ limit: '250kb' }));

    async function performSearch(query) {
        const results = await ytSearch(query);
        const firstVideo = Array.isArray(results?.videos) ? results.videos[0] : null;

        if (!firstVideo) {
            return null;
        }

        return {
            title: firstVideo.title,
            url: firstVideo.url,
            author: firstVideo.author?.name || firstVideo.author,
            description: firstVideo.description || ''
        };
    }

    app.get('/search', async (req, res) => {
        const query = (req.query.q || req.query.query || '').trim();
        if (!query) {
            return res.status(400).json({ error: 'query parameter is required.' });
        }

        try {
            const result = await performSearch(query);
            if (!result) {
                return res.status(404).json({ error: 'No results found.' });
            }

            res.json(result);
        } catch (error) {
            console.error('[YouTubeService] Search failed:', error);
            res.status(500).json({ error: 'YouTube lookup failed. Please try again later.' });
        }
    });

    app.post('/search', async (req, res) => {
        const { query } = req.body || {};
        if (typeof query !== 'string' || !query.trim()) {
            return res.status(400).json({ error: 'query is required.' });
        }

        try {
            const result = await performSearch(query.trim());
            if (!result) {
                return res.status(404).json({ error: 'No results found.' });
            }

            res.json(result);
        } catch (error) {
            console.error('[YouTubeService] Search failed:', error);
            res.status(500).json({ error: 'YouTube lookup failed. Please try again later.' });
        }
    });

    return new Promise((resolve, reject) => {
        const server = app.listen(port, () => {
            console.log(`🎵 YouTube service running on port ${port}`);
            resolve({
                name: 'youtube',
                close: () => new Promise((resolveClose, rejectClose) => {
                    server.close((err) => (err ? rejectClose(err) : resolveClose()));
                })
            });
        });

        server.on('error', reject);
    });
}

module.exports = {
    startYouTubeService
};
