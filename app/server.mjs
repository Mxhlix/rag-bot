/**
 * ローカル検証用サーバ（Cloudflare 不要・ログイン不要・APIキー不要）。
 * 目的: デモモードのRAGを、実際のHTTP経由（チャットUI + /api/chat）で確認するため。
 *
 * 使い方:
 *   node server.mjs        → http://localhost:8787 でチャットUIが開く
 *   （合言葉の既定は "demo"。環境変数 ACCESS_PASSPHRASE で変更可）
 *
 * 本番の実体は functions/api/chat.js（Cloudflare Pages Function）で、同じ src/ を使います。
 */

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { handleChat } from './src/handler.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 8787);

// このローカルサーバは常にデモモードで動く（APIキー不要で挙動を見せるため）。
const ENV = {
  DEMO_MODE: 'true',
  ACCESS_PASSPHRASE: process.env.ACCESS_PASSPHRASE || 'demo',
};

function send(res, status, body, type = 'application/json; charset=utf-8') {
  res.writeHead(status, { 'content-type': type });
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
}

async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  return Buffer.concat(chunks).toString('utf8');
}

const server = createServer(async (req, res) => {
  try {
    if (req.method === 'POST' && req.url === '/api/chat') {
      const raw = await readBody(req);
      let payload = {};
      try {
        payload = JSON.parse(raw || '{}');
      } catch {
        return send(res, 400, { error: 'JSONの形式が不正です。' });
      }
      const { status, body } = await handleChat({
        question: payload.question,
        passphrase: payload.passphrase,
        env: ENV,
      });
      return send(res, status, body);
    }

    if (req.method === 'GET' && (req.url === '/' || req.url === '/index.html')) {
      const html = await readFile(join(__dirname, 'public', 'index.html'), 'utf8');
      return send(res, 200, html, 'text/html; charset=utf-8');
    }

    return send(res, 404, { error: 'not found' });
  } catch (e) {
    // 文書内容や回答本文はログに残さない（メッセージのみ）。
    return send(res, 500, { error: 'サーバ内部エラー: ' + (e && e.message ? e.message : 'unknown') });
  }
});

server.listen(PORT, () => {
  console.log(`[rag-bot demo] listening on http://localhost:${PORT}  (DEMO_MODE, passphrase="${ENV.ACCESS_PASSPHRASE}")`);
});
