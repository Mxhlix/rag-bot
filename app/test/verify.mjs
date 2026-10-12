/**
 * 合格条件の自動検証（合格条件1〜4に対応）。
 *   node test/verify.mjs   → 全項目 PASS で exit 0、失敗があれば exit 1
 * APIキー不要（デモモードでRAGの全経路を通す）。
 */

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { handleChat } from '../src/handler.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');

let pass = 0;
let fail = 0;
function ok(name, cond, detail = '') {
  if (cond) {
    pass++;
    console.log(`  PASS  ${name}`);
  } else {
    fail++;
    console.log(`  FAIL  ${name}${detail ? '  → ' + detail : ''}`);
  }
}

const DEMO_ENV = { DEMO_MODE: 'true', ACCESS_PASSPHRASE: 'demo' };
const chat = (question, passphrase = 'demo') => handleChat({ question, passphrase, env: DEMO_ENV });

console.log('\n=== rag-bot 実演サンプル 検証 ===\n');

// ---- 条件1: 文書に答えのある質問 → 出典（文書名・該当箇所）付きで回答 ----
console.log('[1] 文書内の質問に、出典付きで回答する');
{
  const r = await chat('有給休暇は何日もらえますか？');
  ok('HTTPステータス200', r.status === 200, `status=${r.status}`);
  ok('grounded=true（根拠あり）', r.body.grounded === true);
  ok('回答に「10日」を含む', /10\s*日/.test(r.body.answer), r.body.answer);
  ok('出典が1件以上', (r.body.citations || []).length >= 1);
  const cited = (r.body.citations || []).some(
    (c) => c.document.includes('就業規則') && c.location.includes('第22条')
  );
  ok('出典が 就業規則 第22条 を指す', cited, JSON.stringify(r.body.citations));
}

console.log('\n[1b] 別の文書（経費規程）でも出典付きで回答する');
{
  const r = await chat('出張の宿泊費の上限は？');
  ok('grounded=true', r.body.grounded === true);
  ok('回答に金額(12,000 か 9,000)を含む', /12,?000|9,?000/.test(r.body.answer), r.body.answer);
  const cited = (r.body.citations || []).some((c) => c.document.includes('経費') && c.location.includes('第8条'));
  ok('出典が 経費規程 第8条 を指す', cited, JSON.stringify(r.body.citations));
}

// ---- 条件2: 文書に無い質問 → 無理に答えず「見つからない」旨、出典なし ----
console.log('\n[2] 文書に載っていない質問は、断って出典を付けない');
{
  const r = await chat('来週の東京の天気を教えてください。');
  ok('grounded=false（根拠なし）', r.body.grounded === false);
  ok('出典は0件', (r.body.citations || []).length === 0, JSON.stringify(r.body.citations));
  ok('「見つかりません」旨を返す', /見つかりません|見つかりませんでした/.test(r.body.answer), r.body.answer);
}

// ---- 合言葉ゲート（社内限定アクセス）----
console.log('\n[合言葉] 誤った合言葉は401で拒否する');
{
  const r = await chat('有給休暇は何日？', 'wrong-pass');
  ok('誤合言葉で401', r.status === 401, `status=${r.status}`);
  const rok = await chat('有給休暇は何日？', 'demo');
  ok('正しい合言葉で200', rok.status === 200);
}

// ---- 条件3: 本実装への差し替えポイントが存在する ----
console.log('\n[3] APIキー差し替えで実Claudeになる「差し替えポイント」がコード上に明示されている');
{
  const gen = await readFile(join(root, 'src', 'generate.mjs'), 'utf8');
  ok('ClaudeGenerator が定義されている', /class\s+ClaudeGenerator/.test(gen));
  ok('モデルIDが claude-opus-4-8（日付サフィックス無し）', /claude-opus-4-8/.test(gen) && !/claude-opus-4-8-\d/.test(gen));
  ok('Messagesエンドポイントを呼ぶ', /api\.anthropic\.com\/v1\/messages/.test(gen));
  ok('anthropic-version ヘッダを送る', /anthropic-version/.test(gen) && /2023-06-01/.test(gen));
  const emb = await readFile(join(root, 'src', 'embeddings.mjs'), 'utf8');
  ok('本番埋め込み器 CloudflareEmbedder が定義されている', /class\s+CloudflareEmbedder/.test(emb));
  const handler = await readFile(join(root, 'src', 'handler.mjs'), 'utf8');
  ok('DEMO_MODE と APIキーでモードを切り替える', /DEMO_MODE/.test(handler) && /CLAUDE_API_KEY/.test(handler));
  ok('APIキー等をコードに直書きしていない（環境変数から取得）', !/sk-ant-[a-z0-9]/i.test(gen + emb + handler));
}

// ---- 条件4: README に出典・機密取扱い・公開手順がある ----
console.log('\n[4] README に サンプル文書の出典/利用可否・機密取扱い・公開手順 が書かれている');
{
  const readme = await readFile(join(root, 'README.md'), 'utf8');
  ok('サンプル文書の出典/利用可否の記載', /出典|利用可否|架空|オリジナル/.test(readme));
  ok('機密文書の取扱いポリシーの記載', /機密|データベース|学習/.test(readme));
  ok('公開手順（Cloudflare / デプロイ）の記載', /Cloudflare|デプロイ|wrangler|公開手順/.test(readme));
  ok('合言葉・APIキー設定手順の記載', /合言葉|ACCESS_PASSPHRASE/.test(readme) && /CLAUDE_API_KEY/.test(readme));
}

console.log(`\n=== 結果: ${pass} PASS / ${fail} FAIL ===\n`);
process.exit(fail === 0 ? 0 : 1);
