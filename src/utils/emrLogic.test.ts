import test from 'node:test';
import assert from 'node:assert/strict';
import {
  calculateMedicalFeePoints,
  canPerformAction,
  checkDrugSafety,
  computePayloadChecksum,
  computeRecordHash,
  evaluateLabFlag,
  verifyBackupIntegrity,
} from './emrLogic';
import { AllergyItem, DrugCatalogItem, PrescriptionItem, SoapContent } from '../types/emr';

test('computeRecordHash produces deterministic 64-char hex and changes when SOAP content is altered (真正性・改ざん検知)', () => {
  const soapA: SoapContent = {
    subjective: '2日前より咽頭痛と38.1℃の発熱あり。',
    objective: '咽頭発赤(+)、扁桃白苔(-)、SpO2 98%',
    assessment: '急性上気道炎',
    plan: '対症療法にて経過観察',
  };
  const rx: PrescriptionItem[] = [
    {
      id: 'rx-1',
      yjCode: '1141007F1028',
      drugName: 'カロナール錠500mg',
      dosagePerDay: '3錠 (1回1錠)',
      usage: '疼痛・発熱時頓服',
      days: 5,
      category: 'as_needed',
      genericAllowed: true,
      pointsPerDay: 5,
    },
  ];

  const hash1 = computeRecordHash('PT-001042', soapA, rx, [], 'HPKI-DR-9921', '2026-11-09T09:30:00');
  const hash2 = computeRecordHash('PT-001042', soapA, rx, [], 'HPKI-DR-9921', '2026-11-09T09:30:00');
  assert.equal(hash1.length, 64);
  assert.equal(hash1, hash2);

  const soapTampered: SoapContent = {
    ...soapA,
    assessment: '急性気管支炎',
  };
  const hashTampered = computeRecordHash('PT-001042', soapTampered, rx, [], 'HPKI-DR-9921', '2026-11-09T09:30:00');
  assert.notEqual(hash1, hashTampered);
});

test('checkDrugSafety detects penicillin allergy and low eGFR renal cautions', () => {
  const amoxicillin: DrugCatalogItem = {
    yjCode: '6131001M1024',
    drugName: 'サワシリンカプセル250mg (アモキシシリン)',
    drugClass: 'ペニシリン系抗生物質',
    defaultDosage: '3カプセル',
    defaultUsage: '毎食後',
    defaultDays: 5,
    pointsPerDay: 12,
    contraindicationKeywords: ['ペニシリン', 'アモキシシリン', 'βラクタム'],
    renalCautionEgfrBelow: 30,
  };

  const allergies: AllergyItem[] = [
    {
      substance: 'ペニシリン系抗菌薬',
      category: 'drug',
      severity: 'severe',
      reaction: '全身蕁麻疹・呼吸苦',
    },
  ];

  const warnings = checkDrugSafety(amoxicillin, allergies, [], [], 25);
  assert.equal(warnings.some((w) => w.severity === 'error' && w.reason.includes('禁忌アラート')), true);
  assert.equal(warnings.some((w) => w.severity === 'warning' && w.reason.includes('腎機能低下注意')), true);
});

test('calculateMedicalFeePoints computes accurate points and rounds copayment to nearest 10 yen', () => {
  const result = calculateMedicalFeePoints(
    '再診',
    0.3,
    true, // 特定疾患療養管理料 (225点)
    [
      {
        id: 'rx-1',
        yjCode: '2149022F1020',
        drugName: 'アムロジピン錠5mg',
        dosagePerDay: '1錠',
        usage: '朝食後',
        days: 28,
        category: 'internal',
        genericAllowed: true,
        pointsPerDay: 4,
      },
    ],
    [], // 検査なし -> 外来管理加算 (52点) 対象
    true // マイナ保険証 (10点)
  );

  // 再診料(75) + 外来管理加算(52) + 医療DX推進(10) + 特定疾患療養管理料(225) + 処方箋料(68) + 一般名処方加算2(8) = 438点
  assert.equal(result.totalPoints, 438);
  assert.equal(result.totalMedicalYen, 4380);
  // 4380 * 0.3 = 1314円 -> 10円単位四捨五入で 1310円
  assert.equal(result.copayAmountYen, 1310);
});

test('canPerformAction inherits lower-role permissions in the UI demo', () => {
  assert.equal(canPerformAction('doctor', 'sign_soap'), true);
  assert.equal(canPerformAction('nurse', 'sign_soap'), false);
  assert.equal(canPerformAction('clerk', 'sign_soap'), false);
  assert.equal(canPerformAction('clerk', 'settle_billing'), true);
  assert.equal(canPerformAction('admin', 'restore_backup'), true);
  assert.equal(canPerformAction('admin', 'sign_soap'), true);
  assert.equal(canPerformAction('doctor', 'settle_billing'), true);
  assert.equal(canPerformAction('nurse', 'register_patient'), true);
  assert.equal(canPerformAction('doctor', 'create_backup'), false);
  assert.equal(canPerformAction('nurse', 'record_vitals'), true);
});

test('verifyBackupIntegrity validates untouched snapshots and rejects tampered JSON', () => {
  const payload = JSON.stringify({ clinic: 'さくら内科クリニック', patients: 4, timestamp: '2026-11-09T09:00:00Z' });
  const checksum = computePayloadChecksum(payload);
  assert.equal(verifyBackupIntegrity(payload, checksum), true);
  assert.equal(verifyBackupIntegrity(payload + ' ', checksum), false);
});

test('evaluateLabFlag classifies normal, high, low, and critical lab measurements', () => {
  assert.equal(evaluateLabFlag(5.6, 4.6, 6.2), 'normal');
  assert.equal(evaluateLabFlag(6.8, 4.6, 6.2), 'high');
  assert.equal(evaluateLabFlag(10.5, 4.6, 6.2), 'critical');
  assert.equal(evaluateLabFlag(3.9, 4.6, 6.2), 'low');
});
