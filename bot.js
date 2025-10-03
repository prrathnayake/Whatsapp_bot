require('dotenv').config();
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const OpenAI = require('openai');
const fs = require('fs');
const path = require('path');

if (!process.env.OPENAI_API_KEY) {
    throw new Error('Missing OPENAI_API_KEY environment variable. Please configure your .env file.');
}

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// ---------------- CONFIG ----------------
const BOT_NAME = 'Emponyoo';
const TYPING_DELAY_MS = 1500;
const MEMORY_FILE = path.join(__dirname, 'memory.json');
const RESPONSES_FILE = path.join(__dirname, 'all_responses.json');
const CONTEXT_LIMIT = 12; // number of messages (user + assistant) kept in the rolling context
const MAX_SAVED_HISTORY = 50; // hard cap of messages saved per chat
const MAX_SAVED_RESPONSES = 100;
const MAX_SAVED_QUICK_REPLIES = 100; // number of quick replies remembered per chat
const COMMAND_PREFIX = '!';

const STOPWORDS = new Set([
    'the', 'and', 'for', 'are', 'but', 'you', 'your', 'with', 'this', 'that', 'have', 'from',
    'what', 'when', 'where', 'who', 'why', 'how', 'which', 'been', 'were', 'will', 'would',
    'could', 'should', 'about', 'there', 'here', 'they', 'them', 'their', 'ours', 'ourselves',
    'him', 'her', 'his', 'hers', 'its', 'our', 'out', 'into', 'onto', 'because', 'been', 'can'
]);

const SYSTEM_PROMPT = `You are ${BOT_NAME}, a warm, professional, and safety-conscious WhatsApp assistant.
- Always introduce yourself as ${BOT_NAME} when asked who you are.
- Keep answers short and conversational (2-4 sentences unless the user explicitly asks for more).
- If you are unsure about something, be honest and offer to help look it up.
- Never provide harmful, harassing, or disallowed content. Decline requests for personal, medical, legal, or financial advice and instead offer general guidance.`;

const RATE_LIMIT_MS = 2500; // minimum delay between replies per chat
const MAX_MESSAGE_LENGTH = 1200; // guard against overly long inputs
const SENSITIVE_PATTERNS = [
    {
        name: 'payment card number',
        regex: /\b(?:\d[ -]*?){13,19}\b/, // simplistic credit card detector
        response: 'For your safety, please avoid sharing payment card numbers here. If you need help, try describing the situation without sensitive details.'
    },
    {
        name: 'national ID',
        regex: /\b\d{3}[- ]?\d{2}[- ]?\d{4}\b/, // SSN-like
        response: 'I spotted something that looks like a personal identification number. Please keep that private and share only non-sensitive information.'
    }
];

const SAFE_FAILURE_MESSAGE = "I'm sorry, but I can't help with that.";
const PRIVACY_SUMMARY = `${BOT_NAME} stores a limited rolling history per chat to stay helpful. You can clear it any time with ${COMMAND_PREFIX}reset.`;

const chatCooldowns = new Map();
// ----------------------------------------

const client = new Client({
    authStrategy: new LocalAuth(),
    puppeteer: { headless: false }
});

// ---------------- MEMORY ----------------
function readJsonFile(filePath, fallback) {
    try {
        if (!fs.existsSync(filePath)) return fallback;
        const raw = fs.readFileSync(filePath, 'utf8');
        return raw ? JSON.parse(raw) : fallback;
    } catch (error) {
        console.warn(`⚠️ Unable to read ${filePath}. Using fallback.`, error);
        return fallback;
    }
}

async function moderateContent(text, type = 'input') {
    if (!text) return { flagged: false, categories: [], type };

    try {
        const result = await openai.moderations.create({
            model: 'omni-moderation-latest',
            input: text
        });

        const flagged = result?.results?.[0]?.flagged ?? false;
        const categories = Object.entries(result?.results?.[0]?.categories || {})
            .filter(([, value]) => Boolean(value))
            .map(([key]) => key.replace(/_/g, ' '));

        return {
            flagged,
            categories,
            type
        };
    } catch (error) {
        console.warn('⚠️ Moderation request failed:', error);
        return { flagged: false, categories: [], type };
    }
}

function checkSensitivePatterns(text) {
    if (!text) return null;

    for (const pattern of SENSITIVE_PATTERNS) {
        if (pattern.regex.test(text)) {
            return pattern.response;
        }
    }

    return null;
}

function isRateLimited(chatId) {
    const last = chatCooldowns.get(chatId) || 0;
    if (Date.now() - last < RATE_LIMIT_MS) {
        return true;
    }

    chatCooldowns.set(chatId, Date.now());
    return false;
}

