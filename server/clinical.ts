import { CLINIC_INFO } from '../src/data/seedData';
import type { AuditLogEntry, PatientRecord, StaffMember } from '../src/types/emr';
import { computePayloadChecksum, computeRecordHash } from '../src/utils/emrLogic';
import { canPerformAction, type EmrAction } from '../src/utils/permissions';
import { allergy, ClinicalError, diagnosis, labOrder, object, prescription, registration, requiredText, soapPatch, vitals } from './clinicalInput';
import { INITIAL_AUDIT_LOGS, INITIAL_BACKUPS, INITIAL_PATIENTS } from './clinicalSeed';

const operations = {
  soap: 'edit_soap',
  diagnosis: 'edit_soap',
  prescription: 'add_prescription',
  remove_prescription: 'add_prescription',
  lab_order: 'add_prescription',
  finalize: 'sign_soap',
  vitals: 'record_vitals',
  allergy: 'record_vitals',
  settle: 'settle_billing',
  referral: 'export_referral',
} as const satisfies Record<string, EmrAction>;
type Operation = keyof typeof operations;

type ClinicalRoute =
  | { kind: 'list'; method: 'GET'; action: 'view_chart' }
  | { kind: 'register'; method: 'POST'; action: 'register_patient' }
  | { kind: 'archive'; method: 'GET'; action: 'export_archive' }
  | { kind: 'admin'; method: 'GET'; action: 'view_audit' }
  | { kind: 'patient'; method: 'GET'; action: 'view_chart'; patientId: string }
  | { kind: 'operation'; method: 'POST'; action: EmrAction; patientId: string; operation: Operation };

type Actor = Omit<StaffMember, 'departmentCode'> & { departmentCode: string | null };
type ScopedPatient = { departmentCode: string; patient: PatientRecord };

export function clinicalRoute(path: string, method: string | undefined): ClinicalRoute | undefined {
  if (path === '/api/clinical/patients') {
    return method === 'POST'
      ? { kind: 'register', method: 'POST', action: 'register_patient' }
      : { kind: 'list', method: 'GET', action: 'view_chart' };
  }
  if (path === '/api/clinical/archive') return { kind: 'archive', method: 'GET', action: 'export_archive' };
  if (path === '/api/clinical/admin-demo') return { kind: 'admin', method: 'GET', action: 'view_audit' };
  const match = /^\/api\/clinical\/patients\/([A-Za-z0-9_-]{1,64})(?:\/([a-z_]+))?$/.exec(path);
  if (!match) return undefined;
  const [, patientId, operation] = match;
  if (!operation) return { kind: 'patient', method: 'GET', action: 'view_chart', patientId };
  if (Object.hasOwn(operations, operation)) {
    return { kind: 'operation', method: 'POST', action: operations[operation as Operation], patientId, operation: operation as Operation };
  }
}

const GENERAL = 'demo-general';
const SPECIALTY = 'demo-specialty';
const seedDepartments: Record<string, string> = {
  'PT-001042': GENERAL,
  'PT-001105': GENERAL,
  'PT-001089': GENERAL,
  'PT-000918': SPECIALTY,
};

function inScope(actor: Actor, entry: ScopedPatient): boolean {
  return actor.role === 'admin' || actor.departmentCode === entry.departmentCode;
}

function timestamp(): string {
  return new Date().toLocaleString('sv-SE', { timeZone: 'Asia/Tokyo' });
}

