const express = require('express');
const OpenAI = require('openai');

const MAX_RETRIES = Number(process.env.MODERATION_MAX_RETRIES || 2);
const BASE_RETRY_DELAY_MS = Number(process.env.MODERATION_RETRY_DELAY_MS || 250);

async function withRetry(fn, { maxRetries = MAX_RETRIES, baseDelay = BASE_RETRY_DELAY_MS } = {}) {
    let attempt = 0;

    while (true) {
        try {
            return await fn();
        } catch (error) {
            const status = error?.status ?? error?.response?.status;
            const isRetryable = [408, 409, 429, 500, 502, 503, 504].includes(status);

            if (attempt >= maxRetries || !isRetryable) {
                throw error;
            }

            const retryAfterHeader = error?.headers?.get?.('retry-after');
            const retryAfterMs = retryAfterHeader ? Number(retryAfterHeader) * 1000 : null;
            const delayMs = retryAfterMs && !Number.isNaN(retryAfterMs)
                ? retryAfterMs
                : baseDelay * Math.pow(2, attempt);

            await new Promise((resolve) => setTimeout(resolve, delayMs));
            attempt += 1;
        }
    }
}

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
            const result = await withRetry(
                () => openai.moderations.create({
                    model: 'omni-moderation-latest',
                    input
                })
            );

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
            const status = error?.status ?? error?.response?.status ?? 500;
            const message = error?.error?.message || error?.message || 'Moderation service unavailable. Please try again later.';

            console.error('[ModerationService] Unable to process moderation request:', error);

            res.status(status === 429 ? 429 : 500).json({
                error: status === 429
                    ? 'Moderation service is rate limited. Please retry after a short delay.'
                    : 'Moderation service unavailable. Please try again later.',
                details: status === 429 ? message : undefined
            });
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
