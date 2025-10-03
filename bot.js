require('dotenv').config();
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const OpenAI = require('openai');
const fs = require('fs');

const {
    BOT_NAME,
    COMMAND_PREFIX,
    STOPWORDS,
    SENSITIVE_PATTERNS,
    SYSTEM_PROMPT,
    TYPING_DELAY_MS,
    RATE_LIMIT_MS,
    MAX_MESSAGE_LENGTH,
    CONTEXT_LIMIT,
    MAX_SAVED_HISTORY,
    MAX_SAVED_RESPONSES,
    MAX_SAVED_QUICK_REPLIES,
    SAFE_FAILURE_MESSAGE,
    PRIVACY_SUMMARY,
    MEMORY_FILE,
    RESPONSES_FILE,
    PUPPETEER_OPTIONS
} = require('./config');

if (!process.env.OPENAI_API_KEY) {
    throw new Error('Missing OPENAI_API_KEY environment variable. Please configure your .env file.');
}

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const chatCooldowns = new Map();
let selfId = null;
// ----------------------------------------

const client = new Client({
    authStrategy: new LocalAuth(),
    puppeteer: PUPPETEER_OPTIONS
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

const FALLBACK_MEMORY = { predefinedResponses: [] };

let memory = normaliseMemory(readJsonFile(MEMORY_FILE, FALLBACK_MEMORY));
let allResponses = normaliseAllResponses(readJsonFile(RESPONSES_FILE, {}));
const chatCache = new Map();

// Ensure the memory file only contains predefined responses going forward.
saveMemory();

function normaliseMemory(rawMemory) {
    if (!rawMemory || typeof rawMemory !== 'object' || Array.isArray(rawMemory)) {
        return { predefinedResponses: [] };
    }

    const predefinedRaw = Array.isArray(rawMemory.predefinedResponses)
        ? rawMemory.predefinedResponses
        : [];

    return {
        predefinedResponses: predefinedRaw
            .map(normalisePredefinedEntry)
            .filter(Boolean)
    };
}

function normaliseResponseRecord(record) {
    if (!record || typeof record !== 'object') return null;

    const message = typeof record.message === 'string' ? record.message : '';
    const reply = typeof record.reply === 'string' ? record.reply : '';
    const source = typeof record.source === 'string' ? record.source : 'system';

    let timestamp;
    if (record.timestamp) {
        const parsed = new Date(record.timestamp);
        timestamp = Number.isNaN(parsed.getTime()) ? new Date().toISOString() : parsed.toISOString();
    } else {
        timestamp = new Date().toISOString();
    }

    if (!message && !reply) return null;

    return {
        message,
        reply,
        source,
        timestamp
    };
}

function normaliseAllResponses(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};

    const result = {};

    for (const [chatId, entries] of Object.entries(raw)) {
        if (!chatId || !Array.isArray(entries)) continue;

        result[chatId] = entries
            .map(normaliseResponseRecord)
            .filter(Boolean)
            .slice(-MAX_SAVED_RESPONSES);
    }

    return result;
}

function hydrateChatState(chatId) {
    const records = allResponses[chatId] || [];
    const history = [];
    const quickReplies = [];

    for (const entry of records) {
        if (entry.message) {
            history.push({ role: 'user', content: entry.message });
        }

        if (entry.reply) {
            history.push({ role: 'assistant', content: entry.reply });
        }

        if (entry.source === 'predefined' && entry.reply) {
            quickReplies.push({
                userMessage: entry.message || '',
                reply: entry.reply,
                timestamp: entry.timestamp
            });
        }
    }

    return {
        history: history.slice(-MAX_SAVED_HISTORY),
        quickReplies: quickReplies.slice(-MAX_SAVED_QUICK_REPLIES)
    };
}

function getChatState(chatId) {
    if (!chatCache.has(chatId)) {
        chatCache.set(chatId, hydrateChatState(chatId));
    }

    return chatCache.get(chatId);
}

// Save memory & responses
function saveMemory() {
    fs.promises.writeFile(
        MEMORY_FILE,
        JSON.stringify({ predefinedResponses: memory.predefinedResponses }, null, 2)
    ).catch((error) => {
        console.warn(`⚠️ Unable to write ${MEMORY_FILE}`, error);
    });
}

function saveAllResponses() {
    fs.promises.writeFile(
        RESPONSES_FILE,
        JSON.stringify(allResponses, null, 2)
    ).catch((error) => {
        console.warn(`⚠️ Unable to write ${RESPONSES_FILE}`, error);
    });
}

function appendResponse(chatId, record) {
    if (!allResponses[chatId]) {
        allResponses[chatId] = [];
    }

    const normalised = normaliseResponseRecord(record);
    if (!normalised) return;

    allResponses[chatId].push(normalised);

    if (allResponses[chatId].length > MAX_SAVED_RESPONSES) {
        allResponses[chatId] = allResponses[chatId].slice(-MAX_SAVED_RESPONSES);
    }

    saveAllResponses();
}

function recordInteraction(chatId, userMessage, reply, source = 'system') {
    const chatState = getChatState(chatId);
    const timestamp = new Date().toISOString();

    if (userMessage) {
        chatState.history.push({ role: 'user', content: userMessage });
    }

    if (reply) {
        chatState.history.push({ role: 'assistant', content: reply });
    }

    if (chatState.history.length > MAX_SAVED_HISTORY) {
        chatState.history = chatState.history.slice(-MAX_SAVED_HISTORY);
    }

    if (source === 'predefined' && userMessage && reply) {
        chatState.quickReplies.push({ userMessage, reply, timestamp });

        if (chatState.quickReplies.length > MAX_SAVED_QUICK_REPLIES) {
            chatState.quickReplies = chatState.quickReplies.slice(-MAX_SAVED_QUICK_REPLIES);
        }
    }

    appendResponse(chatId, {
        message: userMessage,
        reply,
        timestamp,
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
        chatCache.set(chatId, {
            history: [],
            quickReplies: []
        });
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
client.on('ready', () => {
    selfId = client?.info?.wid?._serialized || null;
    console.log(`✅ ${BOT_NAME} is connected and ready!`);
});

function normaliseWid(wid) {
    if (typeof wid !== 'string') return null;
    const trimmed = wid.trim();
    if (!trimmed) return null;
    return trimmed.replace(/@.*$/, '');
}

// ---------------- MESSAGE HANDLER ----------------
client.on('message', async (message) => {
    const chatId = message.from;
    const isGroup = chatId.endsWith('@g.us');
    const isPrivate = chatId.endsWith('@s.whatsapp.net');

    let shouldRespond = false;
    const rawBody = typeof message.body === 'string' ? message.body : '';
    let cleanMessage = rawBody.trim();

    if (isPrivate) {
        shouldRespond = true; // respond to all private messages
    } else if (isGroup) {
        // Trigger if message contains the bot name
        const regex = new RegExp(`\\b${BOT_NAME}\\b[,\\s]*`, 'i');
        if (regex.test(rawBody)) {
            shouldRespond = true;
            const withoutName = rawBody.replace(regex, '').trim();
            if (withoutName) {
                cleanMessage = withoutName;
            }
        }

        if (!shouldRespond && selfId) {
            const targetId = normaliseWid(selfId);
            const mentionedIds = new Set();

            if (Array.isArray(message.mentionedIds)) {
                for (const id of message.mentionedIds) {
                    if (id) mentionedIds.add(id);
                }
            } else if (typeof message.getMentions === 'function') {
                try {
                    const mentions = await message.getMentions();
                    for (const contact of mentions || []) {
                        const id = contact?.id?._serialized || contact?.id;
                        if (id) mentionedIds.add(id);
                    }
                } catch (error) {
                    console.warn('⚠️ Unable to read message mentions', error);
                }
            }

            for (const id of mentionedIds) {
                const normalised = normaliseWid(typeof id === 'string' ? id : id?._serialized || '');
                if (normalised && normalised === targetId) {
                    shouldRespond = true;
                    const withoutMentions = rawBody.replace(/@\S+/g, ' ').replace(/\s+/g, ' ').trim();
                    if (withoutMentions) {
                        cleanMessage = withoutMentions;
                    }
                    break;
                }
            }
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

    recordInteraction(chatId, cleanMessage, reply, outputSource || 'system');
});

client.initialize();
