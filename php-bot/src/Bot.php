<?php

namespace App;

use GuzzleHttp\Client;
use GuzzleHttp\Exception\GuzzleException;

class Bot
{
    private Client $graphClient;
    private Client $openAiClient;
    private string $openAiKey;
    private string $whatsappToken;
    private string $phoneNumberId;
    private string $botName;
    private string $commandPrefix;
    private string $systemPrompt;
    private array $memory;
    private array $generalReplies;
    private array $conversations;
    private array $responses;
    private string $conversationsPath;
    private string $responsesPath;

    private const CONTEXT_LIMIT = 12;
    private const MAX_RESPONSES_PER_CHAT = 100;

    public function __construct(array $config = [])
    {
        $basePath = $config['basePath'] ?? dirname(__DIR__);
        $dataPath = $basePath . '/data';
        $storagePath = $basePath . '/storage';

        $this->openAiKey = $config['openAiKey'] ?? getenv('OPENAI_API_KEY') ?: '';
        $this->whatsappToken = $config['whatsappToken'] ?? getenv('WHATSAPP_TOKEN') ?: '';
        $this->phoneNumberId = $config['phoneNumberId'] ?? getenv('WHATSAPP_PHONE_ID') ?: '';
        $this->botName = $config['botName'] ?? getenv('BOT_NAME') ?: 'Emponyoo';
        $this->commandPrefix = $config['commandPrefix'] ?? getenv('COMMAND_PREFIX') ?: '!';
        $this->systemPrompt = $config['systemPrompt'] ?? Config::DEFAULT_SYSTEM_PROMPT;

        if ($this->openAiKey === '') {
            throw new \RuntimeException('OPENAI_API_KEY is not configured.');
        }

        if ($this->whatsappToken === '' || $this->phoneNumberId === '') {
            throw new \RuntimeException('WhatsApp Cloud API credentials are missing.');
        }

        $this->graphClient = new Client([
            'base_uri' => 'https://graph.facebook.com/v18.0/',
            'timeout' => 15,
        ]);

        $this->openAiClient = new Client([
            'base_uri' => 'https://api.openai.com/v1/',
            'timeout' => 30,
        ]);

        $this->memory = JsonStore::load($dataPath . '/memory.json', ['predefinedResponses' => []]);
        $this->generalReplies = JsonStore::load($dataPath . '/general_responses.json', []);

        $this->conversationsPath = $storagePath . '/conversations.json';
        $this->responsesPath = $storagePath . '/responses.json';

        $this->conversations = JsonStore::load($this->conversationsPath, []);
        $this->responses = JsonStore::load($this->responsesPath, []);
    }

    public function handleWebhook(array $payload): void
    {
        if (!isset($payload['entry']) || !is_array($payload['entry'])) {
            return;
        }

        foreach ($payload['entry'] as $entry) {
            $changes = $entry['changes'] ?? [];
            foreach ($changes as $change) {
                $value = $change['value'] ?? [];
                $messages = $value['messages'] ?? [];
                foreach ($messages as $message) {
                    if (($message['type'] ?? '') !== 'text') {
                        continue;
                    }

                    $text = $message['text']['body'] ?? '';
                    $from = $message['from'] ?? null;
                    if ($from === null) {
                        continue;
                    }

                    $name = $this->extractContactName($value, $from);
                    $reply = $this->handleIncomingText($from, $name, $text);

                    if ($reply !== null) {
                        $this->sendWhatsAppMessage($from, $reply);
                    }
                }
            }
        }

        $this->persist();
    }

    private function handleIncomingText(string $chatId, string $name, string $text): ?string
    {
        $cleanMessage = trim($text);
        if ($cleanMessage === '') {
            return null;
        }

        $conversation = $this->conversations[$chatId] ?? [
            'history' => [],
            'quick_replies' => [],
            'message_count' => 0,
            'last_seen' => null,
        ];

        $conversation['message_count']++;
        $conversation['last_seen'] = time();
        $conversation['history'][] = ['role' => 'user', 'content' => $cleanMessage];
        $conversation['history'] = $this->trimHistory($conversation['history']);

        // Commands
        if ($this->isCommand($cleanMessage)) {
            $reply = $this->handleCommand($conversation, $chatId, $name, $cleanMessage);
            $this->recordReply($chatId, $cleanMessage, $reply, 'command', $conversation);
            return $reply;
        }

        // Memory / predefined replies
        if ($predefined = $this->matchPredefined($cleanMessage, $this->memory['predefinedResponses'] ?? [])) {
            $conversation['quick_replies'][] = $predefined;
            $conversation['quick_replies'] = array_slice($conversation['quick_replies'], -10);
            $reply = $predefined;
            $this->recordReply($chatId, $cleanMessage, $reply, 'memory', $conversation);
            return $reply;
        }

        if ($general = $this->matchPredefined($cleanMessage, $this->generalReplies)) {
            $conversation['quick_replies'][] = $general;
            $conversation['quick_replies'] = array_slice($conversation['quick_replies'], -10);
            $reply = $general;
            $this->recordReply($chatId, $cleanMessage, $reply, 'general', $conversation);
            return $reply;
        }

        $reply = $this->generateConversationalReply($conversation['history'], $name);
        if ($reply === null) {
            $reply = "I ran into a problem reaching OpenAI. Please try again soon.";
        }

        $this->recordReply($chatId, $cleanMessage, $reply, 'openai', $conversation);
        return $reply;
    }

