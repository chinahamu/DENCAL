import { createHash, randomUUID } from 'node:crypto';
import type { DatabaseSync, SQLOutputValue } from 'node:sqlite';
import { readTransfer, MAX_BODY_BYTES, validateResponse } from '../integration/recept-v1/contract.mjs';
import { CLINIC_INFO } from '../src/data/seedData';
import type { PerformedProcedure, ReceptOutboxItem, ReceptReceipt, ReceptWorkspace } from '../src/types/recept';
import { performanceMaster } from './catalog';
import { calendarDate, ClinicalError, object, requiredText } from './clinicalInput';
import type { Actor, Chart } from './clinicalStore';

type Row = Record<string, SQLOutputValue> & {
  integration_id: string;
  encounter_id: number;
  chart_revision: number;
  transfer_revision: number;
  event: ReceptOutboxItem['event'];
  payload: Uint8Array;
  body_sha256: string;
  queued_at: string;
  attempts: number;
  lease_until: number | null;
  receipt_json: string | null;
  last_error: string | null;
};

type PerformanceRow = Record<string, SQLOutputValue> & PerformedProcedure & { publishedOn: string; sha256: string };

function today() {
  return new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Tokyo' });
}

function performanceRows(db: DatabaseSync, chart: Chart) {
  return db.prepare(`
    SELECT p.source_id AS id, i.code, i.name, p.service_date AS performedOn, p.quantity, p.unit,
      p.cancelled_at AS cancelledAt, p.cancellation_reason AS cancellationReason,
      r.effective_from AS publishedOn, r.file_sha256 AS sha256
    FROM procedure_performances p JOIN master_items i ON i.id = p.master_item_id
    JOIN master_releases r ON r.id = i.release_id WHERE p.encounter_id = ? ORDER BY p.id
  `).all(chart.row.encounter_id) as PerformanceRow[];
}

function listOutbox(db: DatabaseSync, encounterId: number) {
  return db.prepare('SELECT * FROM recept_outbox WHERE encounter_id = ? ORDER BY transfer_revision')
    .all(encounterId) as Row[];
}

function identity(db: DatabaseSync) {
  const sender = db.prepare('SELECT sender_id FROM recept_identity WHERE id = 1').get();
  if (typeof sender?.sender_id !== 'string') throw new ClinicalError(409, 'recept_outbox_integrity_error');
  return { facilityId: CLINIC_INFO.facilityCode, senderId: sender.sender_id };
}

function transportConfig() {
  const target = process.env.DENCAL_RECEPT_URL;
  const token = process.env.DENCAL_RECEPT_TOKEN;
  if (!target || !token || !/^[A-Za-z0-9._~+\/=-]{1,512}$/.test(token)) return undefined;
  try {
    const url = new URL(target);
    if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port ||
        url.username || url.password || url.search || url.hash || url.pathname !== '/') return undefined;
    return { endpoint: new URL('/api/integration/v1/encounters', url), token };
  } catch {
    return undefined;
  }
}

function summary(row: Row): ReceptOutboxItem {
  const payload = verifiedPayload(row);
  return {
    id: row.integration_id, chartRevision: row.chart_revision, transferRevision: row.transfer_revision,
    event: row.event, queuedAt: row.queued_at, attempts: row.attempts,
    sending: row.lease_until !== null && row.lease_until > Date.now(),
    receipt: row.receipt_json ? JSON.parse(row.receipt_json) as ReceptReceipt : null, lastError: row.last_error,
    diagnosisCodes: payload.diagnoses.map(({ code }) => code),
    performedItems: payload.performances.map(({ id, code, performedOn, quantity, unit, status }) =>
      ({ id, code, performedOn, quantity, unit, status })),
  };
}

