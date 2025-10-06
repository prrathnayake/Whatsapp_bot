const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const fs = require('fs');
const { getServiceUrl } = require('./microservices/registry');
const fetch = (...args) => globalThis.fetch(...args);

const {
    BOT_NAME,
    COMMAND_PREFIX,
    STOPWORDS,
    SENSITIVE_PATTERNS,
    SYSTEM_PROMPT,
    TYPING_DELAY_MS,
    MIN_TYPING_DELAY_MS,
    TYPING_DELAY_PER_CHAR_MS,
    RATE_LIMIT_MS,
    MAX_MESSAGE_LENGTH,
    CONTEXT_LIMIT,
    MAX_SAVED_HISTORY,
    MAX_SAVED_RESPONSES,
    MAX_SAVED_QUICK_REPLIES,
    SAVE_DEBOUNCE_MS,
    SAFE_FAILURE_MESSAGE,
    PRIVACY_SUMMARY,
    MEMORY_FILE,
    RESPONSES_FILE,
    GENERAL_RESPONSES_FILE,
    MODERATION_CACHE_TTL_MS,
    MODERATION_CACHE_MAX_ENTRIES,
    CHAT_REQUEST_TIMEOUT_MS,
    PUPPETEER_OPTIONS
} = require('./config');

const chatCooldowns = new Map();
const moderationCache = new Map();
let selfId = null;
let saveAllResponsesTimer = null;
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function escapeRegex(text) {
    return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const BOT_NAME_REGEX = new RegExp(`\\b${escapeRegex(BOT_NAME)}\\b[,\\s]*`, 'i');
const BOT_NAME_REPLACE_REGEX = new RegExp(`\\b${escapeRegex(BOT_NAME)}\\b[,\\s]*`, 'ig');
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

const shouldUseModerationCache =
    Number.isFinite(MODERATION_CACHE_TTL_MS) && MODERATION_CACHE_TTL_MS > 0 &&
    Number.isFinite(MODERATION_CACHE_MAX_ENTRIES) && MODERATION_CACHE_MAX_ENTRIES > 0;

function getModerationCacheKey(text, type) {
    return `${type}:${text}`;
}

function getCachedModerationResult(cacheKey) {
    const cached = moderationCache.get(cacheKey);
    if (!cached) return null;

    if (cached.expiresAt < Date.now()) {
        moderationCache.delete(cacheKey);
        return null;
    }

    return cached.result;
}

function storeModerationResult(cacheKey, result) {
    const now = Date.now();
    moderationCache.set(cacheKey, {
        result,
        expiresAt: now + MODERATION_CACHE_TTL_MS,
        createdAt: now
    });

    if (moderationCache.size <= MODERATION_CACHE_MAX_ENTRIES) return;

    let oldestKey = null;
    let oldestTimestamp = Infinity;

    for (const [key, entry] of moderationCache.entries()) {
        if (entry.expiresAt < now) {
            moderationCache.delete(key);
            continue;
        }

        if (entry.createdAt < oldestTimestamp) {
            oldestTimestamp = entry.createdAt;
            oldestKey = key;
        }
    }

    if (moderationCache.size > MODERATION_CACHE_MAX_ENTRIES && oldestKey) {
        moderationCache.delete(oldestKey);
    }
}

async function moderateContent(text, type = 'input') {
    const normalisedText = typeof text === 'string' ? text.trim() : '';
    if (!normalisedText) {
        return { flagged: false, categories: [], type };
    }

    const cacheKey = shouldUseModerationCache ? getModerationCacheKey(normalisedText, type) : null;

    if (cacheKey) {
        const cachedResult = getCachedModerationResult(cacheKey);
        if (cachedResult) {
            return cachedResult;
        }
    }

    try {
        const response = await fetch(`${getServiceUrl('moderation')}/moderate`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ input: normalisedText, type })
        });

        const data = await response.json().catch(() => ({}));

        if (!response.ok) {
            throw new Error(data?.error || `Moderation service returned status ${response.status}`);
        }

        const categories = Array.isArray(data?.categories) ? data.categories : [];

        const result = {
            flagged: Boolean(data?.flagged),
            categories,
            type: data?.type || type
        };

        if (cacheKey) {
            storeModerationResult(cacheKey, result);
        }

        return result;
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

async function requestChatCompletion({ messages, temperature = 0.7, model = 'gpt-4o-mini' }) {
    if (!Array.isArray(messages) || messages.length === 0) {
        throw new Error('Chat completion requires at least one message.');
    }

    const timeoutMs = Number.isFinite(CHAT_REQUEST_TIMEOUT_MS) && CHAT_REQUEST_TIMEOUT_MS > 0
        ? CHAT_REQUEST_TIMEOUT_MS
        : 20000;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    try {
        const response = await fetch(`${getServiceUrl('chat')}/chat`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ messages, temperature, model }),
            signal: controller.signal
        });

        const data = await response.json().catch(() => ({}));

        if (!response.ok) {
            throw new Error(data?.error || `Chat service returned status ${response.status}`);
        }

        const reply = typeof data?.reply === 'string' ? data.reply.trim() : '';

        if (!reply) {
            throw new Error('Chat service returned an empty reply.');
        }

        return reply;
    } catch (error) {
        if (error.name === 'AbortError') {
            const timeoutError = new Error(`Chat service timed out after ${timeoutMs}ms`);
            timeoutError.code = 'CHAT_TIMEOUT';
            throw timeoutError;
        }
        console.error('Chat service error:', error);
        throw error;
    } finally {
        clearTimeout(timeout);
    }
}

