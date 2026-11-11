import { createHash } from 'node:crypto';
import type { DatabaseSync, SQLOutputValue } from 'node:sqlite';
import type { DiseaseRecord, LabOrderItem, PatientRecord, PrescriptionItem, SoapContent, SoapRevision, UserRole } from '../src/types/emr';
import { ClinicalError } from './clinicalInput';
import { INITIAL_PATIENTS } from './clinicalSeed';

export const GENERAL_DEPARTMENT = 'demo-general';

const seedDepartments: Record<string, string> = {
  'PT-001042': GENERAL_DEPARTMENT,
  'PT-001105': GENERAL_DEPARTMENT,
  'PT-001089': GENERAL_DEPARTMENT,
  'PT-000918': 'demo-specialty',
};

export type Actor = {
  staffId: number;
  databaseRole: 'reception' | 'nurse' | 'physician' | 'admin';
  id: string;
  name: string;
  role: UserRole;
  departmentCode: string | null;
};

type Workspace = Pick<PatientRecord,
  'mynaVerified' | 'allergies' | 'contraindicatedClasses' | 'diseases' | 'vitalsHistory' |
  'labHistory' | 'currentPrescriptions' | 'currentLabOrders' | 'billingCompleted' | 'receiptIssuedAt'
>;

type Row = Record<string, SQLOutputValue> & SoapContent & {
  encounter_id: number;
  department_code: string;
  patient_number: string;
  name: string;
  name_kana: string;
  sex: 'male' | 'female';
  birth_date: string;
  blood_type: string;
  phone: string;
  address: string;
  insurance_type: PatientRecord['insuranceType'];
  insurer_number: string;
  copay_percent: number;
  visit_type: 'first' | 'follow_up';
  status: PatientRecord['visitStatus'];
  reception_date: string;
  reception_number: string;
  checked_in_at: string;
  chief_complaint: string;
  data_json: string;
  version: number;
  is_open: number;
  finalized_revision: number;
  saved_by: number;
  saved_at: string;
  saved_name: string;
  correction_reason: string | null;
  correction_started_by: number | null;
  correction_started_at: string | null;
};

type RevisionRow = Record<string, SQLOutputValue> & SoapContent & {
  encounter_id: number;
  revision: number;
  previous_revision: number | null;
  finalized_by: number;
  finalized_at: string;
  correction_reason: string | null;
  content_sha256: string;
  content_json: string;
};

type RevisionContent = {
  authorId: string;
  authorName: string;
  authorRole: UserRole;
  enteredBy: number;
  enteredByName: string;
  enteredAt: string;
  correctionStartedBy: number | null;
  correctionStartedAt: string | null;
  prescriptions: PrescriptionItem[];
  labOrders: LabOrderItem[];
  diseases: DiseaseRecord[] | null;
};

export type Chart = { row: Row; patient: PatientRecord };

function soap(row: SoapContent): SoapContent {
  return { subjective: row.subjective, objective: row.objective, assessment: row.assessment, plan: row.plan };
}

function workspace(patient: PatientRecord): Workspace {
  const { mynaVerified, allergies, contraindicatedClasses, diseases, vitalsHistory, labHistory,
    currentPrescriptions, currentLabOrders, billingCompleted, receiptIssuedAt } = patient;
  return { mynaVerified, allergies, contraindicatedClasses, diseases, vitalsHistory, labHistory,
    currentPrescriptions, currentLabOrders, billingCompleted, receiptIssuedAt };
}

function digest(patientId: string, entry: RevisionRow, previousHash: string): string {
  return createHash('sha256').update(JSON.stringify([
    patientId, entry.encounter_id, entry.revision, entry.previous_revision, soap(entry), entry.finalized_by,
    entry.finalized_at, entry.correction_reason, entry.content_json, previousHash,
  ])).digest('hex');
}

