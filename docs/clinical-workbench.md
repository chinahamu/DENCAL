# 添付GUIと初期データベースの対応

添付のReactコンポーネントを使う。ログインと公式マスターの取り込み・検索はSQLiteに接続し、診療・会計などのデモデータはブラウザー内に保持する。病院での接続を実装する際は、画面の患者集約型をAPIで組み立て、DBでは患者と受診を分離する。

| 画面 | SQLiteテーブル | 保存と表示の設計 |
| --- | --- | --- |
| 受付一覧・患者基本情報 | `patients`、`patient_insurances`、`encounters`、`departments`、`eligibility_checks` | 患者に複数受診と保険期間を紐付ける。年齢は生年月日と受診日から算出。受付番号は診療科・受付日内で一意 |
| 主訴・アレルギー・登録傷病 | `encounters`、`patient_alerts`、`patient_diagnoses` | 主訴は受診単位、アレルギーと傷病は患者単位。登録元の受診を参照 |
| SOAP・処方・検査オーダー | `clinical_note_drafts`、`prescription_orders`、`procedure_orders`、`procedure_performances` | SOAPの4項目は個別に保存。オーダーと実施を分離 |
| 検査・バイタル推移 | `vital_signs`、`lab_panels`、`lab_results` | 測定日時・採取日時を使って受診をまたいで表示。BMIは身長・体重から算出 |
| 版履歴・紹介状 | `clinical_note_revisions`、`note_order_snapshots`、`referral_documents` | 版に前版・確定者・確定時刻を記録。訂正には理由が必要。紹介状は参照版を特定 |
| 受付・会計 | `billing_records`、`billing_lines`、`receipts` | 算定結果の内訳、精算、発行情報を分ける |
| バックアップ・保存性 | `backup_snapshots`、`backup_checks` | 保管先参照と検証履歴を分ける。バックアップ本体はDBに入れない |
| 安全管理・監査 | `staff`、`staff_credentials`、`staff_sessions`、`audit_events` | ログイン時に職員と職種を確認し、ログアウトでセッションを失効。診療操作の監査は定義のみ |
| 公式マスター | `master_releases`、`master_items`、`master_item_catalog_details` | 傷病名・医薬品・医科診療行為の全件ファイルを種別と版で保持し、有効期間・SHA-256・検索用情報を保存 |

管理者は公式マスターをDENCALに直接取り込む。医師と管理者はDENCALの認証済みAPIから検索する。画面の傷病名・処方・検査オーダには、選択時のマスター項目ID、版の日付、コードと名称を保持する。明細の永続化APIは未実装で、カルテの入力内容は画面デモの状態に保持する。

検査結果のテーブル設計では、マスターとの対応が付く前の受領結果も記録できる。現行の検索対象は医科診療行為マスターの検査・病理診断項目で、検査結果の標準コードマスターは未対応。