function isRateLimited(chatId) {
    const last = chatCooldowns.get(chatId) || 0;
    if (Date.now() - last < RATE_LIMIT_MS) {
        return true;
    }

    chatCooldowns.set(chatId, Date.now());
    return false;
}

function normaliseResponsePayload(entry) {
    if (!entry || typeof entry !== 'object') return null;

    const rawResponse = entry.response;

    let text = '';
    let caption = '';
    let mediaUrl = '';
    let stickerUrl = '';
    let sendAsSticker = false;
    let mediaBase64 = '';
    let mediaMimeType = '';

    if (typeof rawResponse === 'string') {
        text = rawResponse.trim();
    } else if (rawResponse && typeof rawResponse === 'object') {
        if (typeof rawResponse.text === 'string') {
            text = rawResponse.text.trim();
        }

        if (typeof rawResponse.caption === 'string') {
            caption = rawResponse.caption.trim();
        }

        if (typeof rawResponse.mediaUrl === 'string') {
            mediaUrl = rawResponse.mediaUrl.trim();
        }

        if (typeof rawResponse.stickerUrl === 'string') {
            stickerUrl = rawResponse.stickerUrl.trim();
        }

        if (typeof rawResponse.sendAsSticker === 'boolean') {
            sendAsSticker = rawResponse.sendAsSticker;
        }

        if (typeof rawResponse.mediaBase64 === 'string') {
            mediaBase64 = rawResponse.mediaBase64.trim();
        }

        if (typeof rawResponse.mediaMimeType === 'string') {
            mediaMimeType = rawResponse.mediaMimeType.trim();
        }
    }

    if (!mediaUrl && typeof entry.mediaUrl === 'string') {
        mediaUrl = entry.mediaUrl.trim();
    }

    if (!stickerUrl && typeof entry.stickerUrl === 'string') {
        stickerUrl = entry.stickerUrl.trim();
    }

    if (!caption && typeof entry.caption === 'string') {
        caption = entry.caption.trim();
    }

    if (!mediaBase64 && typeof entry.mediaBase64 === 'string') {
        mediaBase64 = entry.mediaBase64.trim();
    }

    if (!mediaMimeType && typeof entry.mediaMimeType === 'string') {
        mediaMimeType = entry.mediaMimeType.trim();
    }

    if (typeof entry.sendAsSticker === 'boolean') {
        sendAsSticker = entry.sendAsSticker;
    }

    if (stickerUrl && typeof rawResponse?.sendAsSticker === 'undefined' && typeof entry.sendAsSticker === 'undefined') {
        sendAsSticker = true;
    }

    const hasText = typeof text === 'string' && text.trim().length > 0;
    const hasCaption = typeof caption === 'string' && caption.trim().length > 0;
    const hasMedia = typeof mediaUrl === 'string' && mediaUrl.length > 0;
    const hasSticker = typeof stickerUrl === 'string' && stickerUrl.length > 0;

    if (!hasText && !hasCaption && !hasMedia && !hasSticker) {
        return null;
    }

    return {
        text: hasText ? text : '',
        caption: hasCaption ? caption : '',
        mediaUrl: hasMedia ? mediaUrl : '',
        stickerUrl: hasSticker ? stickerUrl : '',
        sendAsSticker: Boolean(sendAsSticker),
        mediaBase64: mediaBase64 || '',
        mediaMimeType: mediaMimeType || ''
    };
}

function normalisePredefinedEntry(entry) {
    if (!entry || typeof entry !== 'object') return null;

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

    const response = normaliseResponsePayload(entry);
    if (!response) return null;

    return {
        keywords: normalisedKeywords,
        response,
        caseSensitive
    };
}

const FALLBACK_MEMORY = { predefinedResponses: [] };
const FALLBACK_GENERAL_RESPONSES = [];

let memory = normaliseMemory(readJsonFile(MEMORY_FILE, FALLBACK_MEMORY));
let allResponses = normaliseAllResponses(readJsonFile(RESPONSES_FILE, {}));
let generalResponses = normaliseGeneralResponses(readJsonFile(GENERAL_RESPONSES_FILE, FALLBACK_GENERAL_RESPONSES));
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

