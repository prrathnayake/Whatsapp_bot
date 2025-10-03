const express = require('express');
const OpenAI = require('openai');

function startChatService({ port }) {
    if (!process.env.OPENAI_API_KEY) {
        throw new Error('Missing OPENAI_API_KEY for chat service.');
    }

    const app = express();
    app.use(express.json({ limit: '1mb' }));

    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

    app.post('/chat', async (req, res) => {
        const { messages, temperature = 0.7, model = 'gpt-4o-mini' } = req.body || {};

        if (!Array.isArray(messages) || messages.length === 0) {
            return res.status(400).json({ error: 'messages array is required.' });
        }

        try {
            const response = await openai.chat.completions.create({
                model,
                messages,
                temperature
            });

            const reply = response?.choices?.[0]?.message?.content?.trim();

            if (!reply) {
                return res.status(502).json({ error: 'Chat model returned an empty response.' });
            }

            res.json({ reply });
        } catch (error) {
            console.error('[ChatService] Unable to complete chat request:', error);
            res.status(500).json({ error: 'Chat service unavailable. Please try again later.' });
        }
    });

    return new Promise((resolve, reject) => {
        const server = app.listen(port, () => {
            console.log(`🚀 Chat service running on port ${port}`);
            resolve({
                name: 'chat',
                close: () => new Promise((resolveClose, rejectClose) => {
                    server.close((err) => (err ? rejectClose(err) : resolveClose()));
                })
            });
        });

        server.on('error', reject);
    });
}

module.exports = {
    startChatService
};
