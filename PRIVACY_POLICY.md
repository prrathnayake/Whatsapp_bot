# Privacy Policy

_Last updated: October 2024_

This WhatsApp assistant ("the Bot") is designed to respect your privacy. The Bot only stores the information needed to provide contextually relevant replies and to maintain a list of predefined quick responses.

## Information We Collect

* **Conversation Logs:** For each chat, the Bot stores a rolling log of prompts and replies inside `all_responses.json`. Each entry includes the message content, the generated reply, the timestamp, and the reply source (predefined, memory lookup, OpenAI, or safety notice).
* **Predefined Responses:** The only data saved in `memory.json` is a curated list of predefined trigger phrases and their responses. No personal chat history is written to this file.

## How Information Is Used

The stored data allows the Bot to:

1. Provide short-term context for better answers.
2. Record which automated responses were used.
3. Offer safety tooling such as moderation and sensitive-pattern alerts.

The Bot does not share information with third parties beyond sending prompts to the configured OpenAI API for response generation and moderation.

## Data Retention

Conversation history is capped to a limited number of recent entries per chat. You can purge the stored history for a specific chat by sending the `!reset` command.

## Contact

If you have any questions about this policy, please open an issue in the project repository.
