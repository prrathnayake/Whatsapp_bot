require('dotenv').config();
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const OpenAI = require('openai');
const fs = require('fs');
const path = require('path');

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// ---------------- CONFIG ----------------
const BOT_NAME = "Emponyoo";
const TYPING_DELAY_MS = 1500;
const MEMORY_FILE = path.join(__dirname, 'memory.json');
const RESPONSES_FILE = path.join(__dirname, 'all_responses.json');
const CONTEXT_LIMIT = 5; // last 5 messages per chat
// ----------------------------------------

const client = new Client({
    authStrategy: new LocalAuth(),
    puppeteer: { headless: false }
});

// ---------------- MEMORY ----------------
let memory = fs.existsSync(MEMORY_FILE) ? JSON.parse(fs.readFileSync(MEMORY_FILE)) : {};
let allResponses = fs.existsSync(RESPONSES_FILE) ? JSON.parse(fs.readFileSync(RESPONSES_FILE)) : {};

// Ensure memory for each chat
function initChatMemory(chatId) {
    if(!memory[chatId]) memory[chatId] = [];
}

// Save memory & responses
function saveMemory() { fs.writeFileSync(MEMORY_FILE, JSON.stringify(memory, null, 2)); }
function saveAllResponses() { fs.writeFileSync(RESPONSES_FILE, JSON.stringify(allResponses, null, 2)); }

// ---------------- PREDEFINED REPLIES ----------------
function getPredefinedReply(text) {
    text = text.toLowerCase();
    if(text.includes('hello') || text.includes('hi')) return 'Hello! 👋';
    if(text.includes('how are you')) return "I'm just a bot, but I'm doing great! 😄";
    if(text.includes('good morning')) return 'Good morning! ☀️';
    if(text.includes('good night')) return 'Good night! 🌙';
    if(text.includes('thanks') || text.includes('thank you')) return "You're welcome! 😊";
    if(text.includes('bye') || text.includes('goodbye')) return 'Goodbye! 👋';
    return null;
}

// ---------------- AI REPLY ----------------
async function getAIReply(chatId, message) {
    initChatMemory(chatId);

    // Include last N messages for context
    const contextMessages = memory[chatId].slice(-CONTEXT_LIMIT).map(m => ({ role: 'user', content: m }));
    contextMessages.push({ role: 'user', content: message });

    try {
        const response = await openai.chat.completions.create({
            model: 'gpt-4',
            messages: contextMessages,
            temperature: 0.7
        });

        const reply = response.choices[0].message.content;

        // Save in memory
        memory[chatId].push(message);
        memory[chatId].push(reply);
        saveMemory();

        if(!allResponses[chatId]) allResponses[chatId] = [];
        allResponses[chatId].push({ message, reply, timestamp: new Date().toISOString() });
        saveAllResponses();

        return reply;
    } catch (error) {
        console.error('OpenAI error:', error);
        return "⚠️ Sorry, I couldn't process that.";
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
    let cleanMessage = message.body;

    if(isPrivate) {
        shouldRespond = true; // respond to all private messages
    } else if(isGroup) {
        // Trigger if message contains "Emponyoo,"
        const regex = new RegExp(`\\b${BOT_NAME}\\b[,\\s]*`, 'i');
        if(regex.test(message.body)) {
            shouldRespond = true;
            cleanMessage = message.body.replace(regex, '').trim();
        }
    }

    if(!shouldRespond) return;

    // Check predefined replies
    let reply = getPredefinedReply(cleanMessage);
    if(!reply) reply = await getAIReply(chatId, cleanMessage);

    if(reply) {
        // Typing simulation
        await new Promise(r => setTimeout(r, TYPING_DELAY_MS));
        await message.reply(reply);
    }
});

client.initialize();
