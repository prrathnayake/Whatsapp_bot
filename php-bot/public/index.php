<?php

declare(strict_types=1);

use App\Bot;
use Dotenv\Dotenv;

require_once dirname(__DIR__) . '/vendor/autoload.php';

$root = dirname(__DIR__);
if (file_exists($root . '/.env')) {
    Dotenv::createImmutable($root)->safeLoad();
}

$verifyToken = getenv('VERIFY_TOKEN') ?: '';

if ($_SERVER['REQUEST_METHOD'] === 'GET') {
    $mode = $_GET['hub_mode'] ?? $_GET['hub.mode'] ?? '';
    $token = $_GET['hub_verify_token'] ?? $_GET['hub.verify_token'] ?? '';
    $challenge = $_GET['hub_challenge'] ?? $_GET['hub.challenge'] ?? '';

    if ($mode === 'subscribe' && $token === $verifyToken && $verifyToken !== '') {
        http_response_code(200);
        echo $challenge;
    } else {
        http_response_code(403);
        echo 'Invalid verify token.';
    }

    return;
}

$raw = file_get_contents('php://input');
$payload = json_decode($raw ?: '[]', true) ?? [];

try {
    $bot = new Bot(['basePath' => $root]);
    $bot->handleWebhook($payload);

    http_response_code(200);
    header('Content-Type: application/json');
    echo json_encode(['status' => 'ok']);
} catch (Throwable $exception) {
    error_log('Webhook handling failed: ' . $exception->getMessage());
    http_response_code(500);
    header('Content-Type: application/json');
    echo json_encode(['error' => 'internal_error']);
}
