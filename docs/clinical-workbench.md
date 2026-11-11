# 診療画面と初期データベースの対応

診療APIは職種・担当部署を検査し、SQLiteへ保存します。患者・受診・保険・SOAP下書き・確定版は個別のテーブルを使用します。診療明細やバイタルなどの画面用データは受診単位で `clinical_workspaces` に、確定時の傷病名・処方・検査オーダは確定版のスナップショットに保存します。下表には今後使用するテーブル設計も含みます。

| 画面 | SQLiteテーブル | 保存と表示の設計 |
| --- | --- | --- |
| 受付一覧・患者基本情報 | `patients`、`patient_insurances`、`encounters`、`departments`、`eligibility_checks` | 患者に複数受診と保険期間を紐付ける。年齢は生年月日と受診日から算出。受付番号は診療科・受付日内で一意 |
| 主訴・アレルギー・登録傷病 | `encounters`、`patient_alerts`、`patient_diagnoses` | 主訴は受診単位、アレルギーと傷病は患者単位。登録元の受診を参照 |
| SOAP・処方・検査オーダー | `clinical_note_drafts`、`prescription_orders`、`procedure_orders`、`procedure_performances` | SOAPの4項目は個別に保存。オーダーと実施を分離 |
| 検査・バイタル推移 | `vital_signs`、`lab_panels`、`lab_results` | 測定日時・採取日時を使って受診をまたいで表示。BMIは身長・体重から算出 |
| 版履歴・紹介状 | `clinical_note_revisions`、`note_order_snapshots`、`referral_documents` | 確定版に前版・最終入力者・確定者・確定時刻を記録。訂正開始時に理由を保存し、確定版にSHA-256を記録 |
| 受付・会計 | `billing_records`、`billing_lines`、`receipts` | 算定結果の内訳、精算、発行情報を分ける |
| バックアップ・保存性 | `backup_snapshots`、`backup_checks` | 保管先参照と検証履歴を分ける。バックアップ本体はDBに入れない |
| 安全管理・監査 | `staff`、`staff_credentials`、`staff_sessions`、`audit_events` | ログイン時に職員と職種を確認し、ログアウトでセッションを失効。下書き保存・訂正開始・確定などを診療操作と同じトランザクションで記録 |
| 公式マスター | `master_releases`、`master_items`、`master_item_catalog_details` | 傷病名・医薬品・医科診療行為の全件ファイルを種別と版で保持し、有効期間・SHA-256・検索用情報を保存 |

管理者は公式マスターをDENCALに直接取り込む。医師と管理者はDENCALの認証済みAPIから検索する。画面の傷病名・処方・検査オーダには、選択時のマスター項目ID、版の日付、コードと名称を保持する。カルテ明細はSQLiteに保存し、確定時の内容を版ごとに固定する。

検査結果のテーブル設計では、マスターとの対応が付く前の受領結果も記録できる。現行の検索対象は医科診療行為マスターの検査・病理診断項目で、検査結果の標準コードマスターは未対応。

## 確定版の参照・移行

確定診療録の検索では患者番号・氏名・フリガナと受診日で絞り込み、受診IDと版番号で対象を特定します。選択した版と前版の連鎖を検証してから、画面表示と印刷用のUTF-8 HTMLを生成します。下書きはこの画面の対象外です。

SQLiteの書き出しと新規ファイルへの復元は、[READMEの診療録の保存・移行・復元](../README.md#診療録の保存移行復元)を参照してください。