function normaliseGeneralResponses(raw) {
    if (!Array.isArray(raw)) return [];

    return raw
        .map(normalisePredefinedEntry)
        .filter(Boolean);
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

function writeAllResponsesToDisk() {
    fs.promises.writeFile(
        RESPONSES_FILE,
        JSON.stringify(allResponses, null, 2)
    ).catch((error) => {
        console.warn(`⚠️ Unable to write ${RESPONSES_FILE}`, error);
    });
}

function scheduleAllResponsesSave(immediate = false) {
    const debounceMs = Number.isFinite(SAVE_DEBOUNCE_MS) ? Math.max(0, SAVE_DEBOUNCE_MS) : 0;

    if (immediate || debounceMs === 0) {
        if (saveAllResponsesTimer) {
            clearTimeout(saveAllResponsesTimer);
            saveAllResponsesTimer = null;
        }
        writeAllResponsesToDisk();
        return;
    }

    if (saveAllResponsesTimer) return;

    saveAllResponsesTimer = setTimeout(() => {
        saveAllResponsesTimer = null;
        writeAllResponsesToDisk();
    }, debounceMs);
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

    scheduleAllResponsesSave();
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

function getResponseText(response) {
    if (!response) return '';

    if (typeof response === 'string') {
        return response;
    }

    if (typeof response.text === 'string' && response.text.trim().length > 0) {
        return response.text.trim();
    }

    if (typeof response.caption === 'string' && response.caption.trim().length > 0) {
        return response.caption.trim();
    }

    return '';
}

function describeResponseForLog(response) {
    const text = getResponseText(response);
    if (text) return text;

    if (response && typeof response === 'object') {
        if (response.stickerUrl || response.sendAsSticker) {
            return '[sticker]';
        }

        if (response.mediaUrl || response.mediaBase64) {
            return '[media]';
        }
    }

    return '[response]';
}

function getResponseLength(response) {
    if (!response) return 0;

    if (typeof response === 'string') {
        return response.length;
    }

    const text = getResponseText(response);
    return text.length;
}

function calculateTypingDelay(response) {
    const maxDelay = Number.isFinite(TYPING_DELAY_MS) ? Math.max(0, TYPING_DELAY_MS) : 0;
    const minDelay = Number.isFinite(MIN_TYPING_DELAY_MS)
        ? Math.max(0, MIN_TYPING_DELAY_MS)
        : Math.min(350, maxDelay || 350);
    const perChar = Number.isFinite(TYPING_DELAY_PER_CHAR_MS)
        ? Math.max(0, TYPING_DELAY_PER_CHAR_MS)
        : 0;

    if (perChar === 0) {
        return Math.max(minDelay, maxDelay);
    }

    const dynamicDelay = minDelay + getResponseLength(response) * perChar;
    const cap = Math.max(minDelay, maxDelay);

    if (cap === 0) {
        return dynamicDelay;
    }

    return Math.min(dynamicDelay, cap);
}

async function sendWithTyping(message, response) {
    const delayMs = calculateTypingDelay(response);
    if (delayMs > 0) {
        await delay(delayMs);
    }

    if (!response) {
        await message.reply(SAFE_FAILURE_MESSAGE);
        return;
    }

    if (typeof response === 'string') {
        await message.reply(response);
        return;
    }

    const { text, caption, mediaUrl, stickerUrl, sendAsSticker, mediaBase64, mediaMimeType } = response;
    const mentions = Array.isArray(response.mentions) ? response.mentions.filter(Boolean) : [];
    const captionToUse = text || caption || undefined;

    if (mediaBase64) {
        try {
            const mimeType = mediaMimeType || 'image/png';
            const extension = mimeType.split('/')[1] || 'png';
            const media = new MessageMedia(mimeType, mediaBase64, `image.${extension}`);
            await message.reply(media, undefined, captionToUse ? { caption: captionToUse } : undefined);
            return;
        } catch (error) {
            console.warn('⚠️ Failed to send inline media payload. Falling back to alternative content.', error);
        }
    }

    if ((stickerUrl || sendAsSticker) && (stickerUrl || mediaUrl)) {
        const stickerSource = stickerUrl || mediaUrl;

        try {
            const media = await MessageMedia.fromUrl(stickerSource, { unsafeMime: true });
            await message.reply(media, undefined, { sendMediaAsSticker: true });
            if (captionToUse) {
                await message.reply(captionToUse);
            }
            return;
        } catch (error) {
            console.warn('⚠️ Failed to send sticker media. Falling back to alternative content.', error);
        }
    }

    if (mediaUrl) {
        try {
            const media = await MessageMedia.fromUrl(mediaUrl, { unsafeMime: true });
            await message.reply(media, undefined, captionToUse ? { caption: captionToUse } : undefined);
            return;
        } catch (error) {
            console.warn('⚠️ Failed to send media response. Falling back to text.', error);
        }
    }

    const options = mentions.length > 0 ? { mentions } : undefined;
    if (captionToUse || mentions.length > 0) {
        const textToSend = captionToUse || mentions
            .map((contact) => {
                const id = contact?.id;
                if (!id) return null;
                if (typeof id === 'string') {
                    const normalised = normaliseWid(id);
                    return normalised ? `@${normalised}` : null;
                }

                if (typeof id.user === 'string') {
                    return `@${id.user}`;
                }

                const serialized = id?._serialized;
                if (serialized) {
                    const normalised = normaliseWid(serialized);
                    return normalised ? `@${normalised}` : null;
                }

                return null;
            })
            .filter(Boolean)
            .join(' ');

        await message.reply(textToSend || SAFE_FAILURE_MESSAGE, undefined, options);
        return;
    }

    await message.reply(SAFE_FAILURE_MESSAGE);
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
function hasResponseContent(response) {
    if (!response) return false;

    if (typeof response === 'string') {
        return response.trim().length > 0;
    }

    if (typeof response !== 'object') return false;

    return (
        (typeof response.text === 'string' && response.text.trim().length > 0) ||
        (typeof response.caption === 'string' && response.caption.trim().length > 0) ||
        (typeof response.mediaUrl === 'string' && response.mediaUrl.trim().length > 0) ||
        (typeof response.stickerUrl === 'string' && response.stickerUrl.trim().length > 0)
    );
}

function findKeywordResponse(text, entries) {
    if (!text || !Array.isArray(entries) || entries.length === 0) return null;

    const lowerCased = text.toLowerCase();

    for (const entry of entries) {
        if (!entry) continue;

        const keywords = Array.isArray(entry.keywords) ? entry.keywords : [];
        if (keywords.length === 0) continue;

        const response = entry.response;
        if (!hasResponseContent(response)) continue;

        const caseSensitive = Boolean(entry.caseSensitive);

        const matchFound = keywords.some((keyword) => {
            if (typeof keyword !== 'string' || keyword.trim().length === 0) return false;

            if (caseSensitive) {
                return text.includes(keyword);
            }

            return lowerCased.includes(keyword.toLowerCase());
        });

        if (matchFound) {
            if (typeof response === 'string') {
                return { text: response };
            }

            return response;
        }
    }

    return null;
}

function getPredefinedReply(text) {
    return findKeywordResponse(text, memory.predefinedResponses || []);
}

function getGeneralReply(text) {
    return findKeywordResponse(text, generalResponses);
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
        const reply = await requestChatCompletion({
            messages: contextMessages,
            temperature: 0.7
        });

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
        `${COMMAND_PREFIX}summary [focus] - Recap our recent conversation with an optional focus`,
        `${COMMAND_PREFIX}songs <mood or artist> - Discover tailored music suggestions`,
        `${COMMAND_PREFIX}songlink <song name> - Grab a quick YouTube link for a track`,
        `${COMMAND_PREFIX}plan <goal or situation> - Get a quick day-to-day action plan`,
        `${COMMAND_PREFIX}meal <ingredients or dietary need> - Receive speedy meal ideas`,
        `${COMMAND_PREFIX}translate <language> <text> - Translate a message instantly`,
        `${COMMAND_PREFIX}image <prompt> - Generate an AI image (limited daily uses)`,
        `${COMMAND_PREFIX}about - Learn more about ${BOT_NAME}`
    ].join('\n');
}

async function generateTaskResponse({
    commandName,
    query,
    defaultPrompt,
    instructions,
    temperature = 0.6
}) {
    const trimmedQuery = typeof query === 'string' ? query.trim() : '';

    if (trimmedQuery) {
        const inputModeration = await moderateContent(trimmedQuery, 'input');
        if (inputModeration.flagged) {
            console.warn(`⚠️ Moderation blocked a ${commandName} command. Categories: ${inputModeration.categories.join(', ') || 'n/a'}`);
            return SAFE_FAILURE_MESSAGE;
        }
    }

    const systemContent = [
        SYSTEM_PROMPT,
        'Follow these additional instructions when responding to this command:',
        Array.isArray(instructions) ? instructions.join('\n') : instructions
    ].join('\n');

    const userPrompt = trimmedQuery || defaultPrompt;

    try {
        const reply = await requestChatCompletion({
            messages: [
                { role: 'system', content: systemContent },
                { role: 'user', content: userPrompt }
            ],
            temperature
        });

        const outputModeration = await moderateContent(reply, 'output');
        if (outputModeration.flagged) {
            console.warn(`⚠️ Moderation adjusted a ${commandName} command response. Categories: ${outputModeration.categories.join(', ') || 'n/a'}`);
            return SAFE_FAILURE_MESSAGE;
        }

        return reply;
    } catch (error) {
        console.error(`Unable to fulfil ${commandName} command:`, error);
        return 'I had trouble putting that together. Please try again in a moment.';
    }
}

function buildCommandInstructions(baseInstructions) {
    const shared = [
        '• Keep responses concise and easy to skim.',
        '• Use bullet points for lists and limit to five items unless fewer make sense.',
        '• Stay practical and avoid making promises about unavailable services or exact schedules.'
    ];

    return [...shared, ...baseInstructions].join('\n');
}

async function buildSongSuggestions(query) {
    return generateTaskResponse({
        commandName: 'songs',
        query,
        defaultPrompt: 'Suggest a varied list of five widely known songs suitable for general listening.',
        instructions: buildCommandInstructions([
            '• Help the user discover music that matches their mood or activity.',
            '• Format each bullet as “Song – Artist: short vibe description”.',
            '• Do not mention specific streaming platforms or availability guarantees.'
        ])
    });
}

async function buildDayPlan(query) {
    return generateTaskResponse({
        commandName: 'plan',
        query,
        defaultPrompt: 'Create a balanced plan for a productive and healthy day for someone with no specific context.',
        instructions: buildCommandInstructions([
            '• Offer a short introduction sentence before the list.',
            '• Provide practical steps that cover work, self-care, and breaks.',
            '• Tailor the suggestions to the provided details when available.'
        ])
    });
}

async function buildMealIdeas(query) {
    return generateTaskResponse({
        commandName: 'meal',
        query,
        defaultPrompt: 'Suggest three simple meal ideas that can be prepared quickly with common pantry ingredients.',
        instructions: buildCommandInstructions([
            '• Focus on easy-to-find ingredients and straightforward preparation.',
            '• Include brief cooking tips or substitutions where helpful.',
            '• Remind the user to adjust for allergies or dietary restrictions if relevant.'
        ])
    });
}

async function fetchSongLink(query) {
    const trimmed = typeof query === 'string' ? query.trim() : '';

    if (!trimmed) {
        return 'Please tell me which song you would like me to find.';
    }

    try {
        const response = await fetch(`${getServiceUrl('youtube')}/search`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ query: trimmed })
        });

        const data = await response.json().catch(() => ({}));

        if (!response.ok) {
            throw new Error(data?.error || `YouTube service returned status ${response.status}`);
        }

        if (!data?.url) {
            return `I couldn't find a matching YouTube link for "${trimmed}".`;
        }

        const lines = [
            "Here’s the best match I found:",
            data.title ? `${data.title}${data.author ? ` – ${data.author}` : ''}` : null,
            data.url
        ].filter(Boolean);

        if (typeof data?.description === 'string' && data.description.trim()) {
            lines.splice(1, 0, data.description.trim());
        }

        return lines.join('\n');
    } catch (error) {
        console.error('YouTube lookup failed:', error);
        return 'I had trouble searching YouTube just now. Please try again in a moment.';
    }
}

