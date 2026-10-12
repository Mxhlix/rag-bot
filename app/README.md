# 社内ナレッジAIボット（RAG）実演サンプル

就業規則・業務マニュアル・過去議事録などの**社内文書**を読み込ませ、**社員**の質問に
**出典付き**で答える内部ナレッジチャットボットの実演サンプルです。
**APIキー無し・通信なしで動くデモモード**を同梱しています。

- RAG の全経路を通します: **取り込み → 分割（チャンク）→ 埋め込み → 検索（類似度）→ 出典付きで回答生成**
- 文書に答えが無い質問には、無理に答えず「該当箇所が見つからない」旨を返します（出典で裏取りできる設計）
- `DEMO_MODE=false` ＋ APIキーで、実 Claude（`claude-opus-4-8`）の RAG 応答へ差し替わります

---

## 使ったサンプル文書の出典・利用可否

このデモに同梱している社内文書（就業規則・経費精算規程・議事録）は、**すべて本デモのために
新規に書き下ろした「架空の会社（サンプル商事）」のオリジナル文書**です。

- 実在する企業・官公庁の文書を**転載していません**。著作権・利用上の問題を避けるため、公開文書の
  引き写しをあえて行わず、オリジナルで作成しています。
- 本デモ内で自由に利用・改変して構いません。
- 実体は `src/documents.mjs` にあります。**本番ではこの配列を、使う会社の実際の社内文書から
  読み込んだテキストに差し替えます。**

> 官公庁の公開マニュアルや公開規程を題材にすることも可能ですが、利用条件が不明なものは使いません。
> 「権利上問題がない」ことを最優先し、本サンプルは自作文書で構成しています。

---

## 機密文書の取扱い（最重要）

このボットは**社内文書＝機密情報**を扱います。そのため、次の前提で設計しています。

- **文書のデータベースを常設で持ちません。文書の最終的な保存先は、使う会社自身の環境**
  （その会社の Cloudflare、その会社が用意するベクトルストア等）です。
- **AIの学習には利用されません。** Anthropic は商用プロダクト（Anthropic API を含む）について、
  「既定では、入力・出力をモデルの学習に使用しない」と公式に定めています（明示的にフィードバック送信・
  同意した場合を除く）。一次確認: Anthropic プライバシーセンター
  “Is my data used for model training?”（2026-07-15 時点。原文: “By default, we will not use your inputs
  or outputs from our commercial products (e.g. … Anthropic API …) to train our models.”）。
- **文書内容・回答本文をログに残さない設計**にしています（サーバのログには件数・モードなど
  非機微情報のみ）。
- APIキー・合言葉などの秘密情報は**コードに直書きせず**、環境変数／Cloudflare のシークレット／
  スクリプトプロパティで管理します。
- 個人情報を含む文書を扱う場合、送信と取扱いの同意は、文書を持つ会社の側で取る必要があります。
- **回答の正確性は保証しません。**代わりに、回答には必ず出典（文書名・第N条／見出し）を添え、
  人が原典で裏取りできる形にしています。医療・法務・人事評価など誤答の影響が大きい用途への
  単独利用は非推奨です（人が確認する補助ツールとして位置づけます）。

---

## ファイル構成

```
app/
  README.md                この文書
  package.json             スクリプト（serve / verify / dev:cf）
  wrangler.toml            Cloudflare Pages/Functions の設定
  server.mjs               ローカル検証サーバ（Cloudflare不要・APIキー不要）
  public/
    index.html             チャットUI（合言葉入力・出典表示・LCD風ステータス）
  functions/
    api/chat.js            Cloudflare Pages Function（本番のチャットAPI本体）
  src/
    documents.mjs          サンプル社内文書（架空）＋チャンク化
    embeddings.mjs         埋め込み: デモ(ローカル) / 本番(Cloudflare Workers AI)
    generate.mjs           回答生成: デモ(抽出) / 本番(Claude Messages API)
    rag-engine.mjs         RAGコア（取り込み→分割→埋め込み→検索→回答）
    handler.mjs            合言葉検証・モード選択・共通処理
  test/
    verify.mjs             合格条件1〜4の自動検証
```

---

## デモの動かし方（APIキー不要）

### A. ローカルで触る（推奨・最短）

```
node server.mjs
```

