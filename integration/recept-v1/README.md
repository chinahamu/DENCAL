# DENCAL–RECEPT 連携仕様 v1

DENCALの外来受診からRECEPTの請求下書きへ引き渡す中間形式。各アプリは独立したDB・職員認証・公式マスターを使う。以下のHTTPインターフェースは後続実装向けの契約。現段階で実行できるのは、スキーマと共通テストによる検証。

| ファイル | 内容 |
| --- | --- |
| [transfer.schema.json](transfer.schema.json) | 送信本文のJSON Schema Draft 2020-12 |
| [response.schema.json](response.schema.json) | 受領結果・エラー本文のJSON Schema Draft 2020-12 |
| [fixtures.json](fixtures.json) | 架空の基本送信本文、差し替え項目、参照マスター、期待結果 |
| [contract.mjs](contract.mjs) | 形式検証と受信判定の参照実装 |
| [contract.test.mjs](contract.test.mjs) | 両リポジトリで実行する共通テスト |

## 送信と受領

| 操作 | HTTP | 契約 |
| --- | --- | --- |
| 送信 | `POST /api/integration/v1/encounters` | UTF-8 JSON、BOMなし、最大128 KiB。施設・送信元に紐付くサーバー間認証を適用する。 |
| 照会 | `GET /api/integration/v1/receipts/{integrationId}` | 認証済みの施設・送信元に属する受領結果を返す。範囲外と未登録はどちらも `404`。 |

HTTPエラーのJSONは `{ "error": "コード" }`。受領結果は `integrationId`、受信した本文の `bodySha256`、`status`、`issues` を持つ。確認項目の `path` は送信本文を指すJSON Pointer。項目を特定しない指摘には空文字を使う。

| HTTP | 条件 | 結果 |
| --- | --- | --- |
| 202 | 新規の受領結果を永続化 | `received` または `confirmation_required` |
| 200 | 照会、または同じ連携ID・同じ本文の再送 | 保存済みの受領結果 |
| 400 | JSON破損・形式不正・未対応バージョン | `invalid_json`、`invalid_payload`、`unsupported_schema_version` |
| 401 / 403 | 認証不可、または認証した施設・送信元と本文が不一致 | `authentication_required` / `source_scope_mismatch` |
| 404 | 受領結果が照会範囲内にない | `receipt_not_found` |
| 409 | 連携ID・版・患者紐付けなどの競合 | 応答スキーマの競合コード |
| 413 / 415 | サイズ超過、または非対応のメディアタイプ | `payload_too_large` / `unsupported_media_type` |
| 503 | 永続化不可など、結果を確定できない障害 | `temporarily_unavailable` |

`received` は受付時点の連携チェックを通過した状態。担当者による患者・資格・算定の確認後に請求下書きへ反映して `applied` とする。追加確認が必要な状態は `confirmation_required`、担当者の却下は `rejected` とする。受領・下書き反映・請求確定は別の処理。

## データと版管理

- `facilityId` は先頭ゼロを保持する10桁の文字列。患者の突合は `facilityId + senderId + patientId` で行う。受診内の傷病・実施明細IDは、種類ごとに重複させない。
- カルテ版 `chartRevision` は出典、連携版 `transferRevision` は受診内の送信順序。初回 `initial` は連携版1で、前版・理由は `null`。訂正 `correction` と受診取消 `cancel` は連携版2以降で、直前の連携版と理由を必須とする。カルテ版は同じ値を再利用できるが逆行は拒否する。
- 訂正は受診単位のスナップショット。送信済みの実施明細を取り消す場合は同じIDで `cancelled` とし、取消時は元コード・日付・数量・単位を保持する。取消明細を後続の訂正から消したり、実施済みに戻したりしない。再実施は新しい実施明細IDを使う。受診全体の取消では傷病・実施の配列を空にし、当該受診の後続版を拒否する。
- 傷病名は `startDate`、実施は `performedOn` の時点でRECEPT側の公式マスターを照合する。照合不能の有効明細は `unknown_master_code` で保留する。取消明細の参照コードは再照合しない。送信したマスター公表日と任意のファイルSHA-256は出典情報として保持する。
- 診療日は日付だけを表す `YYYY-MM-DD`。時刻・患者氏名・SOAP・保険証番号・試算点数はこの契約の送信項目に含めない。訂正・取消理由には連携上の変更に必要な内容を記載する。

## 重複・順序・訂正

- 一意キーは、受領IDが `facilityId + senderId + integrationId`、連携版が `facilityId + senderId + encounterId + transferRevision`。本文ハッシュは受信したUTF-8バイト列からSHA-256を計算する。JSONの空白やキー順が変わっても同じIDの再送にはできないため、送信側は保存済みのバイト列をそのまま使う。
- 先行版が届いていない場合は `predecessor_missing`、先行版の順序が解決していない場合は `predecessor_pending` として保留する。先行版が未知コードなどで保留されていても、版の連鎖が確認できれば訂正を受領できる。担当者の確認で差分を反映し、未反映の先行版を自動で請求下書きに追加しない。
- 保留再評価は受信側で実行する。保存済み本文を使い、自己レコードを履歴から除外して連携判定をやり直し、結果を更新する。送信側による再送は、既存の受領結果を取得する。
- 同じIDの異なる本文、同じ受診・版の別ID、患者IDの差し替え、版の逆行などは `409` で保留対象を増やさない。確定済み請求に影響する訂正は候補として提示し、RECEPTの訂正手順で反映する。

## 検証と同期

```sh
npm run test:integration
```

共通テストは通常の `npm test` にも含む。テスト用コード・有効期間は [fixtures.json](fixtures.json) 内の架空マスターで決まる。`messages` は単独で使える本文の例。`variants` は `base` の本文に `changes` のトップレベル項目を上書きする。`cases` が送信データと期待結果を指定する。実際の公式マスター・HTTPサーバー・受信DBはこのテストの依存に含まない。

形式検証は `readTransfer(bytes)`、受信判定は `evaluateTransfer(bytes, { source, inbox, hasMaster })` を使う。参照実装は副作用を持たず、後続の受信APIが認証済み送信元、永続化済みの受信履歴、マスター照合を渡す。確認操作とDBトランザクションは後続の実装範囲。

このディレクトリはDENCALとRECEPTに同一内容を置く。契約変更時は両方のファイルを同時に更新し、両リポジトリで共通テストを実行する。