    private function isCommand(string $message): bool
    {
        return str_starts_with(mb_strtolower($message), mb_strtolower($this->commandPrefix));
    }

    private function handleCommand(array &$conversation, string $chatId, string $name, string $message): string
    {
        $withoutPrefix = trim(mb_substr($message, mb_strlen($this->commandPrefix)));
        $parts = preg_split('/\s+/', $withoutPrefix, 2);
        $command = mb_strtolower($parts[0] ?? '');
        $argument = trim($parts[1] ?? '');

        switch ($command) {
            case 'help':
                return Config::HELP_TEXT;
            case 'reset':
                $this->resetConversation($chatId);
                $conversation = [
                    'history' => [],
                    'quick_replies' => [],
                    'message_count' => 0,
                    'last_seen' => time(),
                ];
                return 'Conversation history cleared. We can start fresh!';
            case 'history':
                return $this->summariseHistory($conversation['history']);
            case 'quickreplies':
                return $this->listQuickReplies($conversation['quick_replies'] ?? []);
            case 'policy':
                return Config::SAFETY_POLICY;
            case 'privacy':
                return Config::PRIVACY_SUMMARY;
            case 'stats':
                return $this->conversationStats($conversation);
            case 'songs':
                return $this->structuredList($argument, Config::SONGS_TEMPLATE, 'Provide 3-5 short bullet points with upbeat song suggestions relevant to the request.');
            case 'plan':
                return $this->structuredList($argument, Config::PLAN_TEMPLATE, 'Provide 3-5 concise steps the user can follow.');
            case 'meal':
                return $this->structuredList($argument, Config::MEAL_TEMPLATE, 'Suggest 3-5 quick meal or snack ideas that match the request.');
            case 'about':
                return sprintf("I'm %s, a PHP-powered WhatsApp assistant that chats using OpenAI.", $this->botName);
            default:
                return "I don't recognise that command. Try !help for options.";
        }
    }

    private function resetConversation(string $chatId): void
    {
        unset($this->conversations[$chatId]);
        unset($this->responses[$chatId]);
        $this->persist();
    }

    private function summariseHistory(array $history): string
    {
        $dialogue = array_filter($history, fn ($entry) => in_array($entry['role'], ['user', 'assistant'], true));
        if (empty($dialogue)) {
            return 'I do not have any saved context yet. Say hi to get started!';
        }

        $lines = array_map(function ($entry) {
            $role = $entry['role'] === 'assistant' ? 'Me' : 'You';
            return sprintf('%s: %s', $role, $entry['content']);
        }, array_slice($dialogue, -10));

        return "Recent context:\n" . implode("\n", $lines);
    }

    private function listQuickReplies(array $quickReplies): string
    {
        if (empty($quickReplies)) {
            return 'No quick replies yet — I will let you know when I spot a perfect match!';
        }

        $unique = array_values(array_unique($quickReplies));
        return "Quick replies I've shared recently:\n- " . implode("\n- ", $unique);
    }

    private function conversationStats(array $conversation): string
    {
        $count = $conversation['message_count'] ?? 0;
        $lastSeen = $conversation['last_seen'] ?? null;
        $lastSeenText = $lastSeen ? date('Y-m-d H:i', $lastSeen) : 'never';

        return sprintf(
            "We've exchanged %d message(s). Last activity: %s.",
            $count,
            $lastSeenText
        );
    }

    private function structuredList(string $topic, string $template, string $instruction): string
    {
        if ($topic === '') {
            return 'Please add a topic after the command, e.g. !songs focus or !plan exam prep.';
        }

        $messages = [
            ['role' => 'system', 'content' => $this->systemPrompt],
            ['role' => 'user', 'content' => sprintf('%s Topic: %s', $instruction, $topic)],
        ];

        $result = $this->requestChatCompletion($messages, 0.6);
        if ($result === null) {
            return 'I could not generate that list right now. Please try again later.';
        }

        return sprintf($template, $topic, $result);
    }