function revisionHistory(db: DatabaseSync, row: Row): SoapRevision[] {
  const rows = db.prepare('SELECT * FROM clinical_note_revisions WHERE encounter_id = ? ORDER BY revision')
    .all(row.encounter_id) as RevisionRow[];
  const history: SoapRevision[] = [];
  let previousHash = '';
  for (const entry of rows) {
    const expectedNumber = history.length + 1;
    if (entry.revision !== expectedNumber || entry.previous_revision !== (expectedNumber > 1 ? expectedNumber - 1 : null) ||
        !entry.content_json || digest(row.patient_number, entry, previousHash) !== entry.content_sha256) {
      throw new ClinicalError(409, 'record_integrity_error');
    }
    const content = JSON.parse(entry.content_json) as RevisionContent;
    history.push({
      revisionNumber: entry.revision,
      timestamp: entry.finalized_at,
      authorId: content.authorId,
      authorName: content.authorName,
      authorRole: content.authorRole,
      enteredByName: content.enteredByName,
      enteredAt: content.enteredAt,
      reasonForRevision: entry.correction_reason ?? '',
      soap: soap(entry), prescriptions: content.prescriptions, labOrders: content.labOrders,
      diseases: content.diseases ?? undefined,
      sha256Hash: entry.content_sha256, previousHash,
    });
    previousHash = entry.content_sha256;
  }
  if (history.length !== row.finalized_revision) throw new ClinicalError(409, 'record_integrity_error');
  return history.reverse();
}

const chartSelect = `
  SELECT e.id AS encounter_id, d.code AS department_code, p.patient_number, p.name, p.name_kana,
    p.sex, p.birth_date, p.blood_type, p.phone, p.address, i.insurance_type, i.insurer_number, i.copay_percent,
    e.visit_type, e.status, e.reception_date, e.reception_number, e.checked_in_at, e.chief_complaint,
    w.data_json, n.version, n.is_open, n.finalized_revision, n.subjective, n.objective, n.assessment, n.plan,
    n.saved_by, n.saved_at, s.display_name AS saved_name, n.correction_reason,
    n.correction_started_by, n.correction_started_at
  FROM clinical_workspaces w JOIN encounters e ON e.id = w.encounter_id
  JOIN patients p ON p.id = e.patient_id JOIN departments d ON d.id = e.department_id
  JOIN patient_insurances i ON i.id = e.insurance_id
  JOIN clinical_note_drafts n ON n.encounter_id = e.id JOIN staff s ON s.id = n.saved_by
`;

function asChart(db: DatabaseSync, row: Row): Chart {
  const revisions = revisionHistory(db, row);
  const latest = revisions[0];
  const isSigned = row.is_open === 0;
  if (isSigned && !latest) throw new ClinicalError(409, 'record_integrity_error');
  const age = Number(row.reception_date.slice(0, 4)) - Number(row.birth_date.slice(0, 4)) -
    Number(row.reception_date.slice(5) < row.birth_date.slice(5));
  const data = JSON.parse(row.data_json) as Workspace;
  return {
    row,
    patient: {
      ...data, id: row.patient_number, kanjiName: row.name, kanaName: row.name_kana,
      sex: row.sex === 'male' ? '男性' : '女性', birthDate: row.birth_date, age,
      bloodType: row.blood_type, phone: row.phone, address: row.address, insuranceType: row.insurance_type,
      insurerNumber: row.insurer_number, copayRatio: (row.copay_percent / 100) as PatientRecord['copayRatio'],
      visitType: row.visit_type === 'first' ? '初診' : '再診', visitStatus: row.status,
      receptionTime: row.checked_in_at.slice(11, 16), receptionNumber: row.reception_number, chiefComplaint: row.chief_complaint,
      currentSoap: isSigned ? latest.soap : soap(row), isSigned, revisions,
      ...(isSigned && {
        currentPrescriptions: latest.prescriptions, currentLabOrders: latest.labOrders, diseases: latest.diseases ?? data.diseases,
        signedAt: latest.timestamp, signedBy: latest.authorName, currentHash: latest.sha256Hash,
      }),
      draftVersion: row.version, draftSavedAt: row.saved_at, draftSavedBy: row.saved_name,
      correctionReason: row.correction_reason ?? undefined,
    },
  };
}

export function findChart(db: DatabaseSync, actor: Actor, patientId: string): Chart {
  const row = db.prepare(chartSelect + ' WHERE p.patient_number = ? AND (? = 1 OR d.code = ?) ORDER BY e.id DESC LIMIT 1')
    .get(patientId, Number(actor.role === 'admin'), actor.departmentCode) as Row | undefined;
  if (!row) throw new ClinicalError(404, 'not_found');
  return asChart(db, row);
}

