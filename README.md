# KaKuSu

KaKuSu は、ブラウザ内で完結する Google Drive 向けのクライアントサイド暗号化アプリです。
ファイルは暗号化された状態でのみ Google Drive に保存され、平文ファイルやパスフレーズを KaKuSu 独自サーバーに送信しません。

- Repository: https://github.com/aftn/kakusu

## 主な機能

- AES-GCM によるファイル暗号化
- PBKDF2-SHA256 + HKDF による鍵導出
- VaultKey / NameKey による鍵ローテーション最適化
- Google Drive 上のファイル名・フォルダ名暗号化
- 共有リンクベースの E2E 共有
- コピー / 切り取り / 貼り付け
- セッション認証とサイレント再認証
- 暗号化済みメタデータキャッシュ
- オフライン復旧ツール

## セットアップ

### 1. Google Cloud Console

1. Google Cloud でプロジェクトを作成
2. Google Drive API を有効化
3. OAuth 2.0 クライアント ID を作成
4. 次を登録

- Authorized JavaScript origins: `http://localhost:5173`
- Authorized redirect URIs: `http://localhost:5173/callback`

本番環境を追加する場合は、デプロイ先のオリジンとコールバックパスも登録してください。

### 2. インストール

```bash
git clone https://github.com/aftn/kakusu.git
cd kakusu
npm install
```

### 3. ローカル環境変数

`.env.example` をコピーして `.env.local` を作成し、設定します。

```dotenv
VITE_GOOGLE_CLIENT_ID=YOUR_CLIENT_ID.apps.googleusercontent.com
VITE_REDIRECT_URI=http://localhost:5173/callback
```

`.env.example` を参照して、その他のオプション環境変数も確認してください。

### 4. 開発起動

```bash
npm run dev
```

## デプロイ

GitHub Pages、Cloudflare Pages、または任意の静的ホスティングにデプロイできます。

### Cloudflare Pages / Workers

```bash
npm run deploy:pages
```

カスタムドメインを使う場合は `wrangler.jsonc` のコメントを参照してください。

### GitHub Pages

GitHub Actions で自動配備する場合のワークフロー例:

- `main` への push で自動ビルドと配備
- `vite.config.ts` の `base` をリポジトリ名に変更（例: `/kakusu/`）

### 本番環境変数

デプロイ先のプラットフォームで以下の環境変数を設定してください:

| 変数 | 説明 |
|---|---|
| `VITE_GOOGLE_CLIENT_ID` | Google OAuth クライアント ID (必須) |
| `VITE_REDIRECT_URI` | OAuth リダイレクト URI |
| `VITE_GITHUB_URL` | 設置画面に表示する GitHub リポジトリ URL |
| `VITE_PUBLIC_SITE_URL` | プライバシーポリシー等の公開サイト URL |

## 利用フロー

### 初回設定

1. Google アカウントでログイン
2. パスフレーズを設定
3. Google Drive に kakusu フォルダを作成

### 通常操作

- ファイルやフォルダをアップロード
- 必要に応じてファイル名暗号化を有効化
- 共有リンクを生成して受信者へ送付
- コピー / 切り取り / 貼り付けで Drive 内整理

## セキュリティ前提

- パスフレーズは送信しません
- OAuth アクセストークンは sessionStorage のみを使用します
- リフレッシュトークンは保持しません
- Vault ロック時は鍵やプレビュー URL を破棄します
- キャッシュは暗号化して IndexedDB に保存できます

## Recovery Tool

Google Drive から手動取得した暗号化データを復号するためのツールを recovery 配下に置いています。

- [recovery/README.md](./recovery/README.md)
- [recovery/decrypt.py](./recovery/decrypt.py)
- [recovery/recover.bat](./recovery/recover.bat)

## スクリプト

```bash
npm run dev       # 開発サーバー起動
npm run build     # プロダクションビルド
npm run preview   # ビルド結果のプレビュー
npm test          # テスト実行
npm run lint      # Lint + Biome
```

## 技術スタック

| 技術 | 用途 |
|---|---|
| React 19 | UI |
| TypeScript 5.7 | アプリ本体 |
| Zustand 5 | 状態管理 |
| Vite 6 | 開発 / ビルド |
| Tailwind CSS 4 | スタイリング |
| idb 8 | IndexedDB ラッパー |
| Vitest 3 | テスト |
| Biome 1.9 | 静的検査 |

## ライセンス

AGPL-3.0-only