async function requestImageGeneration(chatId, prompt) {
    try {
        const response = await fetch(`${getServiceUrl('image')}/image`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ chatId, prompt })
        });

        const data = await response.json().catch(() => ({}));

        if (!response.ok) {
            const usage = data?.usage;
            if (response.status === 429 && usage) {
                const remainingMs = typeof usage.resetInMs === 'number' ? usage.resetInMs : null;
                const remainingMinutes = remainingMs ? Math.ceil(remainingMs / 60000) : null;
                const waitMessage = remainingMinutes ? ` Try again in about ${remainingMinutes} minute${remainingMinutes === 1 ? '' : 's'}.` : '';
                return { error: `You have reached the daily image limit of ${usage.limit}. ${waitMessage}`.trim(), usage };
            }

            const errorMessage = typeof data?.error === 'string' && data.error.trim()
                ? data.error.trim()
                : `Image service returned status ${response.status}`;

            return { error: errorMessage, usage };
        }

        return data;
    } catch (error) {
        console.error('Image service error:', error);
        const fallbackMessage = 'I couldn\'t create that image right now. Please try again later.';

        if (error) {
            const message = typeof error === 'string' ? error : error?.message;
            if (message && message.trim()) {
                const lower = message.toLowerCase();
                if (
                    lower.includes('unavailable') ||
                    lower.includes('timeout') ||
                    lower.includes('connection')
                ) {
                    return { error: message.trim() };
                }
            }

            const errorCode = error?.code || error?.cause?.code;
            if (typeof errorCode === 'string') {
                const transientCodes = new Set(['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT']);
                if (transientCodes.has(errorCode)) {
                    return { error: 'The image service is currently unavailable. Please try again later.' };
                }
            }
        }

        return { error: fallbackMessage };
    }
}

