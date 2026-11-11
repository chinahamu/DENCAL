import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import Ajv2020 from 'ajv/dist/2020.js';

export const MAX_BODY_BYTES = 128 * 1024;

const ajv = new Ajv2020();
ajv.addFormat('date', (value) => {
  if (!/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(value) || value.startsWith('0000')) return false;
  const parsed = new Date(value + 'T00:00:00Z');
  return Number.isFinite(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === value;
});

function compile(filename) {
  return ajv.compile(JSON.parse(readFileSync(new URL(filename, import.meta.url), 'utf8')));
}

export const validateResponse = compile('response.schema.json');
const validateTransfer = compile('transfer.schema.json');
const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

function error(httpStatus, code) {
  return { httpStatus, body: { error: code } };
}

function duplicateIds(items) {
  return new Set(items.map(({ id }) => id)).size !== items.length;
}

function matchesSource(message, source) {
  return message.facilityId === source.facilityId && message.senderId === source.senderId;
}

function invalidPerformanceTransition(previous, current) {
  const previousById = new Map(previous.map((item) => [item.id, item]));
  const currentById = new Map(current.map((item) => [item.id, item]));
  return previous.some(({ id }) => !currentById.has(id)) ||
    current.some((item) => {
      const before = previousById.get(item.id);
      if (!before) return item.status === 'cancelled';
      if (before.status === 'cancelled' && item.status !== 'cancelled') return true;
      if (item.status !== 'cancelled') return false;
      return ['code', 'performedOn', 'quantity', 'unit'].some((key) => before[key] !== item[key]);
    });
}

export function readTransfer(bytes) {
  if (bytes.byteLength > MAX_BODY_BYTES) return error(413, 'payload_too_large');
  let message;
  try {
    message = JSON.parse(decoder.decode(bytes));
  } catch {
    return error(400, 'invalid_json');
  }

  if (Number.isSafeInteger(message?.schemaVersion) && message.schemaVersion !== 1) {
    return error(400, 'unsupported_schema_version');
  }
  if (!validateTransfer(message) ||
      (message.event !== 'initial' && message.previousTransferRevision !== message.transferRevision - 1) ||
      duplicateIds(message.diagnoses) || duplicateIds(message.performances) ||
      (message.event === 'initial' && message.performances.some(({ status }) => status === 'cancelled'))) {
    return error(400, 'invalid_payload');
  }
  return { message };
}

/**
 * Pure reference decision. The receiver supplies authenticated scope, durable
 * inbox records, and a lookup backed by its own effective-dated masters.
 */
export function evaluateTransfer(bytes, { source, inbox = [], hasMaster }) {
  const parsed = readTransfer(bytes);
  if (!parsed.message) return parsed;
  const { message } = parsed;
  if (!matchesSource(message, source)) return error(403, 'source_scope_mismatch');

  const { integrationId, encounterId, transferRevision } = message;
  const bodySha256 = createHash('sha256').update(bytes).digest('hex');
  const scoped = inbox.filter((record) => matchesSource(record.message, source));
  const existing = scoped.find((record) => record.message.integrationId === integrationId);
  if (existing) {
    return existing.receipt.bodySha256 === bodySha256
      ? { httpStatus: 200, body: existing.receipt }
      : error(409, 'integration_id_conflict');
  }

  const encounter = scoped.filter((record) => record.message.encounterId === encounterId);
  if (encounter.some((record) => record.message.transferRevision === transferRevision)) {
    return error(409, 'transfer_revision_conflict');
  }
  const first = encounter.find((record) => record.message.transferRevision === 1);
  if (first && first.message.patientId !== message.patientId) return error(409, 'patient_binding_conflict');

  const issues = [];
  if (message.event !== 'initial') {
    const predecessor = encounter.find((record) => record.message.transferRevision === message.previousTransferRevision);
    if (!predecessor) {
      issues.push({ code: 'predecessor_missing', path: '/previousTransferRevision' });
    } else if (predecessor.receipt.issues.some(({ code }) =>
      code === 'predecessor_missing' || code === 'predecessor_pending')) {
      issues.push({ code: 'predecessor_pending', path: '/previousTransferRevision' });
    } else {
      const previous = predecessor.message;
      if (previous.patientId !== message.patientId) return error(409, 'patient_binding_conflict');
      if (previous.event === 'cancel') return error(409, 'encounter_cancelled');
      if (previous.chartRevision > message.chartRevision) return error(409, 'stale_chart_revision');
      if (message.event === 'correction' && invalidPerformanceTransition(previous.performances, message.performances)) {
        return error(409, 'performance_transition_conflict');
      }
    }
  }

  for (const [section, items] of [['diagnoses', message.diagnoses], ['performances', message.performances]]) {
    for (const [index, item] of items.entries()) {
      if (item.status !== 'cancelled' && !hasMaster(item.codeSystem, item.code, item.startDate ?? item.performedOn)) {
        issues.push({ code: 'unknown_master_code', path: `/${section}/${index}/code` });
      }
    }
  }

  return { httpStatus: 202, body: {
    integrationId, bodySha256, status: issues.length ? 'confirmation_required' : 'received', issues,
  } };
}
