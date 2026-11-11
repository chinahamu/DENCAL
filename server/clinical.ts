import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { CLINIC_INFO } from '../src/data/seedData';
import type { AuditLogEntry, PatientRecord, UserRole } from '../src/types/emr';
import { canPerformAction, type EmrAction } from '../src/utils/permissions';
import { allergy, ClinicalError, diagnosis, labOrder, object, prescription, registration, requiredText, soapPatch, vitals } from './clinicalInput';
import { finalizedRecordDocument, searchFinalizedRecords } from './recordDocuments';
import { INITIAL_AUDIT_LOGS, INITIAL_BACKUPS } from './clinicalSeed';
import {
  findChart, findEncounterChart, finalizeDraft, GENERAL_DEPARTMENT, insertChart, listCharts, saveDraft, saveWorkspace, startCorrection,
  type Actor, type Chart,
} from './clinicalStore';

const operations = {
  soap: 'edit_soap',
  diagnosis: 'edit_soap',
  prescription: 'add_prescription',
  remove_prescription: 'add_prescription',
  lab_order: 'add_prescription',
  finalize: 'sign_soap',
  start_correction: 'edit_soap',
  vitals: 'record_vitals',
  allergy: 'record_vitals',
  settle: 'settle_billing',
  referral: 'export_referral',
} as const satisfies Record<string, EmrAction>;
type Operation = keyof typeof operations;

type ClinicalRoute =
  | { kind: 'list'; method: 'GET'; action: 'view_chart' }
  | { kind: 'register'; method: 'POST'; action: 'register_patient' }
  | { kind: 'record_search'; method: 'GET'; action: 'view_chart' }
  | { kind: 'record'; method: 'GET' | 'POST'; action: 'view_chart' | 'export_record'; encounterId: number; revision: number }
  | { kind: 'archive'; method: 'GET'; action: 'export_archive' }
  | { kind: 'admin'; method: 'GET'; action: 'view_audit' }
  | { kind: 'patient'; method: 'GET'; action: 'view_chart'; patientId: string }
  | { kind: 'operation'; method: 'POST'; action: EmrAction; patientId: string; operation: Operation };