async function handleImageCommand(chatId, args) {
    const trimmed = typeof args === 'string' ? args.trim() : '';

    if (!trimmed) {
        return 'Please describe the image you would like me to create (for example, "a cozy cabin in the snow").';
    }

    const moderation = await moderateContent(trimmed, 'image-prompt');
    if (moderation.flagged) {
        console.warn(`⚠️ Moderation blocked an image prompt for chat ${chatId}. Categories: ${moderation.categories.join(', ') || 'n/a'}`);
        return SAFE_FAILURE_MESSAGE;
    }

    const result = await requestImageGeneration(chatId, trimmed);

    if (result?.error) {
        return result.error;
    }

    const image = Array.isArray(result?.images) ? result.images[0] : null;
    if (!image || !image.base64) {
        return 'The image service did not return a usable image. Please try again.';
    }

    const usage = result?.usage;
    let captionSuffix = '';
    if (usage && typeof usage.remaining === 'number') {
        const remaining = usage.remaining;
        const plural = remaining === 1 ? '' : 's';
        captionSuffix = ` (${remaining} generation${plural} left today.)`;
    }

    return {
        text: `Here is what I imagined for "${trimmed}".${captionSuffix}`,
        mediaBase64: image.base64,
        mediaMimeType: image.mimeType || 'image/png'
    };
}

