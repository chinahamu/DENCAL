import {
  AllergyItem,
  DrugCatalogItem,
  FeeBreakdownItem,
  LabOrderItem,
  MedicalFeeCalculationResult,
  PatientRecord,
  PrescriptionItem,
  SoapContent,
} from '../types/emr';

/**
 * Computes a deterministic 64-character hexadecimal digest (SHA-256 style)
 * for medical record authenticity (厚労省ガイドライン「真正性」改ざん検知ハッシュ).
 * Pure synchronous function so it runs identically in Node unit tests and browser.
 */
export function computeRecordHash(
  patientId: string,
  soap: SoapContent,
  prescriptions: PrescriptionItem[],
  labOrders: LabOrderItem[],
  signerId: string,
  timestamp: string,
  previousHash: string = 'GENESIS_00000000000000000000000000000000'
): string {
  const canonicalPayload = JSON.stringify({
    patientId,
    s: soap.subjective.trim(),
    o: soap.objective.trim(),
    a: soap.assessment.trim(),
    p: soap.plan.trim(),
    rx: prescriptions.map((r) => `${r.yjCode}:${r.dosagePerDay}:${r.days}`),
    labs: labOrders.map((l) => l.code),
    signerId,
    timestamp,
    previousHash,
  });

  // 8 independent 32-bit FNV-1a / Murmur-style mixing lanes -> 64 hex chars (256-bit)
  const seeds = [
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
    0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ];

  const lanes = [...seeds];
  for (let i = 0; i < canonicalPayload.length; i++) {
    const code = canonicalPayload.charCodeAt(i);
    const laneIdx = i & 7;
    let h = lanes[laneIdx] ^ code;
    h = Math.imul(h ^ (h >>> 16), 0x85ebca6b);
    h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
    lanes[laneIdx] = (h ^ (h >>> 16)) >>> 0;
    // Cross-lane diffusion
    const nextLane = (laneIdx + 1) & 7;
    lanes[nextLane] = (lanes[nextLane] + ((lanes[laneIdx] << 5) | (lanes[laneIdx] >>> 27))) >>> 0;
  }

  return lanes.map((val) => val.toString(16).padStart(8, '0')).join('');
}

/**
 * Evaluates whether a lab value is within normal reference range.
 */
export function evaluateLabFlag(
  value: number,
  refMin: number,
  refMax: number
): 'normal' | 'high' | 'low' | 'critical' {
  if (value < refMin * 0.75 || value > refMax * 1.45) {
    return 'critical';
  }
  if (value > refMax) {
    return 'high';
  }
  if (value < refMin) {
    return 'low';
  }
  return 'normal';
}

export interface DrugSafetyWarning {
  severity: 'error' | 'warning';
  reason: string;
}

/**
 * Checks a candidate drug against patient allergies, contraindications, duplicate classes, and renal function (eGFR).
 */
export function checkDrugSafety(
  drug: DrugCatalogItem,
  allergies: AllergyItem[],
  contraindicatedClasses: string[],
  existingPrescriptions: PrescriptionItem[],
  latestEgfr?: number
): DrugSafetyWarning[] {
  const warnings: DrugSafetyWarning[] = [];

  // 1. Check direct allergy match or contraindication keywords
  for (const allergy of allergies) {
    const matchedKeyword = drug.contraindicationKeywords.some(
      (kw) =>
        allergy.substance.includes(kw) ||
        kw.includes(allergy.substance) ||
        drug.drugClass.includes(allergy.substance)
    );
    if (matchedKeyword || drug.drugName.includes(allergy.substance)) {
      warnings.push({
        severity: 'error',
        reason: `禁忌アラート：患者アレルギー歴「${allergy.substance}」（${allergy.reaction}）に該当する成分・系統（${drug.drugClass}）です。`,
      });
    }
  }

  // 2. Check contraindicated classes
  for (const contra of contraindicatedClasses) {
    if (
      drug.drugClass.includes(contra) ||
      drug.contraindicationKeywords.some((kw) => kw.includes(contra))
    ) {
      warnings.push({
        severity: 'error',
        reason: `投薬禁忌：患者の禁忌薬系統「${contra}」に一致します。`,
      });
    }
  }

  // 3. Check duplicate prescription
  if (existingPrescriptions.some((rx) => rx.yjCode === drug.yjCode)) {
    warnings.push({
      severity: 'warning',
      reason: `重複処方注意：「${drug.drugName}」は既に今回の処方オーダーに含まれています。`,
    });
  }

  // 4. Check renal function (eGFR)
  if (
    typeof latestEgfr === 'number' &&
    typeof drug.renalCautionEgfrBelow === 'number' &&
    latestEgfr < drug.renalCautionEgfrBelow
  ) {
    warnings.push({
      severity: 'warning',
      reason: `腎機能低下注意：直近eGFR (${latestEgfr} mL/min/1.73m²) が基準値 (${drug.renalCautionEgfrBelow}) 未満のため減量または慎重投与が必要です。`,
    });
  }

  return warnings;
}

