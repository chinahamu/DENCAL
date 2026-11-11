import type { MhlwComplianceItem } from '../types/emr';

export const CLINIC_INFO = {
  facilityCode: '1310428917', // 東京都医療機関コード10桁
  name: '医療法人社団 誠仁会 さくら内科・循環器クリニック',
  postalCode: '〒102-0074',
  address: '東京都千代田区九段南2-4-16 九段メディカルプラザ 2F',
  phone: '03-5210-8820',
  director: '院長 榊原 誠一（日本内科学会認定総合内科専門医）',
  serverNode: 'INHOUSE-SRV-01 (192.168.10.10 / 院内閉域VLAN・RAID10)',
  guidelineVersion: '厚生労働省「医療情報システムの安全管理に関するガイドライン 第6.0版」準拠',
};

export const SOAP_TEMPLATES: {
  id: string;
  label: string;
  soap: { subjective: string; objective: string; assessment: string; plan: string };
}[] = [
  {
    id: 'TPL-HTN-DM',
    label: '高血圧・2型糖尿病 定期再診セット',
    soap: {
      subjective:
        '家庭血圧は朝 126/78 mmHg前後で安定。低血糖症状（冷汗・動悸）なし。食事療法・1日6,000歩のウォーキング継続中。残薬なし。',
      objective:
        '意識清明、胸部聴診：心音純・雑音なし、呼吸音清。下腿浮腫(-)。本日採血にてHbA1cおよび腎機能(eGFR)・脂質プロファイル確認。',
      assessment:
        '#1 本態性高血圧症（コントロール良好）\n#2 2型糖尿病（HbA1c 6.7%と改善傾向維持）\n#3 脂質異常症',
      plan:
        '現行処方（アムロジピン5mg、メトホルミン500mg、ロスバスタチン2.5mg）28日分継続。減塩6g/日未満の継続指導。次回4週後に再診・採血予定。',
    },
  },
  {
    id: 'TPL-URI',
    label: '急性上気道炎・発熱外来セット',
    soap: {
      subjective:
        '昨日夕方より咽頭痛・悪寒が出現し、今朝38.2℃の発熱あり。咳嗽軽度、呼吸苦なし。周囲に感冒症状者なし。',
      objective:
        '体温 38.0℃、SpO2 98%(room air)、脈拍 88/min。咽頭発赤(+)、扁桃腫大・白苔(-)、頸部リンパ節腫脹軽度。呼吸音清、ラ音なし。迅速抗原検査：COVID-19(-)、Flu A/B(-)。',
      assessment: '#1 急性上気道炎（ウイルス性咽頭炎疑い）',
      plan:
        '対症療法として解熱鎮痛剤（カロナール錠500mg 頓服）および去痰薬（カルボシステイン錠500mg）を5日分処方。水分補給・安静を指示し、3日以上高熱持続時は再受診を指導。',
    },
  },
  {
    id: 'TPL-CKD',
    label: '慢性腎臓病 (CKD G3a) 経過観察セット',
    soap: {
      subjective:
        '体調変化なし。夜間頻尿1回のみ。NSAIDs等の市販鎮痛薬の内服なし。家庭血圧 128/80 mmHg。',
      objective:
        '体重変化なし、眼瞼・下腿浮腫(-)。eGFR 42.5 mL/min/1.73m²（前回43.1と横ばい）、血清K 4.4 mEq/L、尿蛋白(±)。',
      assessment: '#1 慢性腎臓病 CKDステージG3aA2\n#2 高血圧性腎硬化症',
      plan:
        '腎血流量保持のため脱水予防を指導。腎排泄型薬剤・NSAIDs回避を継続。オルメサルタン20mg 28日分処方継続。',
    },
  },
];