export function listCharts(db: DatabaseSync, actor: Actor): PatientRecord[] {
  const rows = db.prepare(chartSelect + ' WHERE (? = 1 OR d.code = ?) ORDER BY e.id DESC')
    .all(Number(actor.role === 'admin'), actor.departmentCode) as Row[];
  return rows.map((row) => asChart(db, row).patient);
}

export function insertChart(db: DatabaseSync, patient: PatientRecord, department: string, staffId: number, time: string, correctionReason?: string) {
  const { lastInsertRowid: patientId } = db.prepare(`
    INSERT INTO patients(patient_number, name, name_kana, sex, birth_date, blood_type, phone, address)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(patient.id, patient.kanjiName, patient.kanaName, patient.sex === '男性' ? 'male' : 'female',
    patient.birthDate, patient.bloodType, patient.phone, patient.address);
  const date = time.slice(0, 10);
  const { lastInsertRowid: insuranceId } = db.prepare(`
    INSERT INTO patient_insurances(patient_id, insurance_type, insurer_number, copay_percent, valid_from)
    VALUES (?, ?, ?, ?, ?)
  `).run(patientId, patient.insuranceType, patient.insurerNumber, Math.round(patient.copayRatio * 100), date);
  const { lastInsertRowid: encounterId } = db.prepare(`
    INSERT INTO encounters(patient_id, department_id, insurance_id, reception_date, reception_number,
      checked_in_at, checked_in_by, visit_type, status, chief_complaint)
    VALUES (?, (SELECT id FROM departments WHERE code = ?), ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(patientId, department, insuranceId, date, patient.receptionNumber, time, staffId,
    patient.visitType === '初診' ? 'first' : 'follow_up', patient.visitStatus, patient.chiefComplaint);
  db.prepare('INSERT INTO clinical_workspaces(encounter_id, data_json) VALUES (?, ?)')
    .run(encounterId, JSON.stringify(workspace(patient)));
  const { subjective, objective, assessment, plan } = patient.currentSoap;
  db.prepare(`
    INSERT INTO clinical_note_drafts(encounter_id, version, subjective, objective, assessment, plan, saved_by,
      saved_at, is_open, correction_reason, correction_started_by, correction_started_at)
    VALUES (?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(encounterId, subjective, objective, assessment, plan, staffId, time, Number(!patient.isSigned),
    correctionReason ?? null, correctionReason ? staffId : null, correctionReason ? time : null);
  return Number(encounterId);
}

export function saveWorkspace(db: DatabaseSync, { row, patient }: Chart) {
  db.prepare('UPDATE clinical_workspaces SET data_json = ? WHERE encounter_id = ?')
    .run(JSON.stringify(workspace(patient)), row.encounter_id);
  db.prepare('UPDATE encounters SET status = ? WHERE id = ?').run(patient.visitStatus, row.encounter_id);
}

export function saveDraft(db: DatabaseSync, { row, patient }: Chart, actor: Actor, time: string) {
  const { subjective, objective, assessment, plan } = patient.currentSoap;
  db.prepare(`
    UPDATE clinical_note_drafts SET version = version + 1, subjective = ?, objective = ?, assessment = ?, plan = ?,
      saved_by = ?, saved_at = ? WHERE encounter_id = ?
  `).run(subjective, objective, assessment, plan, actor.staffId, time, row.encounter_id);
}

export function startCorrection(db: DatabaseSync, { row, patient }: Chart, actor: Actor, reason: string, time: string) {
  const latest = patient.revisions[0];
  const { subjective, objective, assessment, plan } = latest.soap;
  saveWorkspace(db, { row, patient });
  db.prepare(`
    UPDATE clinical_note_drafts SET version = version + 1, is_open = 1, correction_reason = ?,
      correction_started_by = ?, correction_started_at = ?, saved_by = ?, saved_at = ?,
      subjective = ?, objective = ?, assessment = ?, plan = ? WHERE encounter_id = ?
  `).run(reason, actor.staffId, time, actor.staffId, time, subjective, objective, assessment, plan, row.encounter_id);
}

function appendRevision(db: DatabaseSync, encounterId: number, patientId: string, snapshot: SoapContent,
    revision: number, finalizedBy: number, time: string, reason: string | null, content: RevisionContent, previousHash: string) {
  const entry: RevisionRow = {
    ...snapshot, encounter_id: encounterId, revision, previous_revision: revision === 1 ? null : revision - 1,
    finalized_by: finalizedBy, finalized_at: time, correction_reason: reason,
    content_json: JSON.stringify(content), content_sha256: '',
  };
  const hash = digest(patientId, entry, previousHash);
  db.prepare(`
    INSERT INTO clinical_note_revisions(encounter_id, revision, previous_revision, subjective, objective, assessment,
      plan, finalized_by, finalized_at, correction_reason, content_sha256, content_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(encounterId, revision, entry.previous_revision, entry.subjective, entry.objective, entry.assessment,
    entry.plan, finalizedBy, time, reason, hash, entry.content_json);
  return hash;
}

export function finalizeDraft(db: DatabaseSync, { row, patient }: Chart, actor: Actor, time: string) {
  const latest = patient.revisions[0];
  const content: RevisionContent = {
    authorId: actor.id, authorName: actor.name, authorRole: actor.role, enteredBy: row.saved_by,
    enteredByName: row.saved_name, enteredAt: row.saved_at, correctionStartedBy: row.correction_started_by,
    correctionStartedAt: row.correction_started_at, prescriptions: patient.currentPrescriptions,
    labOrders: patient.currentLabOrders, diseases: patient.diseases,
  };
  const revision = row.finalized_revision + 1;
  appendRevision(db, row.encounter_id, patient.id, patient.currentSoap, revision,
    actor.staffId, time, row.correction_reason, content, latest?.sha256Hash ?? '');
  db.prepare(`
    UPDATE clinical_note_drafts SET version = version + 1, is_open = 0, finalized_revision = ?, correction_reason = NULL,
      correction_started_by = NULL, correction_started_at = NULL WHERE encounter_id = ?
  `).run(revision, row.encounter_id);
  const status = patient.billingCompleted ? 'completed' : 'billing';
  db.prepare('UPDATE encounters SET status = ? WHERE id = ?').run(status, row.encounter_id);
}

export function seedClinicalCharts(db: DatabaseSync) {
  // Historical demo entries have no login credentials and can never sign in.
  db.exec(`INSERT INTO staff(staff_code, display_name, role, active)
    VALUES ('demo-history-author', '初期サンプル記録', 'physician', 0) ON CONFLICT(staff_code) DO NOTHING`);
  const staffId = Number(db.prepare("SELECT id FROM staff WHERE staff_code = 'demo-history-author'").get()!.id);
  for (const patient of [...INITIAL_PATIENTS].reverse()) {
    if (db.prepare('SELECT 1 FROM patients WHERE patient_number = ?').get(patient.id)) continue;
    const received = `2026-11-09 ${patient.receptionTime}:00`;
    const encounterId = insertChart(db, patient, seedDepartments[patient.id], staffId, received,
      !patient.isSigned && patient.revisions.length ? '初期サンプルの訂正下書き' : undefined);
    const revisions = [...patient.revisions].reverse();
    if (patient.isSigned && revisions.length === 0) {
      revisions.push({
        revisionNumber: 1, timestamp: patient.signedAt ?? received, authorId: 'demo-history-author',
        authorName: patient.signedBy ?? '初期サンプル記録', authorRole: 'doctor',
        reasonForRevision: '', soap: patient.currentSoap, prescriptions: patient.currentPrescriptions,
        labOrders: patient.currentLabOrders, diseases: patient.diseases, sha256Hash: '', previousHash: '',
      });
    }
    let previousHash = '';
    for (const revision of revisions) {
      previousHash = appendRevision(db, encounterId, patient.id, revision.soap, revision.revisionNumber,
        staffId, revision.timestamp, revision.revisionNumber > 1 ? revision.reasonForRevision : null, {
          authorId: revision.authorId, authorName: revision.authorName, authorRole: revision.authorRole,
          enteredBy: staffId, enteredByName: '初期サンプル記録', enteredAt: revision.timestamp,
          correctionStartedBy: null, correctionStartedAt: null, prescriptions: revision.prescriptions,
          labOrders: revision.labOrders, diseases: revision.diseases ?? null,
        }, previousHash);
    }
    db.prepare('UPDATE clinical_note_drafts SET finalized_revision = ? WHERE encounter_id = ?')
      .run(revisions.length, encounterId);
  }
}
