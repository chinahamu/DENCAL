import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { evaluateTransfer } from '../integration/recept-v1/contract.mjs';
import type { ReceptWorkspace } from '../src/types/recept';
import { createAuthMiddleware } from './auth';
import { copyRecordDatabase } from './recordTransfer';

async function listen(server: Server) {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  return `http://127.0.0.1:${address.port}`;
}

function fixtureRow(length: number, values: Record<number, string>) {
  const fields = Array<string>(length).fill('');
  for (const [index, value] of Object.entries(values)) fields[Number(index)] = value;
  return fields.join(',');
}

test('DENCAL records performed care and retries the same RECEPT bytes after restart', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'dencal-recept-test-'));
  const filename = join(directory, 'dencal.sqlite3');
  const initial = execFileSync('python3', ['database/init.py', filename], { encoding: 'utf8' });
  const passwords = Object.fromEntries(initial.split('\n').filter((line) => line.startsWith('demo-')).map((line) => line.split(' ')));
  const savedEnv = { ...process.env };
  t.after(() => {
    for (const name of ['DENCAL_DB', 'DENCAL_RECEPT_URL', 'DENCAL_RECEPT_TOKEN', 'DENCAL_SIGNING_CONFIG']) {
      if (savedEnv[name] === undefined) delete process.env[name];
      else process.env[name] = savedEnv[name];
    }
    rmSync(directory, { recursive: true, force: true });
  });
  process.env.DENCAL_DB = filename;
  delete process.env.DENCAL_SIGNING_CONFIG;
  delete process.env.DENCAL_RECEPT_URL;
  delete process.env.DENCAL_RECEPT_TOKEN;

  let middleware = createAuthMiddleware();
  const app = createServer((req, res) => { void middleware(req, res, () => res.writeHead(404).end()); });
  const base = await listen(app);
  t.after(() => new Promise<void>((resolve) => app.close(() => resolve())));
  function request(path: string, cookie: string, body?: unknown, type = 'application/json') {
    return fetch(base + '/api/' + path, {
      headers: { Origin: base, Cookie: cookie, 'Content-Type': type },
      ...(body === undefined ? {} : { method: 'POST', body: type === 'application/json' ? JSON.stringify(body) : String(body) }),
    });
  }
  async function login(staffId: string) {
    const response = await request('login', '', { staffId, password: passwords[staffId] });
    assert.equal(response.status, 200);
    return response.headers.get('set-cookie')!.split(';')[0];
  }
  const admin = await login('demo-admin');
  const doctor = await login('demo-physician');
  const nurse = await login('demo-nurse');
  const clerk = await login('demo-reception');
  const procedure = fixtureRow(150, {
    0: '0', 1: 'S', 2: '199000001', 4: '架空の検査', 9: '回', 10: '3', 11: '100', 12: '0',
    14: '600', 15: '0', 29: '0', 86: '20000101',
  });
  const inpatient = fixtureRow(150, {
    0: '0', 1: 'S', 2: '199000002', 4: '架空の入院専用行為', 9: '回', 10: '3', 11: '100', 12: '1',
    14: '600', 15: '0', 29: '0', 86: '20000101',
  });
  const diagnosis = fixtureRow(46, {
    0: '0', 1: 'B', 2: '9990001', 5: '架空の傷病', 18: '00', 19: '0', 21: '20000101',
  });
  async function upload(name: string, contents: string) {
    const result = await request('catalog?filename=' + name, admin, contents, 'application/octet-stream');
    assert.equal(result.status, 200, await result.clone().text());
    return result.json();
  }
  await upload('s_20000101.csv', procedure + '\n' + inpatient);
  await upload('b_20000101.txt', diagnosis);
  const registration = await request('clinical/patients', clerk, {
    kanjiName: '送信に含めない架空氏名', kanaName: 'テストカナ', sex: '男性', birthDate: '1980-01-01',
    bloodType: '', phone: '', address: '', insuranceType: '国保・一般', copayRatio: 0.3, mynaVerified: false,
    chiefComplaint: '送信に含めない架空主訴',
  });
  assert.equal(registration.status, 200);
  let { patient } = await registration.json();
  const path = 'clinical/patients/' + patient.id + '/';
  const workspace = async (operation = 'recept', cookie = doctor, body?: unknown): Promise<ReceptWorkspace> => {
    const response = await request(path + operation, cookie, body);
    assert.equal(response.status, 200, await response.clone().text());
    return response.json() as Promise<ReceptWorkspace>;
  };
  let state = await workspace();
  const visitDate = state.visitDate;
  assert.equal(state.transportConfigured, false);
  const procedureSearch = 'catalog/search?kind=procedure&use=performance&on=' + visitDate;

  // A reimport enriches an existing v5 master release without duplicating master items.
  const db = new DatabaseSync(filename);
  try {
    db.exec("UPDATE master_item_catalog_details SET performance_selectable = NULL WHERE item_id IN (SELECT id FROM master_items WHERE kind = 'procedure')");
  } finally {
    db.close();
  }
  assert.deepEqual((await (await request(procedureSearch, nurse)).json()).entries, []);
  assert.equal((await upload('s_20000101.csv', procedure + '\n' + inpatient)).duplicate, true);
  assert.equal((await request(procedureSearch, clerk)).status, 403);
  const { entries: procedures } = await (await request(procedureSearch, nurse)).json();
  assert.deepEqual(procedures.map(({ code }) => code), ['199000001']);
  const { entries: diagnoses } = await (await request('catalog/search?kind=diagnosis', doctor)).json();

  const record = {
    id: randomUUID(), masterItemId: procedures[0].id, performedOn: visitDate, quantity: 2, unit: '回',
  };
  const queue = (current: ReceptWorkspace, event = 'upsert', reason = '試験理由') => ({
    event, reason, expectedChartRevision: current.chartRevision, expectedPerformanceVersion: current.performanceVersion,
  });
  assert.equal((await request(path + 'recept_queue', doctor, queue(state))).status, 409);
  assert.equal((await request(path + 'performance_add', clerk, record)).status, 403);
  assert.equal((await request('clinical/patients/PT-000918/performance_add', nurse, record)).status, 404);
  assert.equal((await request(path + 'performance_add', nurse, { ...record, unit: '錠' })).status, 400);
  for (const [operation, data] of [
    ['diagnosis', { id: 'test-diagnosis', master: { itemId: diagnoses[0].id, code: diagnoses[0].code, releaseDate: diagnoses[0].releaseDate },
      name: diagnoses[0].name, icd10Code: '', isMain: true, isChronicDiseaseTarget: false, startDate: visitDate, outcome: 'ongoing' }],
    ['lab_order', { id: 'unperformed-order', code: procedures[0].code, name: procedures[0].name }],
    ['finalize', {}],
  ] as const) {
    const response = await request(path + operation, doctor, { expectedVersion: patient.draftVersion, data });
    assert.equal(response.status, 200);
    ({ patient } = await response.json());
  }
  state = await workspace();
  assert.equal(state.finalized, true);
  assert.equal((await request(path + 'recept_queue', doctor, queue(state))).status, 409);
  const stale = state;
  state = await workspace('performance_add', nurse, record);
  assert.equal(state.performances.length, 1);
  assert.equal((await workspace('performance_add', nurse, record)).performances.length, 1);
  assert.equal((await request(path + 'performance_add', nurse, { ...record, quantity: 5 })).status, 409);
  assert.equal((await request(path + 'recept_queue', doctor, queue(stale))).status, 409);
  assert.equal((await request(path + 'recept_queue', nurse, queue(state))).status, 403);
  state = await workspace('recept_queue', doctor, queue(state));
  assert.equal(state.outbox.length, 1);
  assert.equal(state.outbox[0].performedItems[0].quantity, 2);
  assert.equal((await workspace('recept_queue', doctor, queue(state))).outbox.length, 1);
  const firstId = state.outbox[0].id;
  assert.equal((await request(path + 'recept_send', doctor, { id: firstId })).status, 503);

  state = await workspace('performance_cancel', nurse, { id: record.id, reason: '実施記録の取消テスト' });
  assert.ok(state.performances[0].cancelledAt);
  state = await workspace('recept_queue', doctor, queue(state, 'upsert', '実施明細を取消'));
  const correctionId = state.outbox[1].id;
  assert.equal(state.outbox[0].performedItems[0].status, 'performed');
  assert.equal(state.outbox[1].performedItems[0].status, 'cancelled');

  const receipts = [];
  const calls: Buffer[] = [];
  const receiver = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk);
    const payload = Buffer.concat(chunks);
    calls.push(payload);
    assert.equal(req.url, '/api/integration/v1/encounters');
    assert.equal(req.headers.authorization, 'Bearer local-test-key');
    const message = JSON.parse(payload.toString('utf8'));
    const reply = evaluateTransfer(payload, {
      source: { facilityId: state.facilityId, senderId: state.senderId },
      inbox: receipts, hasMaster: () => true,
    });
    if (reply.httpStatus === 202) receipts.push({ message, receipt: reply.body });
    // Simulate a receiver that commits the receipt but fails to acknowledge the first request.
    res.writeHead(calls.length === 1 ? 503 : reply.httpStatus, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(calls.length === 1 ? { error: 'temporarily_unavailable' } : reply.body));
  });
  process.env.DENCAL_RECEPT_URL = await listen(receiver);
  process.env.DENCAL_RECEPT_TOKEN = 'local-test-key';
  t.after(() => new Promise<void>((resolve) => receiver.close(() => resolve())));
  assert.equal((await request(path + 'recept_send', doctor, { id: correctionId })).status, 409);
  state = await workspace('recept_send', doctor, { id: firstId });
  assert.equal(state.outbox[0].lastError, 'http_503');
  assert.equal(state.outbox[0].receipt, null);
  const senderId = state.senderId;

  middleware = createAuthMiddleware();
  state = await workspace();
  assert.equal(state.senderId, senderId);
  assert.equal(state.outbox[0].attempts, 1);
  state = await workspace('recept_send', doctor, { id: firstId });
  assert.equal(state.outbox[0].attempts, 2);
  assert.equal(state.outbox[0].receipt?.status, 'received');
  assert.deepEqual(calls[0], calls[1]);
  const sent = JSON.parse(calls[0].toString('utf8'));
  assert.equal(sent.diagnoses[0].code, '9990001');
  assert.equal(sent.performances[0].id, record.id);
  assert.equal(sent.performances.length, 1);
  assert.doesNotMatch(calls[0].toString(), /送信に含めない|unperformed-order/);

  state = await workspace('recept_send', doctor, { id: correctionId });
  assert.equal(state.outbox[1].receipt?.status, 'received');
  state = await workspace('recept_queue', doctor, queue(state, 'cancel', '受診を取消'));
  assert.equal(state.outbox[2].event, 'cancel');
  state = await workspace('recept_send', doctor, { id: state.outbox[2].id });
  assert.equal(state.outbox[2].receipt?.status, 'received');
  assert.equal(receipts.length, 3);

  const restored = join(directory, 'restored.sqlite3');
  assert.equal(copyRecordDatabase(filename, restored), 5);
  process.env.DENCAL_DB = restored;
  middleware = createAuthMiddleware();
  const restoredDoctor = await login('demo-physician');
  assert.deepEqual((await workspace('recept', restoredDoctor)).outbox, state.outbox);
});
