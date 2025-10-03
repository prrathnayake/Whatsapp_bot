# Emponyoo WhatsApp Assistant (PHP Edition)

This folder contains a PHP reimplementation of the Emponyoo WhatsApp chatbot that runs on Hostinger (or any PHP 8.1+ host) by connecting to the [WhatsApp Cloud API](https://developers.facebook.com/docs/whatsapp). Conversations are generated with OpenAI's GPT models just like the Node.js version, but the runtime is now PHP-friendly.

## Features
- ✅ Handles incoming messages via the WhatsApp Cloud API webhook.
- 🤖 Generates AI replies with `gpt-4o-mini` while keeping a rolling conversation history per contact.
- 🧠 Shares predefined "quick reply" responses based on keyword matches.
- ⚙️ Supports the same command set as the Node.js bot (`!help`, `!reset`, `!history`, etc.).
- 🗃️ Stores chat history and response logs as JSON in the `storage/` directory.
- 🔐 Loads secrets from a `.env` file compatible with Hostinger's PHP environment.

## Getting started
1. **Install dependencies** (locally or on the server):
   ```bash
   composer install
   ```

2. **Configure environment variables.** Copy `.env.example` to `.env` and fill in:
   - `OPENAI_API_KEY` – your OpenAI key.
   - `WHATSAPP_TOKEN` – the permanent token from Meta's WhatsApp Cloud API.
   - `WHATSAPP_PHONE_ID` – the phone number ID from the WhatsApp app dashboard.
   - `VERIFY_TOKEN` – any string you also enter when registering the webhook.
   - `APP_URL` – the public URL of this PHP app (used only for documentation links).

3. **Expose the webhook endpoint.** Point the WhatsApp Cloud API webhook to:
   ```
   https://your-domain.example/php-bot/public/index.php
   ```
   When Meta validates the webhook, it sends a GET request that this script answers with the `hub.challenge` token.

4. **Keep storage writable.** The `storage/` directory must be writable by PHP so the bot can track history and logs.

5. **Send a WhatsApp message** to the configured number. Meta forwards it to the webhook, the bot replies via the Cloud API, and the conversation state is persisted in `storage/`.

## Folder structure
- `composer.json` – project dependencies and PSR-4 autoload rules.
- `data/` – predefined replies (`memory.json`, `general_responses.json`).
- `public/index.php` – webhook entry point you deploy to your PHP host.
- `src/` – PHP source (bot logic, config, utilities).
- `storage/` – writable folder for generated JSON logs (git keeps it with `.gitkeep`).

## Notes
- Hostinger's PHP plans allow long-running CLI processes via cron or worker scripts, but the WhatsApp Cloud API only needs an HTTPS webhook, so no background daemon is required.
- If you also use the Node.js version, keep the `.wwebjs_auth` folder on the Node server. The PHP edition relies solely on Meta's hosted session and does not use Puppeteer.
- For production you should configure HTTPS, request logging, and error monitoring according to your hosting provider's best practices.

Enjoy running Emponyoo on PHP! 🚀