export function createClinicalDemo() {
  const patients = new Map([...INITIAL_PATIENTS].reverse().map((patient) => [
    patient.id, { departmentCode: seedDepartments[patient.id], patient: structuredClone(patient) },
  ]));
  const auditLogs = [...INITIAL_AUDIT_LOGS];

  function audit(actor: Actor, actionType: AuditLogEntry['actionType'], summary: string, patient?: PatientRecord) {
    const time = timestamp();
    auditLogs.unshift({
      id: `AUD-SERVER-${auditLogs.length + 1}`,
      timestamp: time, actorId: actor.id, actorName: actor.name, actorRole: actor.role, actionType,
      targetPatientId: patient?.id, targetPatientName: patient?.kanjiName,
      summary, integrityHash: computePayloadChecksum(`${time}:${actor.id}:${actionType}:${summary}`),
      ipAddress: 'loopback',
    });
  }

  function register(actor: Actor, body: unknown): PatientRecord {
    const departmentCode = actor.departmentCode ?? (actor.role === 'admin' ? GENERAL : null);
    if (!departmentCode) throw new ClinicalError(403, 'forbidden');
    const input = registration(body);
    const time = timestamp();
    const today = time.slice(0, 10);
    if (input.birthDate > today) throw new ClinicalError(400, 'invalid_input');
    const age = Number(today.slice(0, 4)) - Number(input.birthDate.slice(0, 4)) -
      Number(today.slice(5) < input.birthDate.slice(5));
    let sequence = patients.size + 1;
    while (patients.has(`PT-REG-${sequence}`)) sequence++;
    const patient: PatientRecord = {
      ...input, id: `PT-REG-${sequence}`, age, insurerNumber: '06139912',
      visitType: '初診', visitStatus: 'waiting', receptionTime: time.slice(11, 16),
      receptionNumber: `A-${String(sequence).padStart(3, '0')}`,
      allergies: [], contraindicatedClasses: [], diseases: [], vitalsHistory: [], labHistory: [],
      currentSoap: { subjective: '', objective: '', assessment: '', plan: '' },
      currentPrescriptions: [], currentLabOrders: [], isSigned: false, revisions: [], billingCompleted: false,
    };
    patients.set(patient.id, { departmentCode, patient });
    audit(actor, 'PATIENT_REGISTER', '新規来院受付', patient);
    return patient;
  }

  function finalize(patient: PatientRecord, actor: Actor, body: unknown) {
    if (patient.isSigned) throw new ClinicalError(409, 'already_finalized');
    const reason = requiredText(object(body).reason, 4000);
    const time = timestamp();
    const hpkiId = 'DEMO-SIGNATURE';
    const previousHash = patient.revisions[0]?.sha256Hash ?? 'GENESIS_00000000000000000000000000000000';
    const hash = computeRecordHash(patient.id, patient.currentSoap, patient.currentPrescriptions,
      patient.currentLabOrders, hpkiId, time, previousHash);
    const revisionNumber = patient.revisions.length + 1;
    patient.revisions.unshift({
      revisionNumber, timestamp: time, authorId: actor.id, authorName: actor.name, authorRole: actor.role,
      hpkiSignatureId: hpkiId, reasonForRevision: reason, soap: { ...patient.currentSoap },
      prescriptions: [...patient.currentPrescriptions], labOrders: [...patient.currentLabOrders],
      sha256Hash: hash, previousHash,
    });
    patient.visitStatus = patient.billingCompleted ? 'completed' : 'billing';
    patient.isSigned = true;
    patient.signedAt = time;
    patient.signedBy = actor.name;
    patient.hpkiCertId = hpkiId;
    patient.currentHash = hash;
    audit(actor, revisionNumber === 1 ? 'SOAP_SIGN' : 'SOAP_REVISION', `SOAP診療録 第${revisionNumber}版確定（デモ）`, patient);
  }

  function referral(patient: PatientRecord, actor: Actor, body: unknown) {
    const input = object(body);
    const hospital = requiredText(input.hospital);
    const purpose = requiredText(input.purpose, 4000);
    const content = [
      '診療情報提供書（操作デモ）', timestamp(), '', hospital, CLINIC_INFO.name, `担当：${actor.name}`, '',
      `患者：${patient.kanjiName}（${patient.kanaName}）`, `生年月日：${patient.birthDate}`,
      `傷病名：${patient.diseases.map((entry) => entry.name).join('、')}`, `紹介目的：${purpose}`, '',
      '病歴および治療経過', patient.currentSoap.subjective, '', '身体所見・検査結果', patient.currentSoap.objective, '',
      '処方', patient.currentPrescriptions.map((entry) => `${entry.drugName} ${entry.dosagePerDay}`).join(' / ') || 'なし',
      'アレルギー', patient.allergies.map((entry) => entry.substance).join('、') || 'なし',
    ].join('\n');
    audit(actor, 'DOCUMENT_EXPORT', '診療情報提供書を出力（デモ）', patient);
    return { filename: `dencal-referral-${patient.id}.txt`, content };
  }

  function update(patient: PatientRecord, actor: Actor, operation: Exclude<Operation, 'referral'>, body: unknown) {
    switch (operation) {
      case 'soap':
        patient.currentSoap = { ...patient.currentSoap, ...soapPatch(body) };
        patient.isSigned = false;
        break;
      case 'diagnosis': {
        const entry = diagnosis(body);
        patient.diseases = toggle(patient.diseases, entry);
        patient.isSigned = false;
        audit(actor, 'DIAGNOSIS_UPDATE', '登録傷病名を更新', patient);
        break;
      }
      case 'prescription': {
        const entry = prescription(body);
        if (patient.currentPrescriptions.some((existing) => existing.id === entry.id)) {
          throw new ClinicalError(409, 'duplicate_prescription');
        }
        patient.currentPrescriptions.push(entry);
        patient.isSigned = false;
        audit(actor, 'PRESCRIPTION_ADD', '処方オーダ追加', patient);
        break;
      }
      case 'remove_prescription': {
        const id = requiredText(object(body).id);
        patient.currentPrescriptions = patient.currentPrescriptions.filter((entry) => entry.id !== id);
        patient.isSigned = false;
        break;
      }
      case 'lab_order':
        patient.currentLabOrders = toggle(patient.currentLabOrders, labOrder(body));
        patient.isSigned = false;
        break;
      case 'finalize':
        finalize(patient, actor, body);
        break;
      case 'vitals':
        patient.vitalsHistory.unshift(vitals(body, timestamp()));
        break;
      case 'allergy':
        patient.allergies.push(allergy(body));
        break;
      case 'settle':
        if (patient.billingCompleted) throw new ClinicalError(409, 'already_settled');
        patient.visitStatus = 'completed';
        patient.billingCompleted = true;
        patient.receiptIssuedAt = timestamp();
        audit(actor, 'BILLING_SETTLE', '外来会計精算（デモ）', patient);
        break;
    }
    return patient;
  }

  return (route: ClinicalRoute, actor: Actor, body: unknown) => {
    if (!canPerformAction(actor.role, route.action)) throw new ClinicalError(403, 'forbidden');
    if (route.kind === 'list') {
      return { patients: Array.from(patients.values()).filter((entry) => inScope(actor, entry)).map((entry) => entry.patient).reverse() };
    }
    if (route.kind === 'register') return { patient: register(actor, body) };
    if (route.kind === 'admin') return { backups: INITIAL_BACKUPS, auditLogs };
    if (route.kind === 'archive') {
      audit(actor, 'DOCUMENT_EXPORT', '院内全カルテJSONアーカイブを出力（デモ）');
      return { exportedAt: new Date().toISOString(), clinic: CLINIC_INFO,
        patients: Array.from(patients.values(), (entry) => entry.patient), backupsCount: INITIAL_BACKUPS.length };
    }
    const entry = patients.get(route.patientId);
    if (!entry || !inScope(actor, entry)) throw new ClinicalError(404, 'not_found');
    const { patient } = entry;
    if (route.kind === 'patient') {
      audit(actor, 'RECORD_VIEW', '患者カルテを閲覧', patient);
      return { patient };
    }
    if (route.operation === 'referral') return referral(patient, actor, body);
    return { patient: update(patient, actor, route.operation, body) };
  };
}

function toggle<T extends { id: string }>(entries: T[], entry: T): T[] {
  return entries.some((existing) => existing.id === entry.id)
    ? entries.filter((existing) => existing.id !== entry.id)
    : [...entries, entry];
}
