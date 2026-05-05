# KaKuSu Recovery Tool

KaKuSu の Recovery Tool は、Google Drive から手動で取得した暗号化データをローカルで復号するための補助ツールです。

## 同梱ファイル

- decrypt.py: 復号本体
- recover.bat: Windows 向け起動ラッパー

## 必要条件

- Windows または Python 3.9 以上が使える環境
- Google Drive から取得した kakusu フォルダ一式
- 正しいパスフレーズ

## 推奨ディレクトリ構成

```text
recovery/
├── decrypt.py
├── recover.bat
├── <Drive から取得したルートフォルダ>/
│   ├── DO_NOT_DELETE.json
│   └── data/
└── rawdata/
```

ルートフォルダ名は `kakusu` に固定ではありません。アプリ側で変更している場合でも、そのままの名前で配置して構いません。

## Windows での実行

同じフォルダに Drive から取得したルートフォルダを置いて、recover.bat を実行します。

```bat
recover.bat
```

実行すると対話形式で以下の設定を求められます。

1. メタデータファイル (DO_NOT_DELETE.json) のパス
2. 復号対象フォルダまたはファイルのパス
3. 出力先フォルダのパス
4. パスフレーズ

最後に設定内容を確認してから復号が開始されます。

初回実行時は仮想環境を作成し、cryptography を自動インストールします。

## Python での直接実行

### 対話モード（引数なし）

引数を指定しないと、ウィザード形式で対話的に設定を行えます。

```bash
python decrypt.py
```

### コマンドライン引数での実行

引数を指定すると、非対話モードで実行されます。

```bash
python decrypt.py kakusu/ -o rawdata/
python decrypt.py -p "your-passphrase" downloaded-vault-root/
python decrypt.py file.enc
```

## 入力データ

- DO_NOT_DELETE.json または DO_NOT_DELETE
- data フォルダ配下の暗号化済みファイル

## 出力

復号されたファイルは rawdata/ に展開されます。
暗号化された Drive 上の名前は、復号可能な場合は元のファイル名に戻されます。

## 注意事項

- パスフレーズが違う場合は復号できません
- v2 ヘッダーの埋め込み CEK を前提にしています
- 既存ファイル名と衝突する場合は連番付きで保存します
- 復号後の平文データは利用者自身で安全に管理してください