export function clinicalRoute(path: string, method: string | undefined): ClinicalRoute | undefined {
  if (path === '/api/clinical/patients') {
    return method === 'POST'
      ? { kind: 'register', method: 'POST', action: 'register_patient' }
      : { kind: 'list', method: 'GET', action: 'view_chart' };
  }
  if (path === '/api/clinical/records') return { kind: 'record_search', method: 'GET', action: 'view_chart' };
  const record = /^\/api\/clinical\/records\/([1-9][0-9]{0,15})\/([1-9][0-9]{0,15})(\/export)?$/.exec(path);
  if (record) {
    const encounterId = Number(record[1]);
    const revision = Number(record[2]);
    if (!Number.isSafeInteger(encounterId) || !Number.isSafeInteger(revision)) return undefined;
    return { kind: 'record', method: record[3] ? 'POST' : 'GET',
      action: record[3] ? 'export_record' : 'view_chart', encounterId, revision };
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

const roleLabels = {
  reception: 'clerk', nurse: 'nurse', physician: 'doctor', admin: 'admin',
} as const satisfies Record<Actor['databaseRole'], UserRole>;

function timestamp(): string {
  return new Date().toLocaleString('sv-SE', { timeZone: 'Asia/Tokyo' });
}

function audit(db: DatabaseSync, actor: Actor, action: AuditLogEntry['actionType'], summary: string, chart?: Chart) {
  const time = timestamp();
  const encounter = chart?.row.encounter_id ?? null;
  const hash = createHash('sha256').update(JSON.stringify([time, actor.staffId, action, encounter, summary])).digest('hex');
  db.prepare(`
    INSERT INTO audit_events(occurred_at, actor_id, actor_role, action, patient_id, encounter_id, outcome,
      terminal_reference, integrity_sha256, clinical_summary)
    VALUES (?, ?, ?, ?, (SELECT patient_id FROM encounters WHERE id = ?), ?, 'success', 'loopback', ?, ?)
  `).run(time, actor.staffId, actor.databaseRole, action, encounter, encounter, hash, summary);
}

function auditHistory(db: DatabaseSync): AuditLogEntry[] {
  const events = db.prepare(`
    SELECT a.id, a.occurred_at, a.actor_role, a.action, a.terminal_reference, a.integrity_sha256, a.clinical_summary,
      s.staff_code, s.display_name, p.patient_number, p.name
    FROM audit_events a JOIN staff s ON s.id = a.actor_id LEFT JOIN patients p ON p.id = a.patient_id
    WHERE a.clinical_summary IS NOT NULL ORDER BY a.id DESC
  `).all();
  return [...events.map((row): AuditLogEntry => ({
    id: `AUD-DB-${row.id}`, timestamp: String(row.occurred_at), actorId: String(row.staff_code),
    actorName: String(row.display_name), actorRole: roleLabels[row.actor_role as Actor['databaseRole']],
    actionType: row.action as AuditLogEntry['actionType'], targetPatientId: row.patient_number as string | undefined,
    targetPatientName: row.name as string | undefined, summary: String(row.clinical_summary),
    integrityHash: String(row.integrity_sha256), ipAddress: String(row.terminal_reference),
  })), ...INITIAL_AUDIT_LOGS];
}

function register(db: DatabaseSync, actor: Actor, body: unknown): PatientRecord {
  const departmentCode = actor.departmentCode ?? (actor.role === 'admin' ? GENERAL_DEPARTMENT : null);
  if (!departmentCode) throw new ClinicalError(403, 'forbidden');
  const input = registration(body);
  const time = timestamp();
  const today = time.slice(0, 10);
  if (input.birthDate > today) throw new ClinicalError(400, 'invalid_input');
  let sequence = Number(db.prepare('SELECT coalesce(max(id), 0) + 1 AS next FROM patients').get()!.next);
  const used = db.prepare(`
    SELECT 1 FROM patients WHERE patient_number = ?
    UNION ALL SELECT 1 FROM encounters e JOIN departments d ON d.id = e.department_id
      WHERE d.code = ? AND e.reception_date = ? AND e.reception_number = ?
    LIMIT 1
  `);
  const receptionNumber = () => `A-${String(sequence).padStart(3, '0')}`;
  while (used.get(`PT-REG-${sequence}`, departmentCode, today, receptionNumber())) sequence++;
  const patient: PatientRecord = {
    ...input, id: `PT-REG-${sequence}`, age: 0, insurerNumber: '06139912',
    visitType: '初診', visitStatus: 'waiting', receptionTime: time.slice(11, 16), receptionNumber: receptionNumber(),
    allergies: [], contraindicatedClasses: [], diseases: [], vitalsHistory: [], labHistory: [],
    currentSoap: { subjective: '', objective: '', assessment: '', plan: '' },
    currentPrescriptions: [], currentLabOrders: [], isSigned: false, revisions: [], billingCompleted: false,
  };
  insertChart(db, patient, departmentCode, actor.staffId, time);
  const chart = findChart(db, actor, patient.id);
  audit(db, actor, 'PATIENT_REGISTER', '新規来院受付', chart);
  return chart.patient;
}

function referral(db: DatabaseSync, chart: Chart, actor: Actor, body: unknown) {
  const { patient } = chart;
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
  audit(db, actor, 'DOCUMENT_EXPORT', '診療情報提供書を出力（デモ）', chart);
  return { filename: `dencal-referral-${patient.id}.txt`, content };
}


// SOAP and orders share a version because they are finalized together.
const draftOperations = new Set<Operation>([
  'soap', 'diagnosis', 'prescription', 'remove_prescription', 'lab_order', 'finalize', 'start_correction',
]);

function update(db: DatabaseSync, chart: Chart, actor: Actor, operation: Exclude<Operation, 'referral'>, body: unknown) {
  const { patient, row } = chart;
  const time = timestamp();
  const editsDraft = draftOperations.has(operation);
  if (editsDraft) {
    const request = object(body);
    if (!Number.isSafeInteger(request.expectedVersion)) throw new ClinicalError(400, 'invalid_input');
    if (request.expectedVersion !== row.version) throw new ClinicalError(409, 'stale_draft');
    if (operation === 'start_correction') {
      if (!patient.isSigned) throw new ClinicalError(409, 'draft_open');
      const reason = requiredText(object(request.data).reason, 4000);
      startCorrection(db, chart, actor, reason, time);
      audit(db, actor, 'SOAP_CORRECTION_START', '診療録の訂正を開始', chart);
      return findChart(db, actor, patient.id).patient;
    }
    if (patient.isSigned) throw new ClinicalError(409, 'already_finalized');
    if (operation === 'finalize') {
      finalizeDraft(db, chart, actor, time);
      const revision = patient.revisions.length + 1;
      audit(db, actor, revision === 1 ? 'SOAP_SIGN' : 'SOAP_REVISION', `診療録 第${revision}版を確定`, chart);
      return findChart(db, actor, patient.id).patient;
    }
    body = request.data;
  }
  switch (operation) {
    case 'soap':
      patient.currentSoap = { ...patient.currentSoap, ...soapPatch(body) };
      audit(db, actor, 'SOAP_SAVE', '診療録の下書きを保存', chart);
      break;
    case 'diagnosis': {
      const entry = diagnosis(body);
      patient.diseases = toggle(patient.diseases, entry);
      audit(db, actor, 'DIAGNOSIS_UPDATE', '登録傷病名を更新', chart);
      break;
    }
    case 'prescription': {
      const entry = prescription(body);
      if (patient.currentPrescriptions.some((existing) => existing.id === entry.id)) {
        throw new ClinicalError(409, 'duplicate_prescription');
      }
      patient.currentPrescriptions.push(entry);
      audit(db, actor, 'PRESCRIPTION_ADD', '処方オーダ追加', chart);
      break;
    }
    case 'remove_prescription': {
      const id = requiredText(object(body).id);
      patient.currentPrescriptions = patient.currentPrescriptions.filter((entry) => entry.id !== id);
      break;
    }
    case 'lab_order':
      patient.currentLabOrders = toggle(patient.currentLabOrders, labOrder(body));
      break;
    case 'vitals':
      patient.vitalsHistory.unshift(vitals(body, time));
      break;
    case 'allergy':
      patient.allergies.push(allergy(body));
      break;
    case 'settle':
      if (patient.billingCompleted) throw new ClinicalError(409, 'already_settled');
      patient.visitStatus = 'completed';
      patient.billingCompleted = true;
      patient.receiptIssuedAt = time;
      audit(db, actor, 'BILLING_SETTLE', '外来会計精算（デモ）', chart);
      break;
  }
  if (operation !== 'soap') saveWorkspace(db, chart);
  if (editsDraft) saveDraft(db, chart, actor, time);
  return findChart(db, actor, patient.id).patient;
}

export function handleClinical(db: DatabaseSync, route: ClinicalRoute, actor: Actor, body: unknown, params: URLSearchParams) {
  if (!canPerformAction(actor.role, route.action)) throw new ClinicalError(403, 'forbidden');
  if (route.kind === 'list') return { patients: listCharts(db, actor) };
  if (route.kind === 'register') return { patient: register(db, actor, body) };
  if (route.kind === 'admin') return { backups: INITIAL_BACKUPS, auditLogs: auditHistory(db) };
  if (route.kind === 'record_search') return searchFinalizedRecords(db, actor, params);
  if (route.kind === 'record') {
    const chart = findEncounterChart(db, actor, route.encounterId);
    const document = finalizedRecordDocument(chart, route.revision);
    const exporting = route.action === 'export_record';
    audit(db, actor, exporting ? 'DOCUMENT_EXPORT' : 'RECORD_VIEW',
      `診療録 第${route.revision}版を${exporting ? '出力' : '閲覧'}`, chart);
    return document;
  }
  if (route.kind === 'archive') {
    audit(db, actor, 'DOCUMENT_EXPORT', '院内全カルテJSONアーカイブを出力（デモ）');
    return { exportedAt: new Date().toISOString(), clinic: CLINIC_INFO,
      patients: listCharts(db, actor), backupsCount: INITIAL_BACKUPS.length };
  }
  const chart = findChart(db, actor, route.patientId);
  if (route.kind === 'patient') {
    audit(db, actor, 'RECORD_VIEW', '患者カルテを閲覧', chart);
    return { patient: chart.patient };
  }
  if (route.operation === 'referral') return referral(db, chart, actor, body);
  return { patient: update(db, chart, actor, route.operation, body) };
}

function toggle<T extends { id: string }>(entries: T[], entry: T): T[] {
  return entries.some((existing) => existing.id === entry.id)
    ? entries.filter((existing) => existing.id !== entry.id)
    : [...entries, entry];
}
