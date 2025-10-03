# Emponyoo WhatsApp Assistant

A feature-rich WhatsApp chatbot powered by the [whatsapp-web.js](https://github.com/pedroslopez/whatsapp-web.js) client and OpenAI's GPT models.

## Features

- 🤖 Conversational AI responses backed by `gpt-4o-mini` with configurable system prompt
- 💬 Rolling context memory per chat (persisted to disk with auto-trimming)
- 🧠 Memory-first answers for facts you previously shared before asking OpenAI
- ⚙️ Built-in bot commands (`!help`, `!reset`, `!history`, `!policy`, `!privacy`, `!stats`, `!about`)
- 🙋‍♂️ Friendly predefined replies for common greetings and sentiments
- 🗃️ Local logging of all bot responses for later review
- 🔐 Automatic environment validation for the `OPENAI_API_KEY`
- 🛡️ Safety features including OpenAI moderation, sensitive data detection, and per-chat rate limiting

## Getting Started

1. Install dependencies (already installed in this workspace):
   ```bash
   npm install
   ```
2. Create a `.env` file with your OpenAI API key:
   ```ini
   OPENAI_API_KEY=sk-your-key
   ```
3. Run the bot:
   ```bash
   node bot.js
   ```
4. Scan the displayed QR code in WhatsApp to authorise the session.

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
| `!about`   | Learn about the bot |

## Data Files

- `memory.json`: per-chat rolling conversation history and remembered quick replies
- `all_responses.json`: log of user prompts and bot replies (trimmed to the most recent 100 entries per chat)

Both files are written relative to `bot.js`. They are automatically created when the bot first runs.

## Development Notes

- The bot responds to all direct messages automatically.
- In group chats it replies only when mentioned by name (e.g. `Emponyoo, how are you?`).
- Typing indicators are simulated with a configurable delay (`TYPING_DELAY_MS`).

Feel free to customise the system prompt, command list, and pre-defined replies to fit your use case.
