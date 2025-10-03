const express = require('express');
const OpenAI = require('openai');

function startModerationService({ port }) {
    if (!process.env.OPENAI_API_KEY) {
        throw new Error('Missing OPENAI_API_KEY for moderation service.');
    }

    const app = express();
    app.use(express.json({ limit: '500kb' }));

    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

    app.post('/moderate', async (req, res) => {
        const { input, type = 'input' } = req.body || {};

        if (typeof input !== 'string' || !input.trim()) {
            return res.status(400).json({ error: 'input text is required.' });
        }

        try {
            const result = await openai.moderations.create({
                model: 'omni-moderation-latest',
                input
            });

            const flagged = result?.results?.[0]?.flagged ?? false;
            const categories = Object.entries(result?.results?.[0]?.categories || {})
                .filter(([, value]) => Boolean(value))
                .map(([key]) => key.replace(/_/g, ' '));

            res.json({
                flagged,
                categories,
                type
            });
        } catch (error) {
            console.error('[ModerationService] Unable to process moderation request:', error);
            res.status(500).json({ error: 'Moderation service unavailable. Please try again later.' });
        }
    });

    return new Promise((resolve, reject) => {
        const server = app.listen(port, () => {
            console.log(`🛡️  Moderation service running on port ${port}`);
            resolve({
                name: 'moderation',
                close: () => new Promise((resolveClose, rejectClose) => {
                    server.close((err) => (err ? rejectClose(err) : resolveClose()));
                })
            });
        });

        server.on('error', reject);
    });
}

module.exports = {
    startModerationService
};