const FALLBACK_MEMORY = {
    chats: {},
    predefinedResponses: []
};

let memory = normaliseMemory(readJsonFile(MEMORY_FILE, FALLBACK_MEMORY));
let allResponses = readJsonFile(RESPONSES_FILE, {});

allResponses = Object.fromEntries(
    Object.entries(allResponses || {}).map(([chatId, history]) => [
        chatId,
        Array.isArray(history) ? history.slice(-MAX_SAVED_RESPONSES) : []
    ])
);

function normaliseHistory(history) {
    if (!Array.isArray(history)) {
        return [];
    }

    // Legacy support: previous versions stored plain strings alternating between user & bot.
    return history
        .map((entry, index) => {
            if (typeof entry === 'string') {
                return {
                    role: index % 2 === 0 ? 'user' : 'assistant',
                    content: entry
                };
            }

            if (entry && typeof entry === 'object' && entry.content && entry.role) {
                return { role: entry.role, content: entry.content };
            }

            return null;
        })
        .filter(Boolean)
        .slice(-MAX_SAVED_HISTORY);
}

function normaliseQuickReplies(entries) {
    if (!Array.isArray(entries)) return [];

    return entries
        .map((entry) => {
            if (!entry || typeof entry !== 'object') return null;

            const { userMessage, reply, timestamp } = entry;
            if (!userMessage || !reply) return null;

            return {
                userMessage,
                reply,
                timestamp: timestamp || new Date().toISOString()
            };
        })
        .filter(Boolean)
        .slice(-MAX_SAVED_QUICK_REPLIES);
}

function normaliseChatState(chatState) {
    if (!chatState) {
        return {
            history: [],
            quickReplies: []
        };
    }

    if (Array.isArray(chatState)) {
        return {
            history: normaliseHistory(chatState),
            quickReplies: []
        };
    }

    if (typeof chatState === 'object') {
        return {
            history: normaliseHistory(chatState.history),
            quickReplies: normaliseQuickReplies(chatState.quickReplies)
        };
    }

    return {
        history: [],
        quickReplies: []
    };
}

function normalisePredefinedEntry(entry) {
    if (!entry || typeof entry !== 'object') return null;

    const response = typeof entry.response === 'string' ? entry.response.trim() : '';
    if (!response) return null;

    let keywords = entry.keywords ?? entry.triggers ?? entry.patterns ?? entry.match ?? entry.phrases;

    const caseSensitive = Boolean(entry.caseSensitive);

    if (typeof keywords === 'string') {
        keywords = [keywords];
    }

    if (!Array.isArray(keywords)) return null;

    const normalisedKeywords = keywords
        .map((keyword) => {
            if (typeof keyword !== 'string') return null;
            const trimmed = keyword.trim();
            if (!trimmed) return null;
            return caseSensitive ? trimmed : trimmed.toLowerCase();
        })
        .filter(Boolean);

    if (normalisedKeywords.length === 0) return null;

    return {
        keywords: normalisedKeywords,
        response,
        caseSensitive
    };
}

function normaliseMemory(rawMemory) {
    if (!rawMemory || typeof rawMemory !== 'object' || Array.isArray(rawMemory)) {
        return {
            chats: {},
            predefinedResponses: []
        };
    }

    const result = {
        chats: {},
        predefinedResponses: []
    };

    const predefinedRaw = Array.isArray(rawMemory.predefinedResponses)
        ? rawMemory.predefinedResponses
        : [];

    result.predefinedResponses = predefinedRaw
        .map(normalisePredefinedEntry)
        .filter(Boolean);

    let chatsSource = null;

    if (rawMemory.chats && typeof rawMemory.chats === 'object' && !Array.isArray(rawMemory.chats)) {
        chatsSource = rawMemory.chats;
    } else {
        chatsSource = { ...rawMemory };
        delete chatsSource.predefinedResponses;
        delete chatsSource.chats;
    }

    for (const [chatId, chatState] of Object.entries(chatsSource || {})) {
        if (!chatId) continue;
        result.chats[chatId] = normaliseChatState(chatState);
    }

    return result;
}

function getChatState(chatId) {
    if (!memory.chats[chatId]) {
        memory.chats[chatId] = {
            history: [],
            quickReplies: []
        };
    } else {
        memory.chats[chatId] = normaliseChatState(memory.chats[chatId]);
    }

    return memory.chats[chatId];
}

// Save memory & responses
function saveMemory() {
    fs.writeFileSync(MEMORY_FILE, JSON.stringify(memory, null, 2));
}

