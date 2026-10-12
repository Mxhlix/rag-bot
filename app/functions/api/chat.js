/**
 * Cloudflare Pages Function: POST /api/chat
 * 本番のチャットAPI本体。静的UI(public/index.html)から呼ばれる。
 *
 * 環境変数/シークレット（Cloudflare のダッシュボード or wrangler で設定。コードに直書きしない）:
 *   ACCESS_PASSPHRASE  … 社内限定アクセスの合言葉（必須。未設定時は "demo"）
 *   DEMO_MODE          … "false" にすると本番（Claude接続）。既定はデモ。
 *   CLAUDE_API_KEY     … 本番で必須。使う会社の Anthropic APIキー（従量課金はそのアカウントに発生）。
 *   CLAUDE_MODEL       … 省略時 claude-opus-4-8
 * バインディング:
 *   AI                 … 本番でベクトル化に使う Cloudflare Workers AI（wrangler.toml で有効化）
 *
 * ※ src/ を import して共通ハンドラを使う。src/documents.mjs を、使う会社の文書から生成した
 *    テキストに差し替えれば本番文書に切り替わる（README「本番への切り替え」参照）。
 */

import { handleChat } from '../../src/handler.mjs';

export async function onRequestPost(context) {
  const { request, env } = context;
  let payload = {};
  try {
    payload = await request.json();
  } catch {
    return Response.json({ error: 'JSONの形式が不正です。' }, { status: 400 });
  }

  const { status, body } = await handleChat({
    question: payload.question,
    passphrase: payload.passphrase,
    env,
  });

  return Response.json(body, { status });
}

// ヘルスチェック用（合言葉不要・機微情報を返さない）
export async function onRequestGet() {
  return Response.json({ ok: true, service: 'rag-bot', note: 'POST /api/chat で質問してください。' });
}