/**
 * Calculates Japanese clinic medical fee points (診療報酬点数) and copayment (一部負担金: 10円単位四捨五入).
 * 1点 = 10円
 */
export function calculateMedicalFeePoints(
  visitType: '初診' | '再診',
  copayRatio: 0.1 | 0.2 | 0.3,
  hasChronicDiseaseTarget: boolean,
  prescriptions: PrescriptionItem[],
  labOrders: LabOrderItem[],
  mynaVerified: boolean
): MedicalFeeCalculationResult {
  const items: FeeBreakdownItem[] = [];

  // A000 初診料 (291点) / A001 再診料 (75点)
  if (visitType === '初診') {
    items.push({
      category: '初・再診料',
      name: '初診料',
      points: 291,
      note: 'A000 医療機関初診算定',
    });
  } else {
    items.push({
      category: '初・再診料',
      name: '再診料',
      points: 75,
      note: 'A001 外来再診算定',
    });
    if (labOrders.length === 0) {
      items.push({
        category: '初・再診料',
        name: '外来管理加算',
        points: 52,
        note: '処置・検査なし計画的医学管理',
      });
    }
  }

  // 医療情報取得加算・医療DX推進体制整備加算
  items.push({
    category: '加算',
    name: mynaVerified ? '医療DX推進体制整備加算（マイナ保険証確認）' : '医療情報取得加算',
    points: mynaVerified ? 10 : 3,
    note: mynaVerified ? 'オンライン資格確認・電子処方箋対応体制' : '資格確認体制',
  });

  // B000 特定疾患療養管理料 / 生活習慣病管理料 (再診時)
  if (visitType === '再診' && hasChronicDiseaseTarget) {
    items.push({
      category: '医学管理等',
      name: '特定疾患療養管理料（診療所）',
      points: 225,
      note: 'B000 主病に対する療養計画・服薬指導',
    });
  }

  // D 検査料 + 判断料
  if (labOrders.length > 0) {
    const labSum = labOrders.reduce((acc, item) => acc + item.points, 0);
    items.push({
      category: '検査',
      name: `検体検査・生体検査（${labOrders.length}項目）`,
      points: labSum,
      note: labOrders.map((l) => l.name).join('・'),
    });
    items.push({
      category: '検査',
      name: '生化学的検査(I)判断料',
      points: 144,
      note: 'D026 検体検査判断料',
    });
  }

  // F 投薬（院外処方箋料 + 一般名処方加算）
  if (prescriptions.length > 0) {
    items.push({
      category: '投薬',
      name: '処方箋料（その他）',
      points: 68,
      note: 'F400 院外処方箋発行',
    });
    const genericCount = prescriptions.filter((p) => p.genericAllowed).length;
    if (genericCount > 0) {
      items.push({
        category: '投薬',
        name: genericCount >= 2 ? '一般名処方加算1' : '一般名処方加算2',
        points: genericCount >= 2 ? 10 : 8,
        note: '後発医薬品一般名処方推進',
      });
    }
  }

  const totalPoints = items.reduce((sum, item) => sum + item.points, 0);
  const totalMedicalYen = totalPoints * 10;
  const rawCopay = totalMedicalYen * copayRatio;
  // 健康保険法第75条：一部負担金の端数処理（5円未満切り捨て、5円以上切り上げ＝10円単位四捨五入）
  const copayAmountYen = Math.round(rawCopay / 10) * 10;

  return {
    items,
    totalPoints,
    totalMedicalYen,
    copayRatio,
    copayAmountYen,
  };
}

export { canPerformAction, type EmrAction } from './permissions';

/**
 * Verifies backup snapshot payload integrity against its recorded SHA-256 style checksum.
 */
export function computePayloadChecksum(payloadJson: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  let h3 = 0x9e3779b9;
  let h4 = 0x85ebca6b;

  for (let i = 0; i < payloadJson.length; i++) {
    const c = payloadJson.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ (c + i), 0x85ebca6b) >>> 0;
    h3 = Math.imul(h3 ^ (c << 3), 0xc2b2ae35) >>> 0;
    h4 = Math.imul(h4 ^ (c ^ 0x5a), 0x27d4eb2f) >>> 0;
  }
  return [h1, h2, h3, h4, h1 ^ h3, h2 ^ h4, h1 ^ h4, h2 ^ h3]
    .map((n) => (n >>> 0).toString(16).padStart(8, '0'))
    .join('');
}

export function verifyBackupIntegrity(
  payloadJson: string,
  expectedChecksum: string
): boolean {
  if (!payloadJson || !expectedChecksum) return false;
  return computePayloadChecksum(payloadJson) === expectedChecksum;
}
