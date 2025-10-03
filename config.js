const path = require('path');

const BOT_NAME = 'Emponyoo';
const COMMAND_PREFIX = '!';

const STOPWORDS = new Set([
    'the', 'and', 'for', 'are', 'but', 'you', 'your', 'with', 'this', 'that', 'have', 'from',
    'what', 'when', 'where', 'who', 'why', 'how', 'which', 'been', 'were', 'will', 'would',
    'could', 'should', 'about', 'there', 'here', 'they', 'them', 'their', 'ours', 'ourselves',
    'him', 'her', 'his', 'hers', 'its', 'our', 'out', 'into', 'onto', 'because', 'been', 'can'
]);

const SENSITIVE_PATTERNS = [
    {
        name: 'payment card number',
        regex: /\b(?:\d[ -]*?){13,19}\b/,
        response: 'For your safety, please avoid sharing payment card numbers here. If you need help, try describing the situation without sensitive details.'
    },
    {
        name: 'national ID',
        regex: /\b\d{3}[- ]?\d{2}[- ]?\d{4}\b/,
        response: 'I spotted something that looks like a personal identification number. Please keep that private and share only non-sensitive information.'
    }
];

const config = {
    BOT_NAME,
    COMMAND_PREFIX,
    STOPWORDS,
    SENSITIVE_PATTERNS,
    SYSTEM_PROMPT: `You are ${BOT_NAME}, a warm, professional, and safety-conscious WhatsApp assistant.\n- Always introduce yourself as ${BOT_NAME} when asked who you are.\n- Keep answers short and conversational (2-4 sentences unless the user explicitly asks for more).\n- If you are unsure about something, be honest and offer to help look it up.\n- Never provide harmful, harassing, or disallowed content. Decline requests for personal, medical, legal, or financial advice and instead offer general guidance.`,
    TYPING_DELAY_MS: 1500,
    RATE_LIMIT_MS: 2500,
    MAX_MESSAGE_LENGTH: 1200,
    CONTEXT_LIMIT: 12,
    MAX_SAVED_HISTORY: 50,
    MAX_SAVED_RESPONSES: 100,
    MAX_SAVED_QUICK_REPLIES: 100,
    SAFE_FAILURE_MESSAGE: "I'm sorry, but I can't help with that.",
    PRIVACY_SUMMARY: `${BOT_NAME} stores a limited rolling history per chat to stay helpful. You can clear it any time with ${COMMAND_PREFIX}reset.`,
    MEMORY_FILE: path.join(__dirname, 'memory.json'),
    RESPONSES_FILE: path.join(__dirname, 'all_responses.json'),
    PUPPETEER_OPTIONS: { headless: false }
};

module.exports = config;
