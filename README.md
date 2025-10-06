# Emponyoo WhatsApp Assistant

A feature-rich WhatsApp chatbot powered by the [whatsapp-web.js](https://github.com/pedroslopez/whatsapp-web.js) client and OpenAI's GPT models.

## Features

- 🤖 Conversational AI responses backed by `gpt-4o-mini` with configurable system prompt
- 💬 Rolling context memory per chat backed by a lightweight on-disk log
- 🧠 Memory-first answers for facts you previously shared before asking OpenAI
- ⚙️ Built-in bot commands (`!help`, `!reset`, `!history`, `!policy`, `!privacy`, `!stats`, `!songs`, `!plan`, `!meal`, `!about`)
- 🧩 Node.js microservices for chat, moderation, YouTube lookups, and image generation with a single orchestrated entry point
- 🙋‍♂️ Friendly predefined replies for common greetings and sentiments
- 🗃️ Local logging of all bot responses for later review
- 🔐 Automatic environment validation for the `OPENAI_API_KEY`
- 🛡️ Safety features including OpenAI moderation, sensitive data detection, and per-chat rate limiting
- 🎵 Instant YouTube song link discovery via `!songlink`
- 🖼️ Daily limited AI image generation via `!image`
- 🧾 Instant conversation recaps via `!summary`
- 🌐 On-demand message translation with `!translate`

## Getting Started

1. Install dependencies (already installed in this workspace):
   ```bash
   npm install
   ```
2. Create a `.env` file with your OpenAI API key:
   ```ini
   OPENAI_API_KEY=sk-your-key
   ```
3. Run the bot (this starts the microservices and the WhatsApp client):
   ```bash
   npm start
   ```
4. Scan the displayed QR code in WhatsApp to authorise the session.

### Deploying the PHP edition

If you need to stay on PHP-only hosting, use the rewritten bot in [`php-bot/`](./php-bot/README.md). It integrates with the official WhatsApp Cloud API instead of Puppeteer and can be deployed as a standard PHP webhook. Follow the README in that folder for composer installation, webhook verification, and environment variables.

To confirm the webhook behaves as expected without deploying it, you can run a lightweight check from the project root:

```bash
npm run check:php
```

The script starts PHP's built-in server, exercises the verification handshake, and posts a sample payload to ensure the endpoint responds just like the Node.js entry point.

## Commands

| Command    | Description |
|------------|-------------|
| `!help`    | Show available commands |
| `!reset`   | Clear the saved conversation context for the chat |
| `!history` | Summarise the most recent context that informs replies |
| `!quickreplies` | List the quick replies the bot has used in this chat |
| `!policy`  | Display the assistant's safety guidelines |
| `!privacy` | Explain what data is stored and how to clear it |
| `!stats`   | Share usage insights for the current chat |
| `!summary [focus]` | Summarise the recent conversation, optionally emphasising a topic |
| `!songs <mood or artist>` | Suggest a short list of matching songs |
| `!plan <goal or situation>` | Draft a quick plan for everyday tasks |
| `!meal <ingredients or dietary need>` | Offer speedy meal or recipe ideas |
| `!songlink <song name>` | Find the top YouTube result for a requested track |
| `!translate <language> <text>` | Translate a message into the chosen language |
| `!image <prompt>` | Generate an AI image (limited to a few per chat each day) |
| `!about`   | Learn about the bot |

## Data Files

- `memory.json`: curated list of predefined responses that the bot can answer instantly
- `all_responses.json`: rolling log of user prompts and bot replies (trimmed to the most recent 100 entries per chat)

Both files are written relative to `bot.js`. Configuration values (bot name, limits, etc.) live in `config.js` so you can tweak behaviour without editing the main bot file.

## Legal

- [MIT License](./LICENSE)
- [Privacy Policy](./PRIVACY_POLICY.md)
- [Terms of Service](./TERMS_OF_SERVICE.md)

## Development Notes

- The bot responds to all direct messages automatically.
- In group chats it replies only when mentioned by name (e.g. `Emponyoo, how are you?`).
- Typing indicators are simulated with a configurable delay (`TYPING_DELAY_MS`).

Feel free to customise the system prompt, command list, and pre-defined replies to fit your use case.
