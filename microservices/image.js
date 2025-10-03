const express = require('express');
const OpenAI = require('openai');

const DEFAULT_LIMIT = Number(process.env.IMAGE_GENERATION_LIMIT || 3);
const WINDOW_MS = Number(process.env.IMAGE_GENERATION_WINDOW_MS || 24 * 60 * 60 * 1000);

function startImageService({ port }) {
    if (!process.env.OPENAI_API_KEY) {
        throw new Error('Missing OPENAI_API_KEY for image service.');
    }

    const usage = new Map();
    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    const app = express();
    app.use(express.json({ limit: '500kb' }));

    function pruneUsage(chatId) {
        const entries = usage.get(chatId) || [];
        const now = Date.now();
        const filtered = entries.filter((timestamp) => now - timestamp < WINDOW_MS);
        usage.set(chatId, filtered);
        return filtered;
    }

    app.post('/image', async (req, res) => {
        const { prompt, chatId, size = '512x512' } = req.body || {};

        if (typeof prompt !== 'string' || !prompt.trim()) {
            return res.status(400).json({ error: 'prompt is required.' });
        }

        if (typeof chatId !== 'string' || !chatId.trim()) {
            return res.status(400).json({ error: 'chatId is required.' });
        }

        const trimmedPrompt = prompt.trim();
        const trimmedChatId = chatId.trim();

        const recent = pruneUsage(trimmedChatId);
        if (recent.length >= DEFAULT_LIMIT) {
            const oldest = recent[0];
            const resetInMs = Math.max(WINDOW_MS - (Date.now() - oldest), 0);
            return res.status(429).json({
                error: 'Daily image limit reached.',
                usage: {
                    limit: DEFAULT_LIMIT,
                    remaining: 0,
                    resetInMs
                }
            });
        }

        try {
            const result = await openai.images.generate({
                model: 'gpt-image-1',
                prompt: trimmedPrompt,
                size,
                n: 1,
                response_format: 'b64_json'
            });

            const image = result?.data?.[0]?.b64_json;

            if (!image) {
                return res.status(502).json({ error: 'Image model returned an empty response.' });
            }

            recent.push(Date.now());
            usage.set(trimmedChatId, recent);

            const remaining = Math.max(DEFAULT_LIMIT - recent.length, 0);

            res.json({
                images: [{ base64: image, mimeType: 'image/png' }],
                usage: {
                    limit: DEFAULT_LIMIT,
                    remaining,
                    resetInMs: Math.max(WINDOW_MS - (Date.now() - recent[0]), 0)
                }
            });
        } catch (error) {
            console.error('[ImageService] Unable to generate image:', error);
            res.status(500).json({ error: 'Image service unavailable. Please try again later.' });
        }
    });

    return new Promise((resolve, reject) => {
        const server = app.listen(port, () => {
            console.log(`🖼️  Image service running on port ${port}`);
            resolve({
                name: 'image',
                close: () => new Promise((resolveClose, rejectClose) => {
                    server.close((err) => (err ? rejectClose(err) : resolveClose()));
                })
            });
        });

        server.on('error', reject);
    });
}

module.exports = {
    startImageService
};
