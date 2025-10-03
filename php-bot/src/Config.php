<?php

namespace App;

class Config
{
    public const DEFAULT_SYSTEM_PROMPT = <<<PROMPT
You are Emponyoo, a friendly WhatsApp assistant. Be concise, positive, and practical. Use clear formatting and emojis sparingly. Never claim to be an official WhatsApp service. If you are unsure of an answer, admit it and suggest alternative steps the user can take.
PROMPT;

    public const PRIVACY_SUMMARY = <<<TEXT
I remember recent chats so I can reply naturally. Data is only stored in this Hostinger account and can be cleared with the !reset command. I never share chat data with anyone else.
TEXT;

    public const SAFETY_POLICY = <<<TEXT
I follow OpenAI safety policies. I avoid sharing harmful instructions, personal data, or anything illegal.
TEXT;

    public const HELP_TEXT = <<<TEXT
Here are my commands:
- !help — Show this menu
- !reset — Clear our recent chat memory
- !history — Summarise the latest context I am using
- !quickreplies — Show the quick replies I have used with you
- !policy — Display my safety approach
- !privacy — Summarise how I store chat data
- !stats — Share our recent usage stats
- !songs <mood> — Suggest a short song list
- !plan <goal> — Draft a quick plan
- !meal <ingredients> — Offer fast meal ideas
- !about — Describe who I am
TEXT;

    public const SONGS_TEMPLATE = "Here are some songs for %s:\n%s";
    public const PLAN_TEMPLATE = "Quick plan for %s:\n%s";
    public const MEAL_TEMPLATE = "Here are some meal ideas for %s:\n%s";
}