export function receptWorkspace(db: DatabaseSync, chart: Chart): ReceptWorkspace {
  const rows = performanceRows(db, chart);
  const performances = rows.map(({ publishedOn: _publishedOn, sha256: _sha256, ...entry }) => entry);
  return {
    ...identity(db), performances, outbox: listOutbox(db, chart.row.encounter_id).map(summary),
    visitDate: chart.row.reception_date, today: today(), finalized: chart.patient.isSigned,
    chartRevision: chart.patient.revisions[0]?.revisionNumber ?? null,
    performanceVersion: hash(Buffer.from(JSON.stringify(rows))),
    transportConfigured: Boolean(transportConfig()),
  };
}

export function addPerformance(db: DatabaseSync, chart: Chart, actor: Actor, body: unknown) {
  const input = object(body);
  const performedOn = calendarDate(input.performedOn);
  const id = requiredText(input.id, 64);
  if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(id)) throw new ClinicalError(400, 'invalid_input');
  if (performedOn < chart.row.reception_date || performedOn > today() ||
      typeof input.masterItemId !== 'number' || !Number.isSafeInteger(input.masterItemId) || input.masterItemId < 1 ||
      typeof input.quantity !== 'number' || !Number.isFinite(input.quantity) || input.quantity <= 0 || input.quantity > 1_000_000) {
    throw new ClinicalError(400, 'invalid_input');
  }
  const unit = requiredText(input.unit, 32);
  const existing = db.prepare('SELECT encounter_id, master_item_id, service_date, quantity, unit FROM procedure_performances WHERE source_id = ?').get(id);
  if (existing) {
    if (existing.encounter_id === chart.row.encounter_id && existing.master_item_id === input.masterItemId &&
        existing.service_date === performedOn && existing.quantity === input.quantity && existing.unit === unit) return false;
    throw new ClinicalError(409, 'recept_performance_id_conflict');
  }
  const master = performanceMaster(db, input.masterItemId, performedOn);
  if (!master) throw new ClinicalError(409, 'recept_procedure_master_required');
  if (unit !== (String(master.unit).trim() || '回')) throw new ClinicalError(400, 'recept_procedure_unit_mismatch');
  db.prepare(`
    INSERT INTO procedure_performances(source_id, encounter_id, master_item_id, performed_by,
      performed_at, service_date, quantity, unit) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, chart.row.encounter_id, input.masterItemId, actor.staffId,
    new Date().toISOString(), performedOn, input.quantity, unit);
  return true;
}

export function cancelPerformance(db: DatabaseSync, chart: Chart, actor: Actor, body: unknown): boolean {
  const input = object(body);
  const id = requiredText(input.id, 64);
  const reason = requiredText(input.reason, 512);
  const changes = db.prepare(`
    UPDATE procedure_performances SET cancelled_by = ?, cancelled_at = ?, cancellation_reason = ?
    WHERE encounter_id = ? AND source_id = ? AND cancelled_at IS NULL
  `).run(actor.staffId, new Date().toISOString(), reason, chart.row.encounter_id, id).changes;
  if (!changes && !db.prepare('SELECT 1 FROM procedure_performances WHERE encounter_id = ? AND source_id = ?')
    .get(chart.row.encounter_id, id)) throw new ClinicalError(404, 'not_found');
  return changes > 0;
}

function hash(bytes: Uint8Array) {
  return createHash('sha256').update(bytes).digest('hex');
}

function validReceipt(receipt: unknown, id: string, digest: string): receipt is ReceptReceipt {
  return Boolean(validateResponse(receipt) && typeof receipt === 'object' && receipt !== null &&
    'integrationId' in receipt && receipt.integrationId === id && 'bodySha256' in receipt && receipt.bodySha256 === digest);
}

function verifiedPayload(row: Row) {
  const { message } = readTransfer(row.payload);
  if (!message || hash(row.payload) !== row.body_sha256 || message.integrationId !== row.integration_id ||
      message.encounterId !== String(row.encounter_id) || message.chartRevision !== row.chart_revision ||
      message.transferRevision !== row.transfer_revision || message.event !== row.event ||
      (row.receipt_json && !validReceipt(JSON.parse(row.receipt_json), row.integration_id, row.body_sha256))) {
    throw new ClinicalError(409, 'recept_outbox_integrity_error');
  }
  return message;
}

export function verifyReceptOutbox(db: DatabaseSync) {
  for (const row of db.prepare('SELECT * FROM recept_outbox').iterate()) verifiedPayload(row as Row);
}

export function queueRecept(db: DatabaseSync, chart: Chart, actor: Actor, body: unknown): boolean {
  const input = object(body);
  if (input.event !== 'upsert' && input.event !== 'cancel') throw new ClinicalError(400, 'invalid_input');
  const rows = listOutbox(db, chart.row.encounter_id);
  const last = rows.at(-1);
  const previous = last ? verifiedPayload(last) : undefined;
  if (previous?.event === 'cancel') {
    if (input.event === 'cancel') return false;
    throw new ClinicalError(409, 'recept_encounter_cancelled');
  }

  const revision = chart.patient.revisions[0];
  if (!revision || (input.event === 'upsert' && !chart.patient.isSigned)) {
    throw new ClinicalError(409, 'recept_finalized_chart_required');
  }
  if (input.expectedChartRevision !== revision.revisionNumber) throw new ClinicalError(409, 'stale_draft');
  if (input.event === 'cancel' && !previous) throw new ClinicalError(409, 'recept_no_prior_transfer');
  const executions = performanceRows(db, chart);
  if (input.expectedPerformanceVersion !== hash(Buffer.from(JSON.stringify(executions)))) {
    throw new ClinicalError(409, 'recept_performances_changed');
  }
  const event = input.event === 'cancel' ? 'cancel' : previous ? 'correction' : 'initial';
  const existingIds = new Set<string>(previous?.performances.map(({ id }) => id) ?? []);
  const sourceDiagnoses = event === 'cancel' ? [] : revision.diseases;
  if (!sourceDiagnoses) throw new ClinicalError(409, 'recept_diagnosis_master_required');

  const diagnosisMaster = db.prepare(`
    SELECT i.code, r.effective_from AS publishedOn, r.file_sha256 AS sha256
    FROM master_items i JOIN master_releases r ON r.id = i.release_id
    WHERE i.id = ? AND i.kind = 'diagnosis' AND r.source = 'MHLW-RECEIPT'
  `);
  const diagnoses = sourceDiagnoses.map((item) => {
    const master = item.master && diagnosisMaster.get(item.master.itemId);
    if (!master || master.code !== item.master?.code || master.publishedOn !== item.master.releaseDate) {
      throw new ClinicalError(409, 'recept_diagnosis_master_required');
    }
    return {
      id: item.id, codeSystem: 'recept-diagnosis', code: master.code, startDate: item.startDate,
      isSuspected: item.outcome === 'suspected', isMain: item.isMain,
      outcome: item.outcome === 'suspected' ? 'unknown' : item.outcome,
      master: { publishedOn: master.publishedOn, sha256: master.sha256 },
    };
  });
  const performances = event === 'cancel' ? [] : executions
    .filter((item) => !item.cancelledAt || existingIds.has(item.id))
    .map((item) => {
      if (!item.performedOn || !item.unit) throw new ClinicalError(409, 'recept_performance_incomplete');
      return {
        id: item.id, codeSystem: 'recept-medical-procedure', code: item.code, performedOn: item.performedOn,
        quantity: item.quantity, unit: item.unit, status: item.cancelledAt ? 'cancelled' : 'performed',
        master: { publishedOn: item.publishedOn, sha256: item.sha256 },
      };
    });
  if (event === 'initial' && performances.length === 0) {
    throw new ClinicalError(409, 'recept_performance_required');
  }
  if (event === 'correction' && previous.chartRevision === revision.revisionNumber &&
      JSON.stringify(previous.diagnoses) === JSON.stringify(diagnoses) &&
      JSON.stringify(previous.performances) === JSON.stringify(performances)) return false;

  const transferRevision = (previous?.transferRevision ?? 0) + 1;
  const message = {
    schemaVersion: 1, integrationId: randomUUID(), ...identity(db), patientId: chart.patient.id,
    encounterId: String(chart.row.encounter_id), chartRevision: revision.revisionNumber,
    transferRevision, previousTransferRevision: previous?.transferRevision ?? null,
    event, reason: event === 'initial' ? null : requiredText(input.reason, 512), visitDate: chart.row.reception_date,
    diagnoses, performances,
  };
  const bytes = Buffer.from(JSON.stringify(message), 'utf8');
  if (!readTransfer(bytes).message) throw new ClinicalError(409, 'recept_payload_invalid');
  db.prepare(`
    INSERT INTO recept_outbox(integration_id, encounter_id, chart_revision, transfer_revision, event,
      payload, body_sha256, queued_by, queued_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(message.integrationId, chart.row.encounter_id, revision.revisionNumber, transferRevision, event,
    bytes, hash(bytes), actor.staffId, new Date().toISOString());
  return true;
}

export function beginReceptSend(db: DatabaseSync, chart: Chart, body: unknown) {
  const target = transportConfig();
  if (!target) throw new ClinicalError(503, 'recept_transport_not_configured');
  const id = requiredText(object(body).id, 64);
  const rows = listOutbox(db, chart.row.encounter_id);
  const row = rows.find((entry) => entry.integration_id === id);
  if (!row) throw new ClinicalError(404, 'not_found');
  if (row.receipt_json) return undefined;
  if (rows.some((entry) => entry.transfer_revision < row.transfer_revision && !entry.receipt_json)) {
    throw new ClinicalError(409, 'recept_previous_unsent');
  }
  if (row.lease_until !== null && row.lease_until > Date.now()) throw new ClinicalError(409, 'recept_send_in_progress');
  verifiedPayload(row);
  const attempt = row.attempts + 1;
  db.prepare('UPDATE recept_outbox SET attempts = ?, lease_until = ?, last_error = NULL WHERE integration_id = ?')
    .run(attempt, Date.now() + 20_000, id);
  return { target, id, attempt, digest: row.body_sha256, payload: Buffer.from(row.payload) };
}

type Attempt = NonNullable<ReturnType<typeof beginReceptSend>>;

export async function sendRecept(attempt: Attempt): Promise<{ receipt?: ReceptReceipt; error?: string }> {
  try {
    const response = await fetch(attempt.target.endpoint, {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(8_000),
      headers: { 'Content-Type': 'application/json; charset=utf-8', Authorization: 'Bearer ' + attempt.target.token },
      body: new Uint8Array(attempt.payload),
    });
    const reader = response.body?.getReader();
    if (!reader) return { error: 'invalid_response' };
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        size += chunk.value.byteLength;
        if (size > MAX_BODY_BYTES) return { error: 'invalid_response' };
        chunks.push(chunk.value);
      }
    } finally {
      await reader.cancel();
    }
    if (response.status !== 200 && response.status !== 202) return { error: `http_${response.status}` };
    try {
      const payload: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(Buffer.concat(chunks, size)));
      if (!validReceipt(payload, attempt.id, attempt.digest) ||
          (response.status === 202 && payload.status !== 'received' && payload.status !== 'confirmation_required')) {
        return { error: 'invalid_response' };
      }
      return { receipt: payload };
    } catch {
      return { error: 'invalid_response' };
    }
  } catch {
    return { error: 'connection_failed' };
  }
}

export function completeReceptSend(db: DatabaseSync, attempt: Attempt, result: Awaited<ReturnType<typeof sendRecept>>) {
  return db.prepare(`
    UPDATE recept_outbox SET lease_until = NULL, receipt_json = ?, last_error = ?
    WHERE integration_id = ? AND attempts = ?
  `).run(result.receipt ? JSON.stringify(result.receipt) : null, result.error ?? null, attempt.id, attempt.attempt).changes > 0;
}
