// ragbot.html（読める原本）に pdf.js を埋め込んで、配布用の1ファイルを作る。
//   node build.mjs
//     → dist/ragbot.html       基本版（スキャン読み取りなし）
//     → dist/ragbot-scan.html  スキャン文書・画像の読み取り入り
// スキャン読み取りはオプション機能なので、基本版には
// 機能そのもの（チェックボックスとOCRのコード）を入れない。
// 原本の <!--SCAN-ONLY-->〜<!--/SCAN-ONLY--> と /*SCAN-ONLY*/〜/*/SCAN-ONLY*/ が切り取りの範囲。
//
// pdf.js は node_modules/pdfjs-dist から取る（npm install で入る）。
// 埋め込みは base64 で行う。ライブラリの中身をそのまま <script> に流し込むと、
// HTML側の解析が本文中の記号に反応して途中で切れる（実際に壊れた）。
// base64 なら英数字だけなので、その事故が起きない。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const PDFJS = path.join(here, 'node_modules/pdfjs-dist/build');
const SRC = path.join(here, 'ragbot.html');

const b64 = (f) => fs.readFileSync(path.join(PDFJS, f)).toString('base64');
const lib = b64('pdf.min.mjs');
const worker = b64('pdf.worker.min.mjs');

const inject = `<script type="module">
// pdf.js 本体（PDFから本文の文字を取り出すために使う）
const m = await import("data:text/javascript;base64,${lib}");
window.pdfjsLib = m;
// 重い処理を任せる係。別ファイルを置かずに済ませるため、ここから blob を作って渡す
const b = Uint8Array.from(atob("${worker}"), (c) => c.charCodeAt(0));
m.GlobalWorkerOptions.workerSrc = URL.createObjectURL(new Blob([b], { type: 'text/javascript' }));
window.dispatchEvent(new Event('pdfjs-ready'));
<\/script>`;

const src = fs.readFileSync(SRC, 'utf8');
if (!src.includes('<!--INJECT:PDFJS-->')) throw new Error('埋め込み位置の目印がありません');
for (const m of ['<!--SCAN-ONLY-->', '<!--/SCAN-ONLY-->', '/*SCAN-ONLY*/', '/*/SCAN-ONLY*/', 'const SCAN = true;']) {
  if (!src.includes(m)) throw new Error(`切り取りの目印がありません: ${m}`);
}
const injected = src.replace('<!--INJECT:PDFJS-->', inject);

// 基本版: SCAN-ONLY の範囲を取り除き、SCAN フラグを倒す
const base = injected
  .replace(/<!--SCAN-ONLY-->[\s\S]*?<!--\/SCAN-ONLY-->/g, '')
  .replace(/\/\*SCAN-ONLY\*\/[\s\S]*?\/\*\/SCAN-ONLY\*\//g, '')
  .replace('const SCAN = true;', 'const SCAN = false;');
for (const leak of ['ocrPage', 'OCR_PROMPT', 'id="ocr"']) {
  if (base.includes(leak)) throw new Error(`基本版にオプションのコードが残っています: ${leak}`);
}

fs.mkdirSync(path.join(here, 'dist'), { recursive: true });
for (const [name, html] of [['ragbot.html', base], ['ragbot-scan.html', injected]]) {
  const out = path.join(here, 'dist', name);
  fs.writeFileSync(out, html, 'utf8');
  console.log(`dist/${name} を作成（${Math.round(fs.statSync(out).size / 1024)}KB）`);
}