function buildConversationTranscript(entries) {
    return entries
        .map((entry) => {
            const speaker = entry.role === 'assistant' ? BOT_NAME : 'User';
            return `${speaker}: ${entry.content}`;
        })
        .join('\n');
}

async function buildConversationSummary(chatId, focus) {
    const chatState = getChatState(chatId);
    const trimmedFocus = typeof focus === 'string' ? focus.trim() : '';

    if (trimmedFocus) {
        const focusModeration = await moderateContent(trimmedFocus, 'input');
        if (focusModeration.flagged) {
            console.warn(`⚠️ Moderation blocked a summary focus phrase. Categories: ${focusModeration.categories.join(', ') || 'n/a'}`);
            return SAFE_FAILURE_MESSAGE;
        }
    }

    const recentHistory = chatState.history.slice(-Math.max(8, Math.min(20, CONTEXT_LIMIT)));
    if (recentHistory.length === 0) {
        return 'There is no recent conversation to summarise yet.';
    }

    const transcript = buildConversationTranscript(recentHistory);
    const transcriptModeration = await moderateContent(transcript, 'input');
    if (transcriptModeration.flagged) {
        console.warn(`⚠️ Moderation blocked a transcript summary. Categories: ${transcriptModeration.categories.join(', ') || 'n/a'}`);
        return SAFE_FAILURE_MESSAGE;
    }

    const focusLine = trimmedFocus ? `Focus on: ${trimmedFocus}\n` : '';
    const systemContent = [
        SYSTEM_PROMPT,
        'You are summarising a WhatsApp chat for the user.',
        'Keep the tone neutral, highlight key takeaways, and suggest next steps if relevant.',
        'Respond with a short intro sentence followed by up to three concise bullet points.'
    ].join('\n');

    try {
        const summary = await requestChatCompletion({
            messages: [
                { role: 'system', content: systemContent },
                {
                    role: 'user',
                    content: `${focusLine}Summarise this conversation between the user and ${BOT_NAME}:\n${transcript}`
                }
            ],
            temperature: 0.4
        });

        const outputModeration = await moderateContent(summary, 'output');
        if (outputModeration.flagged) {
            console.warn(`⚠️ Moderation adjusted a conversation summary. Categories: ${outputModeration.categories.join(', ') || 'n/a'}`);
            return SAFE_FAILURE_MESSAGE;
        }

        return summary;
    } catch (error) {
        if (error?.code === 'CHAT_TIMEOUT') {
            return 'The summary request is taking too long. Please try again shortly.';
        }
        console.error('Unable to generate conversation summary:', error);
        return 'I could not build a summary just now. Please try again in a moment.';
    }
}

