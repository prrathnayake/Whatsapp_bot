#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const SERVER_HOST = '127.0.0.1';
const SERVER_PORT = 9030;
const BASE_URL = `http://${SERVER_HOST}:${SERVER_PORT}`;

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));

function withTimeout(operation, ms, description) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), ms);
  return operation(controller.signal)
    .finally(() => clearTimeout(timeout))
    .catch((error) => {
      if (error.name === 'AbortError') {
        throw new Error(`${description} timed out after ${ms}ms`);
      }
      throw error;
    });
}

async function waitForServer(url, attempts = 15, backoffMs = 200) {
  for (let i = 0; i < attempts; i += 1) {
    try {
      await withTimeout(
        (signal) => fetch(url, { method: 'GET', signal }),
        1500,
        'Server readiness check',
      );
      return;
    } catch (error) {
      if (i === attempts - 1) {
        throw new Error(`PHP server did not start: ${error.message}`);
      }
      await delay(backoffMs);
    }
  }
}

async function expectResponse(request, expectation) {
  const response = await request();
  const bodyText = await response.text();
  if (response.status !== expectation.status) {
    throw new Error(
      `${expectation.name} expected status ${expectation.status} but got ${response.status} (body: ${bodyText})`,
    );
  }
  if (expectation.body !== undefined && bodyText.trim() !== expectation.body) {
    throw new Error(
      `${expectation.name} expected body "${expectation.body}" but received "${bodyText.trim()}"`,
    );
  }
  if (expectation.jsonPredicate) {
    let parsed;
    try {
      parsed = JSON.parse(bodyText || '{}');
    } catch (error) {
      throw new Error(`${expectation.name} response was not valid JSON: ${error.message}`);
    }
    if (!expectation.jsonPredicate(parsed)) {
      throw new Error(`${expectation.name} JSON validation failed: ${bodyText}`);
    }
  }
}

async function runChecks() {
  const env = {
    ...process.env,
    OPENAI_API_KEY: process.env.OPENAI_API_KEY || 'test-openai-key',
    WHATSAPP_TOKEN: process.env.WHATSAPP_TOKEN || 'test-whatsapp-token',
    WHATSAPP_PHONE_ID: process.env.WHATSAPP_PHONE_ID || '123456789',
    VERIFY_TOKEN: process.env.VERIFY_TOKEN || 'verification-secret',
  };

  const phpProcess = spawn(
    'php',
    ['-S', `${SERVER_HOST}:${SERVER_PORT}`, '-t', 'php-bot/public'],
    {
      cwd: REPO_ROOT,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );

  const serverLogs = [];
  phpProcess.stderr.on('data', (chunk) => {
    serverLogs.push(chunk.toString());
  });

  const cleanup = () => {
    if (!phpProcess.killed) {
      phpProcess.kill();
    }
  };

  process.on('SIGINT', () => {
    cleanup();
    process.exit(1);
  });

  try {
    await waitForServer(`${BASE_URL}/index.php`);

    await expectResponse(
      () => fetch(
        `${BASE_URL}/index.php?hub.mode=subscribe&hub.verify_token=${encodeURIComponent(env.VERIFY_TOKEN)}&hub.challenge=test-challenge`,
        { method: 'GET' },
      ),
      {
        name: 'Webhook verification',
        status: 200,
        body: 'test-challenge',
      },
    );

    await expectResponse(
      () => fetch(
        `${BASE_URL}/index.php?hub.mode=subscribe&hub.verify_token=wrong-token&hub.challenge=test-challenge`,
        { method: 'GET' },
      ),
      {
        name: 'Invalid verification',
        status: 403,
        body: 'Invalid verify token.',
      },
    );

    await expectResponse(
      () => fetch(`${BASE_URL}/index.php`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ entry: [] }),
      }),
      {
        name: 'Empty webhook payload',
        status: 200,
        jsonPredicate: (json) => json.status === 'ok',
      },
    );

    console.log('✅ PHP webhook responded as expected.');
  } catch (error) {
    console.error('❌ PHP webhook check failed:', error.message);
    if (serverLogs.length) {
      console.error('Server output:\n', serverLogs.join(''));
    }
    process.exitCode = 1;
  } finally {
    cleanup();
  }
}

runChecks();
