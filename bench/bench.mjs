import fs from 'node:fs';
import { DOCS, toChunks } from './corpus.mjs';
import { QUESTIONS, NOANSWER } from './questions.mjs';

const KEY = process.env.GEMINI_API_KEY;
if (!KEY) { console.error('GEMINI_API_KEY を環境変数に設定してください'); process.exit(1); }
const EMB = 'gemini-embedding-001';
const GEN = 'gemini-flash-lite-latest';
const CHUNKS = toChunks();
const DIM = 768;

// ---------- 文字bi-gram（現行デモ＝ベーシック相当の検索） ----------
function bigrams(t) {
  const s = String(t).toLowerCase().replace(/[\s、。，．・！？!?「」『』（）()【】\[\]\-—ー〜~:：;；"'`]/g, '');
  const g = []; for (let i = 0; i < s.length - 1; i++) g.push(s.slice(i, i + 2)); return g;
}
function hashB(str) { let h = 0x811c9dc5; for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193); } return (h >>> 0) % 512; }
function lexVec(t) {
  const v = new Float64Array(512); for (const g of bigrams(t)) v[hashB(g)] += 1;
  let n = 0; for (let i = 0; i < 512; i++) n += v[i] * v[i]; n = Math.sqrt(n) || 1;
  return Array.from(v, (x) => x / n);
}
const cos = (a, b) => { let d = 0; for (let i = 0; i < Math.min(a.length, b.length); i++) d += a[i] * b[i]; return d; };

// ---------- Gemini ----------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function api(url, body, tries = 5) {
  for (let i = 0; i < tries; i++) {
    const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    if (r.ok) return r.json();
    const txt = await r.text();
    if (r.status === 429 || r.status >= 500) { await sleep(4000 * (i + 1)); continue; }
    throw new Error(`${r.status} ${txt.slice(0, 200)}`);
  }
  throw new Error('retry exhausted');
}
async function embedMany(texts, taskType) {
  const out = [];
  for (let i = 0; i < texts.length; i += 20) {
    const batch = texts.slice(i, i + 20);
    const j = await api(`https://generativelanguage.googleapis.com/v1beta/models/${EMB}:batchEmbedContents?key=${KEY}`, {
      requests: batch.map((t) => ({ model: `models/${EMB}`, content: { parts: [{ text: t }] }, taskType, outputDimensionality: DIM })),
    });
    out.push(...j.embeddings.map((e) => e.values));
    await sleep(700);
  }
  return out;
}
async function gen(prompt) {
  const j = await api(`https://generativelanguage.googleapis.com/v1beta/models/${GEN}:generateContent?key=${KEY}`, {
    contents: [{ parts: [{ text: prompt }] }], generationConfig: { temperature: 0, maxOutputTokens: 8192 },
  });
  return j.candidates?.[0]?.content?.parts?.map((p) => p.text).join('') ?? '';
}

// ---------- キャッシュ ----------
const CACHE = './cache.json';
const cache = fs.existsSync(CACHE) ? JSON.parse(fs.readFileSync(CACHE, 'utf8')) : {};
const save = () => fs.writeFileSync(CACHE, JSON.stringify(cache));
async function cached(k, fn) { if (cache[k] !== undefined) return cache[k]; const v = await fn(); cache[k] = v; save(); return v; }

// ---------- 検索構成 ----------
const rank = (scores) => scores.map((s, i) => ({ i, s })).sort((a, b) => b.s - a.s);

function lexRank(q) { const qv = lexVec(q); return rank(CHUNKS.map((c) => cos(qv, lexVec(c.text)))); }
function semRank(qv, dv) { return rank(dv.map((v) => cos(qv, v))); }
function rrf(a, b, k = 60) {
  const m = new Map();
  a.forEach((x, r) => m.set(x.i, (m.get(x.i) || 0) + 1 / (k + r + 1)));
  b.forEach((x, r) => m.set(x.i, (m.get(x.i) || 0) + 1 / (k + r + 1)));
  return [...m].map(([i, s]) => ({ i, s })).sort((x, y) => y.s - x.s);
}

