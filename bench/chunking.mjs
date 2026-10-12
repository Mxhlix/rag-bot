// 文書の「切り方」だけを変えて、同じ意味検索＋AI回答で正答率を比べる。
import fs from 'node:fs';
import { DOCS } from './corpus.mjs';
import { QUESTIONS, NOANSWER } from './questions.mjs';

const KEY = process.env.GEMINI_API_KEY;
if (!KEY) { console.error('GEMINI_API_KEY を環境変数に設定してください'); process.exit(1); }
const EMB = 'gemini-embedding-001', GEN = 'gemini-flash-lite-latest', DIM = 768;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function post(url, body) {
  for (let i = 0; i < 6; i++) {
    const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    if (r.ok) return r.json();
    await sleep(5000 * (i + 1));
  }
  throw new Error('failed');
}
async function embedMany(texts, taskType) {
  const out = [];
  for (let i = 0; i < texts.length; i += 20) {
    const j = await post(`https://generativelanguage.googleapis.com/v1beta/models/${EMB}:batchEmbedContents?key=${KEY}`,
      { requests: texts.slice(i, i + 20).map((t) => ({ model: `models/${EMB}`, content: { parts: [{ text: t }] }, taskType, outputDimensionality: DIM })) });
    out.push(...j.embeddings.map((e) => e.values)); await sleep(700);
  }
  return out;
}
async function gen(p) {
  const j = await post(`https://generativelanguage.googleapis.com/v1beta/models/${GEN}:generateContent?key=${KEY}`,
    { contents: [{ parts: [{ text: p }] }], generationConfig: { temperature: 0, maxOutputTokens: 8192 } });
  return j.candidates?.[0]?.content?.parts?.map((x) => x.text).join('') ?? '';
}
const cos = (a, b) => { let d = 0; for (let i = 0; i < a.length; i++) d += a[i] * b[i]; return d; };

// --- 3通りの切り方 ---
const bySection = () => DOCS.flatMap((d) => d.sections.map((s) => ({ label: `${s.no} ${s.heading}／${d.title}`, text: s.text })));
const byDoc = () => DOCS.map((d) => ({ label: d.title, text: d.sections.map((s) => `${s.no} ${s.heading} ${s.text}`).join('\n') }));
const byFixed = (n = 300) => {
  const out = [];
  for (const d of DOCS) {
    const all = d.sections.map((s) => `${s.no} ${s.heading} ${s.text}`).join('');
    for (let i = 0; i < all.length; i += n) out.push({ label: `${d.title}（${Math.floor(i / n) + 1}）`, text: all.slice(i, i + n) });
  }
  return out;
};

const ALL = [...QUESTIONS.map((x) => ({ ...x, type: 'ans' })), ...NOANSWER.map((x) => ({ ...x, keys: [], type: 'no' }))];
const CACHE = './ccache.json';
const cache = fs.existsSync(CACHE) ? JSON.parse(fs.readFileSync(CACHE, 'utf8')) : {};
const put = () => fs.writeFileSync(CACHE, JSON.stringify(cache));
const norm = (s) => s.replace(/,/g, '').replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0));
const REFUSE = /見つかりません|記載がありません|記載はありません|情報がありません/;

const qVecs = cache.q ?? (cache.q = await embedMany(ALL.map((x) => x.q), 'RETRIEVAL_QUERY'), put(), cache.q);

const modes = [
  ['条・見出しで切る（現行）', bySection(), 4],
  ['文書まるごと1つ', byDoc(), 2],
  ['300字ごとに機械的に切る', byFixed(300), 4],
];

for (const [name, chunks, topK] of modes) {
  const ck = `v:${name}`;
  const dv = cache[ck] ?? (cache[ck] = await embedMany(chunks.map((c) => c.text), 'RETRIEVAL_DOCUMENT'), put(), cache[ck]);
  let correct = 0, refusedRight = 0, halluc = 0; const bad = [];
  for (const [n, x] of ALL.entries()) {
    const top = dv.map((v, i) => ({ i, s: cos(qVecs[n], v) })).sort((a, b) => b.s - a.s).slice(0, topK).map((z) => chunks[z.i]);
    const k = `a:${name}:${n}`;
    if (cache[k] === undefined) {
      cache[k] = await gen(`あなたは社内文書に基づいて答えるアシスタントです。以下の抜粋に書かれていることだけを根拠に答えてください。抜粋に答えが無い場合は、推測せず「該当する記載が見つかりません」とだけ答えてください。\n\n質問: ${x.q}\n\n抜粋:\n${top.map((c) => `【${c.label}】\n${c.text}`).join('\n\n')}\n\n回答（2〜3文。根拠にした箇所を末尾に「出典: 」として書く）:`);
      put(); await sleep(1500);
    }
    const a = cache[k], refused = REFUSE.test(a);
    if (x.type === 'ans') { if (x.keys.some((kk) => norm(a).includes(norm(kk)))) correct++; else bad.push(`${x.q} → ${a.replace(/\s+/g, ' ').slice(0, 70)}`); }
    else { if (refused) refusedRight++; else { halluc++; bad.push(`[答え無し] ${x.q} → ${a.replace(/\s+/g, ' ').slice(0, 70)}`); } }
    process.stdout.write('.');
  }
  console.log(`\n=== ${name}（${chunks.length}箇所・上位${topK}件をAIへ）`);
  console.log(`  正しく答えた ${correct}/28 (${Math.round(correct / 28 * 100)}%) ／ 答えの無い4問を正しく断った ${refusedRight}/4 ／ 無いのに答えた ${halluc}`);
  for (const b of bad) console.log('   × ' + b);
}
