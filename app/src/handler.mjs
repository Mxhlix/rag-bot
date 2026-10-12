/**
 * チャットAPIの共通ハンドラ。
 * ローカル検証サーバ（server.mjs）と Cloudflare Pages Function（functions/api/chat.js）の両方が使う。
 *
 * セキュリティ方針:
 *   - 合言葉(社内限定アクセス)を検証してから回答する。合言葉・APIキーはコードに直書きしない。
 *   - 文書内容・回答本文をログに残さない（ログには件数・モードなど非機微情報のみ）。
 *   - モード選択: DEMO_MODE=true もしくは APIキー未設定なら通信しないデモ、
 *                DEMO_MODE=false かつ APIキーありなら実 Claude + 実埋め込み。
 */

import { DemoEmbedder, CloudflareEmbedder } from './embeddings.mjs';
import { DemoGenerator, ClaudeGenerator } from './generate.mjs';
import { buildIndex, answerQuestion } from './rag-engine.mjs';

// isolate/プロセスごとにインデックスを使い回す（埋め込み器名でキャッシュ）。
const _indexCache = new Map();

/** タイミング差を抑えた文字列一致（低リスク用途の簡易実装）。 */
function safeEqual(a, b) {
  a = String(a || '');
  b = String(b || '');
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function isDemo(env) {
  // 既定はデモ。明示的に DEMO_MODE=false かつ APIキーがある場合だけ本番。
  const flag = String(env.DEMO_MODE ?? 'true').toLowerCase();
  const hasKey = !!env.CLAUDE_API_KEY;
  return flag !== 'false' || !hasKey;
}

async function getIndex(env, embedder) {
  const key = embedder.name;
  if (_indexCache.has(key)) return _indexCache.get(key);
  const index = await buildIndex({ embedder });
  _indexCache.set(key, index);
  return index;
}

/**
 * チャット1件を処理する。
 * @param {object} args
 * @param {string} args.question   質問文
 * @param {string} args.passphrase 送られてきた合言葉
 * @param {object} args.env        環境変数/シークレット {ACCESS_PASSPHRASE, DEMO_MODE, CLAUDE_API_KEY, AI(埋め込みバインディング)}
 * @returns {Promise<{ status:number, body:object }>}
 */
export async function handleChat({ question, passphrase, env }) {
  // 1) 合言葉チェック（社内限定アクセス）
  const expected = env.ACCESS_PASSPHRASE || 'demo';
  if (!safeEqual(passphrase, expected)) {
    return { status: 401, body: { error: '合言葉が違います。' } };
  }

  // 2) 入力バリデーション
  const q = String(question || '').trim();
  if (!q) return { status: 400, body: { error: '質問を入力してください。' } };
  if (q.length > 2000) return { status: 400, body: { error: '質問が長すぎます（2000文字まで）。' } };

  // 3) モード選択と実行
  const demo = isDemo(env);
  const embedder = demo ? new DemoEmbedder() : new CloudflareEmbedder(env);
  const generator = demo
    ? new DemoGenerator()
    : new ClaudeGenerator({ apiKey: env.CLAUDE_API_KEY, model: env.CLAUDE_MODEL || 'claude-opus-4-8' });

  const index = await getIndex(env, embedder);
  const result = await answerQuestion({ index, embedder, generator, question: q });

  return {
    status: 200,
    body: {
      mode: result.mode, // 'demo' | 'claude'
      grounded: result.grounded,
      answer: result.answer,
      citations: result.citations, // [{ document, location, score }]
    },
  };
}