const REWRITE = (q) => `社内文書を検索するための質問を書き換えます。次の職員の質問を、就業規則・規程・マニュアルで使われる正式な用語に置き換えた検索文にしてください。省略語は正式名称に開き、質問の意図は変えないでください。検索文だけを1行で出力してください。\n\n質問: ${q}`;
const RERANK = (q, cands) => `質問に対して、実際に答えが書かれている箇所だけを選びます。\n\n質問: ${q}\n\n候補:\n${cands.map((c, n) => `[${n + 1}] ${c.section}（${c.docTitle}）\n${c.text}`).join('\n\n')}\n\n候補のうち、この質問の答えが実際に書かれているものの番号を、確からしい順に最大4つ、カンマ区切りの数字だけで出力してください。どれにも書かれていない場合は none とだけ出力してください。`;
const ANSWER = (q, cands) => `あなたは社内文書に基づいて答えるアシスタントです。以下の抜粋に書かれていることだけを根拠に答えてください。抜粋に答えが無い場合は、推測せず「該当する記載が見つかりません」とだけ答えてください。\n\n質問: ${q}\n\n抜粋:\n${cands.map((c) => `【${c.section}／${c.docTitle}】\n${c.text}`).join('\n\n')}\n\n回答（2〜3文。根拠にした箇所を末尾に「出典: 」として書く）:`;

// ---------- 実行 ----------
const docVecs = await cached('docvecs', () => embedMany(CHUNKS.map((c) => c.text), 'RETRIEVAL_DOCUMENT'));
console.log(`チャンク数: ${CHUNKS.length} / 文書数: ${DOCS.length}`);

const ALL = [...QUESTIONS.map((x) => ({ ...x, type: 'ans' })), ...NOANSWER.map((x) => ({ ...x, gold: null, keys: [], type: 'no' }))];
const qVecs = await cached('qvecs', () => embedMany(ALL.map((x) => x.q), 'RETRIEVAL_QUERY'));

// 書き換え済みクエリ
const rewritten = [];
for (const [n, x] of ALL.entries()) rewritten.push(await cached(`rw:${n}`, () => gen(REWRITE(x.q)).then((t) => t.trim().split('\n')[0])));
const rwVecs = await cached('rwvecs', () => embedMany(rewritten, 'RETRIEVAL_QUERY'));

const TOPK = 4, WIDE = 20;
const results = {};
const configs = ['A_言葉の重なりのみ', 'B_意味検索', 'C_意味+質問書き換え', 'D_意味+選び直し', 'E_意味+言葉の重なり'];
for (const c of configs) results[c] = { hit: 0, top1: 0, picks: [] };

for (const [n, x] of ALL.entries()) {
  const lr = lexRank(x.q);
  const sr = semRank(qVecs[n], docVecs);
  const rr = semRank(rwVecs[n], docVecs);
  const hy = rrf(sr, lr);

  const sets = {
    'A_言葉の重なりのみ': lr.slice(0, TOPK).map((z) => z.i),
    'B_意味検索': sr.slice(0, TOPK).map((z) => z.i),
    'C_意味+質問書き換え': rr.slice(0, TOPK).map((z) => z.i),
    'E_意味+言葉の重なり': hy.slice(0, TOPK).map((z) => z.i),
  };
  // D: 意味で広く取ってAIが選び直す
  const wide = sr.slice(0, WIDE).map((z) => z.i);
  const rtxt = await cached(`rr:${n}`, () => gen(RERANK(x.q, wide.map((i) => CHUNKS[i]))));
  const picked = /none/i.test(rtxt) ? [] : (rtxt.match(/\d+/g) || []).map(Number).filter((v) => v >= 1 && v <= wide.length).slice(0, TOPK).map((v) => wide[v - 1]);
  sets['D_意味+選び直し'] = picked;

  for (const [cfg, ids] of Object.entries(sets)) {
    const names = ids.map((i) => CHUNKS[i].id);
    results[cfg].picks.push({ q: x.q, type: x.type, gold: x.gold, got: names });
    if (x.type === 'ans') { if (names.includes(x.gold)) results[cfg].hit++; if (names[0] === x.gold) results[cfg].top1++; }
  }
  process.stdout.write('.');
}
console.log('\n');

const NA = QUESTIONS.length;
console.log('=== 検索の当たり（答えのある28問） ===');
for (const c of configs) {
  const r = results[c];
  console.log(`${c.padEnd(22)} 正解を拾えた ${String(r.hit).padStart(2)}/${NA} (${Math.round(r.hit / NA * 100)}%)   1位が正解 ${String(r.top1).padStart(2)}/${NA} (${Math.round(r.top1 / NA * 100)}%)`);
}

fs.writeFileSync('./retrieval.json', JSON.stringify(results, null, 1));
console.log('\n(詳細は retrieval.json)');
