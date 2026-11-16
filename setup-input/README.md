# 初回セットアップ用ファイルの配置

このディレクトリは **ユーザーが正規の配布元から取得したファイルを置く場所** です。ファイル本体は Git に含めません（`.gitignore` を参照）。

```text
DENCAL/
├─ setup-input/
│  ├─ README.md
│  ├─ masters/
│  │  ├─ b_YYYYMMDD.txt    # 厚生労働省 傷病名 全件
│  │  ├─ y_YYYYMMDD.csv    # 厚生労働省 医薬品 全件
│  │  └─ s_YYYYMMDD.csv    # 厚生労働省 医科診療行為 全件
│  └─ pmda/
│     └─ SGML_XML/        # PMDAの配布ZIP内のSGML_XMLディレクトリ
│        ├─ 製品A/
│        │  └─ 元ファイル名.xml
│        └─ 製品B/
│           └─ 元ファイル名.xml
└─ data/                  # db:initが生成。Git管理対象外
   ├─ dencal.sqlite3
   ├─ pmda-safety.sqlite3
   └─ initial-setup-report.json
```

フォルダを配置して `npm ci` 済みの状態で、リポジトリ直下から次を1回実行します。

```sh
npm run db:init
```

**必要なファイル:** 公式の全件マスター3種類（`b_*.txt`, `y_*.csv`, `s_*.csv`）とPMDAのXML（少なくとも1件）。マスターが複数の改訂日で置かれた場合は全ての版をインポートします。差分ファイルだけ、拡張子を変更したファイル、日付のないファイルは対応しません。ファイル名を変更しないでください。

取得先:
- 傷病名: https://shinryohoshu.mhlw.go.jp/shinryohoshu/standardMenu/doStandardMasterBz/
- 医薬品・医科診療行為: https://shinryohoshu.mhlw.go.jp/shinryohoshu/downloadMenu/
- PMDA: https://www.pmda.go.jp/safety/info-services/medi-navi/0012.html （マイ医薬品集作成サービスの全件ダウンロード）

処理内容:
1. 空の診療DBを作成し、現行スキーマ（v6）まで移行、初期ユーザー・架空サンプルカルテを登録。
2. 公式マスターを元のCSV/TXT形式のまま検証し、DENCALのマスター管理と同じ解析ロジックで取り込む。
3. PMDAの`SGML_XML`を再帰処理し、別の参照SQLiteを作成。PDF・GIF・SGML（.sgm）はこの版では読みません。
4. 2つのDBが完成した後に配置。結果を `data/initial-setup-report.json` に出力し、成功後にのみ初期職員パスワードを表示。

**既存のDBは上書きしません**。既存環境への差分マスター適用は管理者の「マスター管理」、PMDAの更新は `tools/import_pmda.py` を使用してください。上書きのために既存の診療DBを削除しないでください（患者データ・認証情報が含まれます）。

マスター不正やPMDA解析失敗で有効なXMLが1件もない場合はDBは配置されません。PMDAで一部XMLが失敗した場合は正常分で生成し、エラー件数・ファイル名をレポートに残します。**未照合・未抽出を「禁忌なし」とは判断しません。**

診療DB・PMDA DBを別名で作成する場合:

```sh
npm run db:init -- --input ./setup-input --db ./data/clinic-test.sqlite3 --pmda-db ./data/pmda-test.sqlite3
```

この場合、DENCAL起動時の `DENCAL_DB` と `DENCAL_PMDA_DB` も同じ場所に合わせます。Windowsでは `py -3` を、その他では `python3` を優先して検出します。特殊な環境では `DENCAL_PYTHON` にPythonの実行ファイルを指定できます。

**権利・取り扱い:** XML・PDF・生成SQLiteは再配布しません。公式データの利用条件を確認した上で、利用者自身のローカル環境でのみ取り込みます。医療現場の業務投入前の試作であり、電子添文原本の確認・専門家による評価が必要です。