→ ブラウザで `http://localhost:8787` を開く。合言葉の既定は **`demo`**。
「有給休暇は何日？」「出張の宿泊費の上限は？」などを入力すると、**出典付きで回答**が返ります。
「来週の東京の天気は？」のように文書に無い質問は、**断り＋出典なし**で返ります。

> デモは通信せず、サーバ内の簡易検索＋抽出で「出典付き回答の形」を見せています。
> 本番では同じ流れが、Claude の実回答に置き換わります。

### B. 合格条件を自動検証する

```
node test/verify.mjs
```

→ 合格条件1〜4を自動チェックし、全 PASS で終了コード0。

### C. Cloudflare のローカルモードで触る（任意・ログイン不要）

```
npx wrangler pages dev public --compatibility-flags=nodejs_compat
```

→ Cloudflare 実機に近い形でローカル起動（デモモードなので AI バインディング無しでも動作）。

---

## 本番（実データ・Claude接続）への切り替え

### 用意するもの

- **Anthropic の APIキー**（console.anthropic.com で発行）
  - Cloudflare のシークレットに `CLAUDE_API_KEY` として保存（コードに直書きしない）
  - ※ 利用した分の **API従量課金は、その APIキーの Anthropic アカウントに発生**します
- **社内限定アクセスの合言葉** `ACCESS_PASSPHRASE`（推測されにくい文字列）

### 切り替え手順

1. `src/documents.mjs` の文書配列を、使う会社の社内文書から抽出したテキストに差し替える
   （画像スキャンPDF・手書き・レイアウト崩れ等は、別途 OCR・テキスト化・構造化の前処理が必要です）
2. ベクトル化を本番用にする（`src/handler.mjs` が自動で切り替え）:
   - 小規模: そのまま（`CloudflareEmbedder` ＋ インメモリ検索）
   - 大量文書: `wrangler.toml` の Vectorize を有効化し、事前にインデックスへ登録
3. シークレットを設定して本番モードにする:
   ```
   npx wrangler pages secret put CLAUDE_API_KEY
   npx wrangler pages secret put ACCESS_PASSPHRASE
   ```
   ダッシュボードで環境変数 `DEMO_MODE=false` に設定
4. デプロイ（下記）

---

## 公開手順（Cloudflare Pages）

無料枠で公開できます。

1. Cloudflare アカウントを用意する
2. このディレクトリで:
   ```
   npx wrangler pages deploy public
   ```
   （初回はプロジェクト作成のプロンプトに従う。`functions/` は自動で Pages Functions として配信されます）
3. 発行された `https://<project>.pages.dev` が、**合言葉付きの社内向けURL**になります
4. 本番にする場合は、上記「本番への切り替え」でシークレットと `DEMO_MODE=false` を設定

> 合言葉URLは簡易な社内限定アクセスです。より厳密な制限（SSO / IP制限 / メンバー認証）が必要な場合は
> 別途の実装が必要です。

---

## 技術構成

- **回答生成**: Claude Messages API（`claude-opus-4-8`）
  `POST https://api.anthropic.com/v1/messages` / `x-api-key` / `anthropic-version: 2023-06-01`
  検索で得た該当箇所"だけ"を根拠に、日本語で回答（資料内に無ければ「見つからない」と返す）
- **ベクトル化（埋め込み）**: デモはローカル簡易ベクトル（通信なし）。本番は Cloudflare Workers AI
  の埋め込みモデル（例: `@cf/baai/bge-m3` 多言語対応）や任意プロバイダに差し替え可能。
  ※ Claude API に埋め込み専用エンドポイントは無いため、検索用のベクトル化は Claude とは別手段で行います。
- **検索**: コサイン類似度（小規模はインメモリ、大規模は Cloudflare Vectorize を想定）。
  埋め込みを使わない語彙一致検索（lexical）も同梱（軽量構成／フォールバック）。
- **配信**: Cloudflare Pages（静的UI）＋ Pages Functions（`/api/chat`）。無料枠。
- **セキュリティ**: 合言葉ゲート／全出力のHTMLエスケープ（XSS対策）／文書内容・回答をログに残さない／
  秘密情報は環境変数・シークレット管理／`public/_headers` でCSP等のセキュリティヘッダ付与。
  資料内の指示文には従わない旨をシステムプロンプトで指定（プロンプトインジェクション対策）。
  **本番では、コスト・濫用対策としてレート制限（Cloudflare の WAF／Rate Limiting ルール）の併用を推奨**します。