export const MHLW_COMPLIANCE_ITEMS: MhlwComplianceItem[] = [
  {
    id: 'MHLW-AUTH-01',
    pillar: '真正性 (Authenticity)',
    sectionRef: 'ガイドライン第6.0版 企画管理編 15章 / システム運用編 14章',
    title: '診療録の保存・確定・訂正',
    requirement:
      '故意または過失による虚偽入力・書き換え・消去及び混同を防止し、作成の責任の所在（医師等の識別・認証）を明確にすること。',
    implementationDetail:
      '確定版・訂正理由・SHA-256をSQLiteに保存し、版の整合性を参照時に検証する。電子署名・信頼できるタイムスタンプは実装予定。',
    status: 'attention',
  },
  {
    id: 'MHLW-AUTH-02',
    pillar: '真正性 (Authenticity)',
    sectionRef: 'ガイドライン第6.0版 システム運用編 13章・14章',
    title: '職種別最小権限アクセス制御（RBAC）と二要素認証',
    requirement:
      '利用者識別・認証を徹底し、医師・看護師・医療事務・システム管理者ごとに職務に応じた最小限のアクセス権限を設定すること。',
    implementationDetail:
      '4職種RBACマトリクスを実装。医師のみがSOAP確定署名・処方オーダ発行可能。看護師はバイタル・トリアージ記録、医療事務は受付・会計算定に厳格分離。',
    status: 'compliant',
  },
  {
    id: 'MHLW-READ-01',
    pillar: '見読性 (Readability)',
    sectionRef: 'ガイドライン第6.0版 企画管理編 15章 / 経営管理編',
    title: '確定診療録の検索・表示・印刷',
    requirement:
      '電子保存された診療録等の内容を、権限を持つ利用者の求めに応じ、直ちに肉眼で見読可能な状態（ディスプレイ表示・書面印刷）にできること。',
    implementationDetail:
      '患者番号・氏名・受診日で確定版を検索し、UTF-8の印刷用HTMLで表示・出力する。',
    status: 'attention',
  },
  {
    id: 'MHLW-PRES-01',
    pillar: '保存性 (Preservability)',
    sectionRef: 'ガイドライン第6.0版 システム運用編 11章・18章 (BCP/ランサムウェア対策)',
    title: '診療録の保存・移行・復元',
    requirement:
      '法令で定められた保存期間（診療録5年等）にわたり、滅失・棄損およびサイバー攻撃（ランサムウェア等）から診療データを保護・復旧できること。',
    implementationDetail:
      'SQLiteのコピー・検証・新規ファイルへの復元をコマンドで実行できる。世代管理・暗号化・隔離保管は運用上の残件。',
    status: 'attention',
  },
  {
    id: 'MHLW-GOV-01',
    pillar: '安全管理措置 (Security Governance)',
    sectionRef: 'ガイドライン第6.0版 システム運用編 17章 (証跡のレビュー・監査)',
    title: '改ざん不能な監査証跡（Audit Trail）の自動記録と定期監査エクスポート',
    requirement:
      '診療録の閲覧・作成・更新・出力・バックアップ操作のすべてについて「いつ・誰が・どの端末から・どの患者情報にアクセスしたか」を記録・監査すること。',
    implementationDetail:
      '全操作（カルテ閲覧、署名、処方追加、会計、バックアップ、ロール変更）を端末IP・ハッシュ値付きでリアルタイム記録し、CSV監査レポート出力に対応。',
    status: 'compliant',
  },
  {
    id: 'MHLW-GOV-02',
    pillar: '安全管理措置 (Security Governance)',
    sectionRef: 'ガイドライン第6.0版 システム運用編 7章・8章 (物理的・技術的安全対策)',
    title: '院内閉域VLAN運用・離席時自動画面ロック（クリアスクリーン）',
    requirement:
      '診察室端末の覗き見防止および離席時の不正操作を防止するため、一定時間操作がない場合の自動セッションロック機構を備えること。',
    implementationDetail:
      '院内閉域ネットワーク（192.168.10.0/24）完結構成に加え、ワンクリック離席ロックおよび無操作自動ロックタイマー設定を標準装備。',
    status: 'compliant',
  },
];