async function translateText(args) {
    const trimmed = typeof args === 'string' ? args.trim() : '';
    if (!trimmed) {
        return `Please provide the target language and the text to translate, e.g. ${COMMAND_PREFIX}translate spanish How are you?`;
    }

    let targetLanguage = '';
    let textToTranslate = '';

    const colonIndex = trimmed.indexOf(':');
    const pipeIndex = trimmed.indexOf('|');
    const separatorIndex = colonIndex !== -1 ? colonIndex : pipeIndex;

    if (separatorIndex !== -1) {
        targetLanguage = trimmed.slice(0, separatorIndex).trim();
        textToTranslate = trimmed.slice(separatorIndex + 1).trim();
    } else {
        const parts = trimmed.split(/\s+/);
        targetLanguage = parts.shift();
        textToTranslate = parts.join(' ').trim();
    }

    if (!targetLanguage || !textToTranslate) {
        return `Please specify both the language and the text, for example: ${COMMAND_PREFIX}translate French I like learning new things.`;
    }

    const inputModeration = await moderateContent(textToTranslate, 'input');
    if (inputModeration.flagged) {
        console.warn(`⚠️ Moderation blocked a translation request. Categories: ${inputModeration.categories.join(', ') || 'n/a'}`);
        return SAFE_FAILURE_MESSAGE;
    }

    const systemContent = [
        SYSTEM_PROMPT,
        'You are a precise translation assistant.',
        'Return only the translated text unless extra context is essential for accuracy.'
    ].join('\n');

    const userContent = [
        `Translate the following message into ${targetLanguage}:`,
        textToTranslate,
        '',
        'If the message is already in that language, provide a polished version and mention that it was already in the target language.'
    ].join('\n');

    try {
        const translation = await requestChatCompletion({
            messages: [
                { role: 'system', content: systemContent },
                { role: 'user', content: userContent }
            ],
            temperature: 0.3
        });

        const outputModeration = await moderateContent(translation, 'output');
        if (outputModeration.flagged) {
            console.warn(`⚠️ Moderation adjusted a translation output. Categories: ${outputModeration.categories.join(', ') || 'n/a'}`);
            return SAFE_FAILURE_MESSAGE;
        }

        return translation;
    } catch (error) {
        if (error?.code === 'CHAT_TIMEOUT') {
            return 'The translation is taking longer than expected. Please try again shortly.';
        }
        console.error('Unable to translate text:', error);
        return 'I could not translate that right now. Please try again in a moment.';
    }
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

function buildLengthWarning() {
    return `That message is quite long. Please keep it under ${MAX_MESSAGE_LENGTH} characters so I can help effectively.`;
}

function isMentionAllTrigger(message) {
    if (!message) return false;

    const trimmed = message.trim().toLowerCase();
    if (!trimmed) return false;

    if (trimmed === 'everyone' || trimmed === '@everyone') {
        return true;
    }

    const prefixes = ['@everyone', 'everyone'];
    for (const prefix of prefixes) {
        if (trimmed.startsWith(prefix)) {
            const remainder = trimmed.slice(prefix.length);
            if (!remainder) return true;
            if (/^[\s,.!?:;\-]+/.test(remainder)) {
                return true;
            }
        }
    }

    return false;
}

async function tryHandleMentionAll(message, cleanMessage, chatId) {
    if (!isMentionAllTrigger(cleanMessage)) return false;

    let chat;
    try {
        chat = await message.getChat();
    } catch (error) {
        console.warn('⚠️ Unable to load chat details for mention-all request.', error);
        return false;
    }

    if (!chat?.isGroup) return false;

    const participants = Array.isArray(chat.participants) ? chat.participants : [];
    const mentionSet = new Set();
    const selfNormalised = selfId ? normaliseWid(selfId) : null;

    const mentionData = await Promise.all(participants.map(async (participant) => {
        const participantId = participant?.id;
        const serialized = typeof participantId === 'string' ? participantId : participantId?._serialized;
        if (!serialized) return null;

        const normalisedId = normaliseWid(serialized);
        if (!normalisedId) return null;

        if (selfNormalised && normalisedId === selfNormalised) {
            return null;
        }

        if (mentionSet.has(normalisedId)) {
            return null;
        }

        try {
            const contact = await client.getContactById(serialized);
            if (!contact) return null;

            mentionSet.add(normalisedId);
            const placeholder = `@${contact?.id?.user || normalisedId}`;

            return { contact, placeholder };
        } catch (error) {
            console.warn(`⚠️ Unable to fetch contact ${serialized} for mention-all request.`, error);
            return null;
        }
    }));

    const validMentions = mentionData.filter(Boolean);

    if (validMentions.length === 0) {
        const reply = 'I couldn\'t find anyone to mention in this group.';
        await sendWithTyping(message, reply);
        chatCooldowns.set(chatId, Date.now());
        recordInteraction(chatId, cleanMessage, reply, 'mention-all');
        return true;
    }

    const mentionText = validMentions.map((entry) => entry.placeholder).join(' ');
    const mentionContacts = validMentions.map((entry) => entry.contact);

    await sendWithTyping(message, { text: mentionText, mentions: mentionContacts });
    chatCooldowns.set(chatId, Date.now());
    recordInteraction(chatId, cleanMessage, mentionText, 'mention-all');
    return true;
}

async function tryHandleGeneralMessage(message, cleanMessage, chatId) {
    if (!cleanMessage || !chatId.endsWith('@g.us')) return false;
    if (cleanMessage.startsWith(COMMAND_PREFIX)) return false;

    if (await tryHandleMentionAll(message, cleanMessage, chatId)) {
        return true;
    }

    const generalResponse = getGeneralReply(cleanMessage);
    if (!generalResponse) return false;

    if (cleanMessage.length > MAX_MESSAGE_LENGTH) {
        const reply = buildLengthWarning();
        await sendWithTyping(message, reply);
        chatCooldowns.set(chatId, Date.now());
        recordInteraction(chatId, cleanMessage, reply, 'safety');
        return true;
    }

    const sensitiveWarning = checkSensitivePatterns(cleanMessage);
    if (sensitiveWarning) {
        await sendWithTyping(message, sensitiveWarning);
        chatCooldowns.set(chatId, Date.now());
        recordInteraction(chatId, cleanMessage, sensitiveWarning, 'safety');
        return true;
    }

    if (isRateLimited(chatId)) {
        const reply = 'I\'m wrapping up another request—please try again in a moment.';
        await sendWithTyping(message, reply);
        chatCooldowns.set(chatId, Date.now());
        recordInteraction(chatId, cleanMessage, reply, 'system');
        return true;
    }

    const inputModeration = await moderateContent(cleanMessage, 'input');
    if (inputModeration.flagged) {
        console.warn(`⚠️ Moderation blocked a ${inputModeration.type} message in chat ${chatId}. Categories: ${inputModeration.categories.join(', ') || 'n/a'}`);
        const reply = SAFE_FAILURE_MESSAGE;
        await sendWithTyping(message, reply);
        chatCooldowns.set(chatId, Date.now());
        recordInteraction(chatId, cleanMessage, reply, 'safety');
        return true;
    }

    let replyPayload = generalResponse;
    let outputSource = 'general';

    const moderationTarget = getResponseText(replyPayload);
    if (moderationTarget) {
        const outputModeration = await moderateContent(moderationTarget, 'output');
        if (outputModeration.flagged) {
            console.warn(`⚠️ Moderation adjusted an ${outputModeration.type} message in chat ${chatId}. Categories: ${outputModeration.categories.join(', ') || 'n/a'}`);
            replyPayload = SAFE_FAILURE_MESSAGE;
            outputSource = 'safety';
        }
    }

    await sendWithTyping(message, replyPayload);
    chatCooldowns.set(chatId, Date.now());
    recordInteraction(
        chatId,
        cleanMessage,
        typeof replyPayload === 'string' ? replyPayload : describeResponseForLog(replyPayload),
        outputSource
    );

    return true;
}

async function handleCommand(command, chatId, args = '') {
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
            scheduleAllResponsesSave(true);
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
    case 'summary':
    case 'summarise':
    case 'summarize':
        return await buildConversationSummary(chatId, args);
    case 'song':
    case 'songs':
        return await buildSongSuggestions(args);
    case 'songlink':
    case 'youtube':
    case 'yt':
        return await fetchSongLink(args);
    case 'plan':
    case 'planner':
    case 'daily':
        return await buildDayPlan(args);
    case 'meal':
    case 'meals':
    case 'recipe':
    case 'recipes':
        return await buildMealIdeas(args);
    case 'translate':
        return await translateText(args);
    case 'image':
    case 'images':
    case 'img':
    case 'art':
        return await handleImageCommand(chatId, args);
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
        if (BOT_NAME_REGEX.test(rawBody)) {
            shouldRespond = true;
            const withoutName = rawBody.replace(BOT_NAME_REPLACE_REGEX, '').trim();
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

    if (await tryHandleGeneralMessage(message, cleanMessage, chatId)) {
        return;
    }

    if (!shouldRespond || !cleanMessage) return;

    const isCommand = cleanMessage.startsWith(COMMAND_PREFIX);

    if (isCommand) {
        const commandBody = cleanMessage.slice(COMMAND_PREFIX.length).trim();
        if (!commandBody) {
            const reply = `Try ${COMMAND_PREFIX}help for a list of available commands.`;
            await sendWithTyping(message, reply);
            chatCooldowns.set(chatId, Date.now());
            return;
        }

        const [commandNameRaw, ...restParts] = commandBody.split(/\s+/);
        const commandName = (commandNameRaw || '').toLowerCase();
        const args = restParts.length > 0 ? commandBody.slice(commandNameRaw.length).trim() : '';
        const reply = await handleCommand(commandName, chatId, args);

        await sendWithTyping(message, reply);
        chatCooldowns.set(chatId, Date.now());
        return;
    }

    if (cleanMessage.length > MAX_MESSAGE_LENGTH) {
        const reply = buildLengthWarning();
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

    if (isRateLimited(chatId)) {
        const reply = 'I\'m wrapping up another request—please try again in a moment.';
        await sendWithTyping(message, reply);
        chatCooldowns.set(chatId, Date.now());
        recordInteraction(chatId, cleanMessage, reply, 'system');
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

    // Check predefined replies and stored memory before falling back to OpenAI
    const predefinedReply = getPredefinedReply(cleanMessage);
    let replyPayload = predefinedReply;
    let responseSource = replyPayload ? 'predefined' : null;

    if (!replyPayload) {
        const memoryReply = findMemoryAnswer(chatId, cleanMessage);
        if (memoryReply) {
            replyPayload = memoryReply;
            responseSource = 'memory';
        }
    }

    if (!replyPayload) {
        replyPayload = await getAIReply(chatId, cleanMessage);
        responseSource = 'openai';
    }

    if (!replyPayload) return;

    let outputSource = responseSource;
    const moderationTarget = typeof replyPayload === 'string' ? replyPayload : getResponseText(replyPayload);
    if (moderationTarget) {
        const outputModeration = await moderateContent(moderationTarget, 'output');
        if (outputModeration.flagged) {
            console.warn(`⚠️ Moderation adjusted an ${outputModeration.type} message in chat ${chatId}. Categories: ${outputModeration.categories.join(', ') || 'n/a'}`);
            replyPayload = SAFE_FAILURE_MESSAGE;
            outputSource = 'safety';
        }
    }

    await sendWithTyping(message, replyPayload);
    chatCooldowns.set(chatId, Date.now());

    recordInteraction(
        chatId,
        cleanMessage,
        typeof replyPayload === 'string' ? replyPayload : describeResponseForLog(replyPayload),
        outputSource || 'system'
    );
});

async function startBot() {
    await client.initialize();
    return client;
}

module.exports = startBot;