function saveAllResponses() {
    fs.writeFileSync(RESPONSES_FILE, JSON.stringify(allResponses, null, 2));
}

function appendToHistory(chatId, entry) {
    const chatState = getChatState(chatId);
    chatState.history.push(entry);

    if (chatState.history.length > MAX_SAVED_HISTORY) {
        chatState.history = chatState.history.slice(-MAX_SAVED_HISTORY);
    }

    saveMemory();
}

function storeQuickReply(chatId, userMessage, reply) {
    const chatState = getChatState(chatId);

    chatState.quickReplies.push({
        userMessage,
        reply,
        timestamp: new Date().toISOString()
    });

    if (chatState.quickReplies.length > MAX_SAVED_QUICK_REPLIES) {
        chatState.quickReplies = chatState.quickReplies.slice(-MAX_SAVED_QUICK_REPLIES);
    }

    saveMemory();
}

function appendResponse(chatId, record) {
    if (!allResponses[chatId]) {
        allResponses[chatId] = [];
    }

    allResponses[chatId].push(record);

    if (allResponses[chatId].length > MAX_SAVED_RESPONSES) {
        allResponses[chatId] = allResponses[chatId].slice(-MAX_SAVED_RESPONSES);
    }

    saveAllResponses();
}

function recordInteraction(chatId, userMessage, reply, source = 'system') {
    if (userMessage) {
        appendToHistory(chatId, { role: 'user', content: userMessage });
    }

    if (reply) {
        appendToHistory(chatId, { role: 'assistant', content: reply });
    }

    appendResponse(chatId, {
        message: userMessage,
        reply,
        timestamp: new Date().toISOString(),
        source
    });
}

async function sendWithTyping(message, text) {
    await new Promise((resolve) => setTimeout(resolve, TYPING_DELAY_MS));
    await message.reply(text);
}