    private function matchPredefined(string $message, array $entries): ?string
    {
        $normalised = mb_strtolower($message);

        foreach ($entries as $entry) {
            $keywords = $entry['keywords'] ?? [];
            $response = $entry['response'] ?? null;
            if (!$keywords) {
                continue;
            }

            $responseText = '';
            if (is_array($response)) {
                $text = trim((string)($response['text'] ?? ''));
                $caption = trim((string)($response['caption'] ?? ''));
                if ($text !== '') {
                    $responseText = $text;
                } elseif ($caption !== '') {
                    $responseText = $caption;
                } elseif (!empty($response['stickerUrl'])) {
                    $responseText = '[sticker]';
                } elseif (!empty($response['mediaUrl'])) {
                    $responseText = '[media]';
                }
            } elseif (is_string($response)) {
                $responseText = trim($response);
            }

            if ($responseText === '') {
                continue;
            }

            foreach ($keywords as $keyword) {
                $keywordNormalised = mb_strtolower($keyword);
                if (str_contains($normalised, $keywordNormalised)) {
                    return $responseText;
                }
            }
        }

        return null;
    }

    private function generateConversationalReply(array $history, string $name): ?string
    {
        $messages = [
            ['role' => 'system', 'content' => $this->systemPrompt],
        ];

        foreach (array_slice($history, -self::CONTEXT_LIMIT) as $entry) {
            if (!isset($entry['role'], $entry['content'])) {
                continue;
            }

            $messages[] = $entry;
        }

        $messages[] = ['role' => 'system', 'content' => sprintf('The user is named %s.', $name)];

        return $this->requestChatCompletion($messages, 0.7);
    }

    private function requestChatCompletion(array $messages, float $temperature): ?string
    {
        try {
            $response = $this->openAiClient->post('chat/completions', [
                'headers' => [
                    'Authorization' => 'Bearer ' . $this->openAiKey,
                    'Content-Type' => 'application/json',
                ],
                'json' => [
                    'model' => 'gpt-4o-mini',
                    'messages' => $messages,
                    'temperature' => $temperature,
                ],
            ]);
        } catch (GuzzleException $exception) {
            error_log('OpenAI request failed: ' . $exception->getMessage());
            return null;
        }

        $data = json_decode((string) $response->getBody(), true);
        $content = $data['choices'][0]['message']['content'] ?? null;

        if (!is_string($content) || trim($content) === '') {
            return null;
        }

        return trim($content);
    }

    private function sendWhatsAppMessage(string $to, string $message): void
    {
        try {
            $this->graphClient->post($this->phoneNumberId . '/messages', [
                'headers' => [
                    'Authorization' => 'Bearer ' . $this->whatsappToken,
                    'Content-Type' => 'application/json',
                ],
                'json' => [
                    'messaging_product' => 'whatsapp',
                    'to' => $to,
                    'type' => 'text',
                    'text' => ['body' => $message],
                ],
            ]);
        } catch (GuzzleException $exception) {
            error_log('Failed to send WhatsApp message: ' . $exception->getMessage());
        }
    }

    private function recordReply(string $chatId, string $message, string $reply, string $source, array $conversation): void
    {
        $conversation['history'][] = ['role' => 'assistant', 'content' => $reply];
        $conversation['history'] = $this->trimHistory($conversation['history']);
        $this->conversations[$chatId] = $conversation;

        $log = $this->responses[$chatId] ?? [];
        $log[] = [
            'message' => $message,
            'reply' => $reply,
            'source' => $source,
            'timestamp' => date(DATE_ATOM),
        ];

        if (count($log) > self::MAX_RESPONSES_PER_CHAT) {
            $log = array_slice($log, -self::MAX_RESPONSES_PER_CHAT);
        }

        $this->responses[$chatId] = $log;
    }

    private function trimHistory(array $history): array
    {
        if (count($history) <= self::CONTEXT_LIMIT * 2) {
            return $history;
        }

        return array_slice($history, -self::CONTEXT_LIMIT * 2);
    }

    private function extractContactName(array $value, string $fallback): string
    {
        $contacts = $value['contacts'] ?? [];
        if (!empty($contacts[0]['profile']['name'])) {
            return $contacts[0]['profile']['name'];
        }

        return $fallback;
    }

    private function persist(): void
    {
        JsonStore::save($this->conversationsPath, $this->conversations);
        JsonStore::save($this->responsesPath, $this->responses);
    }
}
