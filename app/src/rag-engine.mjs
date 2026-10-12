/**
 * RAG エンジン本体（移植可能なコア）。
 * 経路: 取り込み → 分割(チャンク) → 埋め込み → 検索(類似度) → 回答生成(出典付き)
 *
 * このモジュールは Node（ローカル検証・server.mjs）でも Cloudflare Pages Functions でも
 * そのまま使えるよう、外部依存を持たず、埋め込み器・生成器を「差し込み」で受け取ります。
 */

import { toChunks, SAMPLE_DOCUMENTS } from './documents.mjs';
import { cosine, embedTextLocal } from './embeddings.mjs';

/**
 * 文書からインデックスを構築する（チャンク化 → 埋め込み）。
 * @param {object} opts
 * @param {Array} opts.documents  文書配列（省略時はサンプル文書）
 * @param {{embed:(t:string[])=>Promise<number[][]>}} opts.embedder  埋め込み器
 * @returns {Promise<{ chunks: Array, vectors: number[][], embedderName: string }>}
 */
export async function buildIndex({ documents = SAMPLE_DOCUMENTS, embedder }) {
  const chunks = toChunks(documents);
  const vectors = await embedder.embed(chunks.map((c) => c.text));
  return { chunks, vectors, embedderName: embedder.name || 'unknown' };
}

/**
 * ベクトル検索: 質問ベクトルと各チャンクのコサイン類似度で上位を返す。
 *   - threshold: 絶対しきい値。これ未満は「該当なし」とし、無理に答えない（断りの根拠）。
 *   - relRatio:  相対カットオフ。最上位スコア × relRatio 未満の弱い候補を出典から落とし、
 *                無関係な文書を出典として並べないようにする（出典の質を保つ）。
 * @returns {Array<{ ...chunk, score }>}
 */
export async function retrieve({ index, embedder, question, topK = 4, threshold = 0.12, relRatio = 0.6 }) {
  const [qVec] = await embedder.embed([question]);
  const scored = index.chunks.map((c, i) => ({ ...c, score: cosine(qVec, index.vectors[i]) }));
  scored.sort((a, b) => b.score - a.score);
  const above = scored.filter((c) => c.score >= threshold);
  if (above.length === 0) return [];
  const cutoff = above[0].score * relRatio;
  return above.filter((c) => c.score >= cutoff).slice(0, topK);
}

/**
 * 語彙一致検索(lexical)。埋め込み器を使わずに動く（軽量構成/フォールバック用）。
 * 文字bi-gramの重なりで素朴にスコアリングする。
 */
export function retrieveLexical({ chunks, question, topK = 3, threshold = 0.08 }) {
  const qGrams = new Set(
    String(question)
      .toLowerCase()
      .replace(/[\s、。，．・！？!?「」『』（）()【】\[\]]/g, '')
      .match(/.{2}/g) || []
  );
  if (qGrams.size === 0) return [];
  const scored = chunks.map((c) => {
    const cGrams = String(c.text).match(/.{2}/g) || [];
    let hits = 0;
    const seen = new Set();
    for (const g of cGrams) {
      if (qGrams.has(g) && !seen.has(g)) {
        hits++;
        seen.add(g);
      }
    }
    return { ...c, score: hits / qGrams.size };
  });
  scored.sort((a, b) => b.score - a.score);
  return scored.filter((c) => c.score >= threshold).slice(0, topK);
}

/** 該当チャンクから、購入者可視の「出典」を組み立てる。 */
function toCitations(contexts) {
  return contexts.map((c) => ({
    document: c.docTitle,
    location: c.section,
    score: Number(c.score.toFixed(3)),
  }));
}

/**
 * 質問に答える（検索→生成→出典）。RAG の 1 サイクル全体。
 * @param {object} opts
 * @param {object} opts.index      buildIndex の結果
 * @param {object} opts.embedder   埋め込み器（demo / cloudflare）
 * @param {object} opts.generator  生成器（demo / claude）
 * @param {string} opts.question   質問
 * @returns {Promise<{ answer, grounded, citations, retrieved, mode }>}
 */
export async function answerQuestion({ index, embedder, generator, question, topK = 4, threshold = 0.12, relRatio = 0.6 }) {
  const q = String(question || '').trim();
  if (!q) {
    return { answer: '質問が空です。', grounded: false, citations: [], retrieved: [], mode: generator.mode };
  }
  const contexts = await retrieve({ index, embedder, question: q, topK, threshold, relRatio });
  const { answer, grounded } = await generator.generate({ question: q, contexts });
  // 該当箇所が無い、または生成側が根拠なしと判断した場合、出典は付けない（＝裏取り不可を明示）。
  const citations = grounded && contexts.length > 0 ? toCitations(contexts) : [];
  return {
    answer,
    grounded: grounded && contexts.length > 0,
    citations,
    retrieved: contexts.map((c) => ({ document: c.docTitle, location: c.section, score: Number(c.score.toFixed(3)) })),
    mode: generator.mode,
  };
}

// 直接 import される可能性のあるユーティリティを再輸出
export { toChunks, SAMPLE_DOCUMENTS, embedTextLocal, cosine };