function extractKeywords(text) {
    return text
        .toLowerCase()
        .replace(/["'`,.!?;:()\[\]{}<>@#%^&*_+=/\\|-]+/g, ' ')
        .split(/\s+/)
        .filter((word) => word.length > 2 && !STOPWORDS.has(word));
}

function findMemoryAnswer(chatId, message) {
    const chatState = getChatState(chatId);

    const keywords = extractKeywords(message);
    if (keywords.length === 0) return null;

    const keywordSet = new Set(keywords);

    let bestMatch = null;
    let bestScore = 0;

    for (const entry of chatState.history) {
        if (!entry || entry.role !== 'user') continue;

        const entryKeywords = extractKeywords(entry.content);
        if (entryKeywords.length === 0) continue;

        let overlap = 0;
        for (const word of entryKeywords) {
            if (keywordSet.has(word)) overlap += 1;
        }

        if (overlap === 0) continue;

        const score = overlap / keywordSet.size;

        if (score > bestScore) {
            bestScore = score;
            bestMatch = entry;
        }
    }

    if (!bestMatch) return null;

    // Require a decent overlap for short prompts, looser for longer queries
    if (keywords.length <= 2 && bestScore < 0.6) return null;
    if (keywords.length > 2 && bestScore < 0.34) return null;

    return `Earlier you mentioned: "${bestMatch.content}"`;
}

// ---------------- PREDEFINED REPLIES ----------------
function getPredefinedReply(text) {
    if (!text) return null;

    const predefinedEntries = memory.predefinedResponses || [];
    if (predefinedEntries.length === 0) return null;

    const lowerCased = text.toLowerCase();

    for (const entry of predefinedEntries) {
        if (!entry) continue;

        const keywords = Array.isArray(entry.keywords) ? entry.keywords : [];
        if (keywords.length === 0) continue;

        const response = entry.response;
        if (!response) continue;

        const caseSensitive = Boolean(entry.caseSensitive);

        const matchFound = keywords.some((keyword) => {
            if (typeof keyword !== 'string' || keyword.trim().length === 0) return false;

            if (caseSensitive) {
                return text.includes(keyword);
            }

            return lowerCased.includes(keyword.toLowerCase());
        });

        if (matchFound) {
            return response;
        }
    }

    return null;
}

// ---------------- AI REPLY ----------------
async function getAIReply(chatId, message) {
    const chatState = getChatState(chatId);

    // Include last N messages for context
    const contextMessages = chatState.history
        .slice(-CONTEXT_LIMIT)
        .map((entry) => ({ role: entry.role, content: entry.content }));

    contextMessages.unshift({ role: 'system', content: SYSTEM_PROMPT });
    contextMessages.push({ role: 'user', content: message });

    try {
        const response = await openai.chat.completions.create({
            model: 'gpt-4o-mini',
            messages: contextMessages,
            temperature: 0.7
        });

        const reply = response.choices?.[0]?.message?.content?.trim();

        if (!reply) {
            throw new Error('Empty response from OpenAI');
        }

        return reply;
    } catch (error) {
        console.error('OpenAI error:', error);
        return "⚠️ Sorry, I couldn't process that.";
    }
}

// ---------------- COMMANDS ----------------
function buildHelpMessage() {
    return [
        `Here\'s what I can do:`,
        `${COMMAND_PREFIX}help - Show this help message`,
        `${COMMAND_PREFIX}reset - Clear our conversation history for this chat`,
        `${COMMAND_PREFIX}history - Summarise the latest conversation context`,
        `${COMMAND_PREFIX}quickreplies - Review the quick replies I\'ve used here`,
        `${COMMAND_PREFIX}policy - Read how I keep conversations safe`,
        `${COMMAND_PREFIX}privacy - Understand what I store`,
        `${COMMAND_PREFIX}stats - See usage insights for this chat`,
        `${COMMAND_PREFIX}about - Learn more about ${BOT_NAME}`
    ].join('\n');
}

function formatHistorySummary(chatId) {
    const chatState = getChatState(chatId);
    const lastEntries = chatState.history.slice(-6);

    if (lastEntries.length === 0) {
        return 'There\'s no saved conversation history yet.';
    }

    const lines = lastEntries.map((entry) => {
        const prefix = entry.role === 'assistant' ? `${BOT_NAME}:` : 'You:';
        return `${prefix} ${entry.content}`;
    });

    return `Here\'s the latest context I\'m using:\n${lines.join('\n')}`;
}

function buildPolicyMessage() {
    return [
        `${BOT_NAME} follows clear safety rules:`,
        '• I use OpenAI moderation to screen sensitive or unsafe requests.',
        '• I may refuse or redirect conversations that involve harmful, personal, or adult content.',
        '• Please avoid sharing private information such as passwords, credit card numbers, or IDs.'
    ].join('\n');
}

function buildPrivacyMessage() {
    return [
        PRIVACY_SUMMARY,
        'I never store attachments, media, or metadata—only short snippets of text needed for context.',
        `Use ${COMMAND_PREFIX}reset at any time if you want me to forget our conversation.`
    ].join('\n');
}

function buildStatsMessage(chatId) {
    const responses = allResponses[chatId] || [];
    const chatState = getChatState(chatId);
    const total = responses.length;
    const openAIResponses = responses.filter((entry) => entry.source === 'openai').length;
    const memoryResponses = responses.filter((entry) => entry.source === 'memory').length;
    const predefinedResponses = responses.filter((entry) => entry.source === 'predefined').length;
    const lastInteraction = responses[responses.length - 1]?.timestamp;

    const lines = [
        `Here\'s what I have on record for this chat:`,
        `• Total replies sent: ${total}`,
        `• AI generated replies: ${openAIResponses}`,
        `• Memory lookups: ${memoryResponses}`,
        `• Quick replies: ${predefinedResponses}`,
        `• Quick replies remembered: ${chatState.quickReplies.length}`
    ];

    if (lastInteraction) {
        lines.push(`• Last interaction: ${new Date(lastInteraction).toLocaleString()}`);
    }

    if (total === 0) {
        lines.push('No messages have been saved yet. Start chatting and I will keep track.');
    }

    return lines.join('\n');
}

function buildQuickRepliesMessage(chatId) {
    const chatState = getChatState(chatId);
    const quickReplies = chatState.quickReplies;

    if (quickReplies.length === 0) {
        return 'I haven\'t used any quick replies in this chat yet. Say hello and I will remember it!';
    }

    const lines = quickReplies.map((entry) => {
        const timestamp = new Date(entry.timestamp).toLocaleString();
        return `• "${entry.userMessage}" → ${entry.reply} (${timestamp})`;
    });

    return [`Here are the quick replies I\'ve used in this chat:`, ...lines].join('\n');
}

function handleCommand(command, chatId) {
    switch (command) {
    case 'help':
        return buildHelpMessage();
    case 'reset':
        memory.chats[chatId] = {
            history: [],
            quickReplies: []
        };
        saveMemory();
        if (allResponses[chatId]) {
            delete allResponses[chatId];
            saveAllResponses();
        }
        return 'Our conversation history has been cleared. Feel free to start fresh!';
    case 'history':
        return formatHistorySummary(chatId);
    case 'quickreplies':
        return buildQuickRepliesMessage(chatId);
    case 'policy':
    case 'safety':
        return buildPolicyMessage();
    case 'privacy':
        return buildPrivacyMessage();
    case 'stats':
        return buildStatsMessage(chatId);
    case 'about':
        return `${BOT_NAME} is an AI assistant powered by OpenAI. I can help answer questions and keep the conversation flowing!`;
    default:
        return `I don\'t recognise that command. Try ${COMMAND_PREFIX}help for a list of available commands.`;
    }
}

// ---------------- EVENTS ----------------
client.on('qr', qr => qrcode.generate(qr, { small: true }));
client.on('ready', () => console.log(`✅ ${BOT_NAME} is connected and ready!`));

// ---------------- MESSAGE HANDLER ----------------
client.on('message', async (message) => {
    const chatId = message.from;
    const isGroup = chatId.endsWith('@g.us');
    const isPrivate = chatId.endsWith('@s.whatsapp.net');

    let shouldRespond = false;
    let cleanMessage = message.body.trim();

    if (isPrivate) {
        shouldRespond = true; // respond to all private messages
    } else if (isGroup) {
        // Trigger if message contains "Emponyoo,"
        const regex = new RegExp(`\\b${BOT_NAME}\\b[,\\s]*`, 'i');
        if (regex.test(message.body)) {
            shouldRespond = true;
            cleanMessage = message.body.replace(regex, '').trim();
        }
    }

    if (!shouldRespond || !cleanMessage) return;

    const isCommand = cleanMessage.startsWith(COMMAND_PREFIX);

    if (isCommand) {
        const command = cleanMessage.slice(COMMAND_PREFIX.length).trim().toLowerCase();
        const commandName = command.split(/\s+/)[0];
        const reply = handleCommand(commandName, chatId);

        await sendWithTyping(message, reply);
        chatCooldowns.set(chatId, Date.now());
        return;
    }

    if (cleanMessage.length > MAX_MESSAGE_LENGTH) {
        const reply = `That message is quite long. Please keep it under ${MAX_MESSAGE_LENGTH} characters so I can help effectively.`;
        await sendWithTyping(message, reply);
        chatCooldowns.set(chatId, Date.now());
        recordInteraction(chatId, cleanMessage, reply, 'safety');
        return;
    }

    const sensitiveWarning = checkSensitivePatterns(cleanMessage);
    if (sensitiveWarning) {
        await sendWithTyping(message, sensitiveWarning);
        chatCooldowns.set(chatId, Date.now());
        recordInteraction(chatId, cleanMessage, sensitiveWarning, 'safety');
        return;
    }

    const inputModeration = await moderateContent(cleanMessage, 'input');
    if (inputModeration.flagged) {
        console.warn(`⚠️ Moderation blocked a ${inputModeration.type} message in chat ${chatId}. Categories: ${inputModeration.categories.join(', ') || 'n/a'}`);
        const reply = SAFE_FAILURE_MESSAGE;
        await sendWithTyping(message, reply);
        chatCooldowns.set(chatId, Date.now());
        recordInteraction(chatId, cleanMessage, reply, 'safety');
        return;
    }

    if (isRateLimited(chatId)) {
        const reply = 'I\'m wrapping up another request—please try again in a moment.';
        await sendWithTyping(message, reply);
        chatCooldowns.set(chatId, Date.now());
        recordInteraction(chatId, cleanMessage, reply, 'system');
        return;
    }

    // Check predefined replies and stored memory before falling back to OpenAI
    const predefinedReply = getPredefinedReply(cleanMessage);
    let reply = predefinedReply;
    let responseSource = reply ? 'predefined' : null;

    if (!reply) {
        const memoryReply = findMemoryAnswer(chatId, cleanMessage);
        if (memoryReply) {
            reply = memoryReply;
            responseSource = 'memory';
        }
    }

    if (!reply) {
        reply = await getAIReply(chatId, cleanMessage);
        responseSource = 'openai';
    }

    if (!reply) return;

    let outputSource = responseSource;
    const outputModeration = await moderateContent(reply, 'output');
    if (outputModeration.flagged) {
        console.warn(`⚠️ Moderation adjusted an ${outputModeration.type} message in chat ${chatId}. Categories: ${outputModeration.categories.join(', ') || 'n/a'}`);
        reply = SAFE_FAILURE_MESSAGE;
        outputSource = 'safety';
    }

    await sendWithTyping(message, reply);
    chatCooldowns.set(chatId, Date.now());

    if (outputSource === 'predefined') {
        storeQuickReply(chatId, cleanMessage, reply);
    }

    recordInteraction(chatId, cleanMessage, reply, outputSource || 'system');
});

client.initialize();
