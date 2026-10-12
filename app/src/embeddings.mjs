/**
 * 埋め込み（ベクトル化）の実装。
 *
 * 重要な事実:
 *   Anthropic の Claude API には「埋め込み専用エンドポイント」はありません（回答生成が役割）。
 *   そのため RAG の「検索」に使うベクトル化は、Claude とは別の手段で行います。本サンプルでは:
 *     - デモ:  通信せずローカルで生成する簡易ベクトル（文字bi-gramのハッシュ化TF）。APIキー不要。
 *     - 本番:  Cloudflare Workers AI の埋め込みモデル（例: @cf/baai/bge-m3 = 多言語対応）や、
 *              任意の埋め込みプロバイダに差し替え可能。ここが「本実装への差し替えポイント」。
 *
 *   軽量構成では、埋め込みを使わず後述の「語彙一致検索(lexical)」で構成することもできます
 *   （外部の埋め込みベンダーを増やさず、費用は Claude API のみに抑えられる）。標準構成では本ベクトル検索を使う。
 */

const DIM = 512;

/** 文字bi-gramに分解（日本語に相性が良い。faq-bot の類似度手法に準拠）。 */
function bigrams(text) {
  const s = String(text)
    .toLowerCase()
    .replace(/[Ａ-Ｚａ-ｚ０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/[\s、。，．・！？!?「」『』（）()【】\[\]\-—ー〜~:：;；"'`]/g, '');
  const grams = [];
  if (s.length <= 1) return s ? [s] : [];
  for (let i = 0; i < s.length - 1; i++) grams.push(s.slice(i, i + 2));
  return grams;
}

/** FNV-1a 32bit ハッシュ → 次元インデックス（ハッシュトリック）。 */
function hashBucket(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0) % DIM;
}

/** 1件のテキストを L2 正規化済みベクトルにする（通信なし・決定的）。 */
export function embedTextLocal(text) {
  const vec = new Float64Array(DIM);
  for (const g of bigrams(text)) vec[hashBucket(g)] += 1;
  let norm = 0;
  for (let i = 0; i < DIM; i++) norm += vec[i] * vec[i];
  norm = Math.sqrt(norm) || 1;
  for (let i = 0; i < DIM; i++) vec[i] /= norm;
  return Array.from(vec);
}

/** コサイン類似度（両者 L2 正規化済み前提なら内積）。 */
export function cosine(a, b) {
  let dot = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) dot += a[i] * b[i];
  return dot;
}

/** デモ用埋め込み器: 通信せずローカルでベクトル化（APIキー不要）。 */
export class DemoEmbedder {
  get name() {
    return 'demo-local-bigram';
  }
  async embed(texts) {
    return texts.map((t) => embedTextLocal(t));
  }
}

/**
 * 本番用埋め込み器: Cloudflare Workers AI の埋め込みモデルを使う。
 * Cloudflare Pages/Workers の `env.AI` バインディング（wrangler.toml で設定）が必要。
 * ここが「本実装への差し替えポイント」。別の埋め込みプロバイダに置き換える場合も
 * embed(texts) が「ベクトルの配列」を返す形さえ守れば、他は無改修で動きます。
 */
export class CloudflareEmbedder {
  constructor(env, model = '@cf/baai/bge-m3') {
    this.env = env;
    this.model = model;
  }
  get name() {
    return `cloudflare:${this.model}`;
  }
  async embed(texts) {
    if (!this.env || !this.env.AI) {
      throw new Error('Cloudflare AI バインディング(env.AI)が未設定です。wrangler.toml を確認してください。');
    }
    const res = await this.env.AI.run(this.model, { text: texts });
    // Workers AI の埋め込みレスポンスは { data: number[][] } 形式
    return res.data;
  }
}
