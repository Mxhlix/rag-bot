import fs from 'node:fs';
import { toChunks } from './corpus.mjs';
import { QUESTIONS, NOANSWER } from './questions.mjs';

const KEY = process.env.GEMINI_API_KEY;
if (!KEY) { console.error('GEMINI_API_KEY を環境変数に設定してください'); process.exit(1); }
const GEN = 'gemini-flash-lite-latest';
const CHUNKS = toChunks();
const byId = new Map(CHUNKS.map((c) => [c.id, c]));
const R = JSON.parse(fs.readFileSync('./retrieval.json', 'utf8'));
const ALL = [...QUESTIONS.map((x) => ({ ...x, type: 'ans' })), ...NOANSWER.map((x) => ({ ...x, keys: [], type: 'no' }))];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function gen(prompt) {
  for (let i = 0; i < 6; i++) {
    const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${GEN}:generateContent?key=${KEY}`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], generationConfig: { temperature: 0, maxOutputTokens: 8192 } }),
    });
    if (r.ok) { const j = await r.json(); return j.candidates?.[0]?.content?.parts?.map((p) => p.text).join('') ?? ''; }
    await sleep(5000 * (i + 1));
  }
  return '(生成失敗)';
}
const CACHE = './acache.json';
const cache = fs.existsSync(CACHE) ? JSON.parse(fs.readFileSync(CACHE, 'utf8')) : {};

const PROMPT = (q, cs) => cs.length === 0
  ? null
  : `あなたは社内文書に基づいて答えるアシスタントです。以下の抜粋に書かれていることだけを根拠に答えてください。抜粋に答えが無い場合は、推測せず「該当する記載が見つかりません」とだけ答えてください。\n\n質問: ${q}\n\n抜粋:\n${cs.map((c) => `【${c.section}／${c.docTitle}】\n${c.text}`).join('\n\n')}\n\n回答（2〜3文。根拠にした箇所を末尾に「出典: 」として書く）:`;

const norm = (s) => s.replace(/,/g, '').replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0));
const REFUSE = /見つかりません|記載がありません|記載はありません|情報がありません/;

const out = {};
for (const cfg of ['B_意味検索', 'D_意味+選び直し']) {
  const picks = R[cfg].picks;
  let correct = 0, refusedWrong = 0, refusedRight = 0, hallucinated = 0;
  const rows = [];
  for (const [n, x] of ALL.entries()) {
    const p = picks[n];
    const cs = p.got.map((id) => byId.get(id)).filter(Boolean);
    const prompt = PROMPT(x.q, cs);
    const k = `${cfg}:${n}`;
    let a;
    if (prompt === null) a = '該当する記載が見つかりません';
    else { if (cache[k] === undefined) { cache[k] = await gen(prompt); fs.writeFileSync(CACHE, JSON.stringify(cache)); await sleep(1500); } a = cache[k]; }
    const refused = REFUSE.test(a);
    if (x.type === 'ans') {
      const hit = x.keys.some((kk) => norm(a).includes(norm(kk)));
      if (hit) correct++; else if (refused) refusedWrong++;
      rows.push({ q: x.q, ok: hit, refused, a: a.replace(/\s+/g, ' ').slice(0, 90) });
    } else {
      if (refused) refusedRight++; else hallucinated++;
      rows.push({ q: x.q, ok: refused, refused, a: a.replace(/\s+/g, ' ').slice(0, 90) });
    }
    process.stdout.write('.');
  }
  out[cfg] = { correct, refusedWrong, refusedRight, hallucinated, rows };
}
console.log('\n');

for (const [cfg, r] of Object.entries(out)) {
  console.log(`=== ${cfg}`);
  console.log(`  答えのある28問: 正しく答えた ${r.correct}/28 (${Math.round(r.correct / 28 * 100)}%) ／ 答えられず断った ${r.refusedWrong}`);
  console.log(`  答えの無い 4問: 正しく断った ${r.refusedRight}/4 ／ 無いのに答えた ${r.hallucinated}`);
  for (const row of r.rows.filter((z) => !z.ok)) console.log(`   × ${row.q} → ${row.a}`);
  console.log('');
}
fs.writeFileSync('./answers.json', JSON.stringify(out, null, 1));
