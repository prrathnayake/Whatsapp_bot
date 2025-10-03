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
const COMMAND_PREFIX = '!';

const STOPWORDS = new Set([
    'the', 'and', 'for', 'are', 'but', 'you', 'your', 'with', 'this', 'that', 'have', 'from',
    'what', 'when', 'where', 'who', 'why', 'how', 'which', 'been', 'were', 'will', 'would',
    'could', 'should', 'about', 'there', 'here', 'they', 'them', 'their', 'ours', 'ourselves',
    'him', 'her', 'his', 'hers', 'its', 'our', 'out', 'into', 'onto', 'because', 'been', 'can'
]);

const SYSTEM_PROMPT = `You are ${BOT_NAME}, a warm and professional WhatsApp assistant.
- Always introduce yourself as ${BOT_NAME} when asked who you are.
- Keep answers short and conversational (2-4 sentences unless the user explicitly asks for more).
- If you are unsure about something, be honest and offer to help look it up.`;
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

let memory = readJsonFile(MEMORY_FILE, {});
let allResponses = readJsonFile(RESPONSES_FILE, {});

memory = Object.fromEntries(
    Object.entries(memory || {}).map(([chatId, history]) => [chatId, normaliseHistory(history)])
);

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

// Ensure memory for each chat
function initChatMemory(chatId) {
    if (!memory[chatId]) {
        memory[chatId] = [];
        return;
    }

    memory[chatId] = normaliseHistory(memory[chatId]);
}

// Save memory & responses
function saveMemory() {
    fs.writeFileSync(MEMORY_FILE, JSON.stringify(memory, null, 2));
}

function saveAllResponses() {
    fs.writeFileSync(RESPONSES_FILE, JSON.stringify(allResponses, null, 2));
}

function appendToHistory(chatId, entry) {
    initChatMemory(chatId);
    memory[chatId].push(entry);

    if (memory[chatId].length > MAX_SAVED_HISTORY) {
        memory[chatId] = memory[chatId].slice(-MAX_SAVED_HISTORY);
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

function extractKeywords(text) {
    return text
        .toLowerCase()
        .replace(/["'`,.!?;:()\[\]{}<>@#%^&*_+=/\\|-]+/g, ' ')
        .split(/\s+/)
        .filter((word) => word.length > 2 && !STOPWORDS.has(word));
}

function findMemoryAnswer(chatId, message) {
    initChatMemory(chatId);

    const keywords = extractKeywords(message);
    if (keywords.length === 0) return null;

    const keywordSet = new Set(keywords);

    let bestMatch = null;
    let bestScore = 0;

    for (const entry of memory[chatId]) {
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
    const normalised = text.toLowerCase();

    if (normalised.includes('hello') || normalised.includes('hi')) return 'Hello! 👋';
    if (normalised.includes('how are you')) return "I\'m just a bot, but I\'m doing great! 😄";
    if (normalised.includes('good morning')) return 'Good morning! ☀️';
    if (normalised.includes('good night')) return 'Good night! 🌙';
    if (normalised.includes('thanks') || normalised.includes('thank you')) return "You\'re welcome! 😊";
    if (normalised.includes('bye') || normalised.includes('goodbye')) return 'Goodbye! 👋';

    return null;
}

// ---------------- AI REPLY ----------------
async function getAIReply(chatId, message) {
    initChatMemory(chatId);

    // Include last N messages for context
    const contextMessages = memory[chatId]
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

        appendToHistory(chatId, { role: 'user', content: message });
        appendToHistory(chatId, { role: 'assistant', content: reply });

        appendResponse(chatId, {
            message,
            reply,
            timestamp: new Date().toISOString()
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
        `${COMMAND_PREFIX}about - Learn more about ${BOT_NAME}`
    ].join('\n');
}

function formatHistorySummary(chatId) {
    initChatMemory(chatId);
    const lastEntries = memory[chatId].slice(-6);

    if (lastEntries.length === 0) {
        return 'There\'s no saved conversation history yet.';
    }

    const lines = lastEntries.map((entry) => {
        const prefix = entry.role === 'assistant' ? `${BOT_NAME}:` : 'You:';
        return `${prefix} ${entry.content}`;
    });

    return `Here\'s the latest context I\'m using:\n${lines.join('\n')}`;
}

function handleCommand(command, chatId) {
    switch (command) {
    case 'help':
        return buildHelpMessage();
    case 'reset':
        memory[chatId] = [];
        saveMemory();
        if (allResponses[chatId]) {
            delete allResponses[chatId];
            saveAllResponses();
        }
        return 'Our conversation history has been cleared. Feel free to start fresh!';
    case 'history':
        return formatHistorySummary(chatId);
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

    if (cleanMessage.startsWith(COMMAND_PREFIX)) {
        const command = cleanMessage.slice(COMMAND_PREFIX.length).trim().toLowerCase();
        const commandName = command.split(/\s+/)[0];
        const reply = handleCommand(commandName, chatId);

        await new Promise((resolve) => setTimeout(resolve, TYPING_DELAY_MS));
        await message.reply(reply);
        return;
    }

    // Check predefined replies and stored memory before falling back to OpenAI
    const predefinedReply = getPredefinedReply(cleanMessage);
    let reply = predefinedReply;
    let usedOpenAI = false;

    if (!reply) {
        reply = findMemoryAnswer(chatId, cleanMessage);
        if (reply) {
            appendToHistory(chatId, { role: 'user', content: cleanMessage });
            appendToHistory(chatId, { role: 'assistant', content: reply });
            appendResponse(chatId, {
                message: cleanMessage,
                reply,
                timestamp: new Date().toISOString(),
                source: 'memory'
            });
        }
    }

    if (!reply) {
        reply = await getAIReply(chatId, cleanMessage);
        usedOpenAI = true;
    }

    if (reply) {
        // Typing simulation
        await new Promise((r) => setTimeout(r, TYPING_DELAY_MS));
        await message.reply(reply);

        // Ensure we record user messages that received an AI lookup but
        // failed (e.g. empty reply) by syncing memory here
        if (!usedOpenAI) {
            // Append again only if we didn't already store the conversation
            // (predefined replies are stateless, so track them here)
            const lastTwo = memory[chatId]?.slice(-2) || [];
            const alreadyStored = lastTwo.some(
                (entry) => entry?.role === 'assistant' && entry.content === reply
            );

            if (!alreadyStored) {
                appendToHistory(chatId, { role: 'user', content: cleanMessage });
                appendToHistory(chatId, { role: 'assistant', content: reply });
                appendResponse(chatId, {
                    message: cleanMessage,
                    reply,
                    timestamp: new Date().toISOString(),
                    source: predefinedReply ? 'predefined' : 'memory'
                });
            }
        }
    }
});

client.initialize();
