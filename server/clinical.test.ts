import assert from 'node:assert/strict';
import { scryptSync } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import type { FinalizedRecordDocument, FinalizedRecordPage } from '../src/types/records';
import type { PatientRecord } from '../src/types/emr';
import { createAuthMiddleware } from './auth';
import { copyRecordDatabase, verifyRecordDatabase } from './recordTransfer';

test('clinical API preserves authorized drafts and immutable corrections in SQLite', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'dencal-clinical-'));
  const path = join(directory, 'test.sqlite3');
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0');
  t.after(() => {
    db.close();
    rmSync(directory, { recursive: true, force: true });
  });
  // Start from the previous database version and keep its staff IDs and credentials.
  db.exec(readFileSync('database/schema.sql', 'utf8'));
  const password = 'local-test-password';
  const salt = Buffer.alloc(16);
  const digest = scryptSync(password, salt, 32, { N: 32768, r: 8, p: 3, maxmem: 64 * 1024 * 1024 });
  for (const [code, role] of [
    ['demo-reception', 'reception'], ['demo-nurse', 'nurse'], ['demo-physician', 'physician'],
    ['demo-admin', 'admin'], ['other-doctor', 'physician'],
  ]) {
    const { lastInsertRowid } = db.prepare('INSERT INTO staff(staff_code, display_name, role) VALUES (?, ?, ?)').run(code, code, role);
    db.prepare('INSERT INTO staff_credentials(staff_id, salt, password_hash) VALUES (?, ?, ?)').run(lastInsertRowid, salt, digest);
  }

  function startMiddleware(databasePath = path) {
    const previous = process.env.DENCAL_DB;
    process.env.DENCAL_DB = databasePath;
    try {
      return createAuthMiddleware();
    } finally {
      if (previous === undefined) delete process.env.DENCAL_DB;
      else process.env.DENCAL_DB = previous;
    }
  }
  let middleware = startMiddleware();
  const server = createServer((req, res) => {
    void middleware(req, res, () => { res.writeHead(404).end(); });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const origin = `http://127.0.0.1:${address.port}`;

  async function request(route: string, cookie = '', body?: unknown, from = origin) {
    return fetch(origin + '/api/' + route, {
      headers: { Cookie: cookie, Origin: from, 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }),
    });
  }

  async function login(staffId: string) {
    const response = await request('login', '', { staffId, password });
    assert.equal(response.status, 200);
    return response.headers.get('set-cookie')!.split(';')[0];
  }

  const list = 'clinical/patients';
  const general = list + '/PT-001042';
  const specialty = list + '/PT-000918';
  const referral = { hospital: 'テスト病院', purpose: '試作検証' };
  const ids = async (cookie: string) => {
    const response = await request(list, cookie);
    assert.equal(response.status, 200);
    return (await response.json()).patients.map((patient: { id: string }) => patient.id);
  };
  const search = async (cookie: string, params: Record<string, string> = {}): Promise<FinalizedRecordPage> => {
    const response = await request('clinical/records?' + new URLSearchParams(params), cookie);
    assert.equal(response.status, 200);
    return response.json() as Promise<FinalizedRecordPage>;
  };
  const chart = async (route: string, cookie: string): Promise<PatientRecord> => {
    const response = await request(route, cookie);
    assert.equal(response.status, 200);
    return (await response.json()).patient;
  };

  assert.equal((await request(list)).status, 401);
  assert.equal((await request('clinical/records')).status, 401);
  const clerk = await login('demo-reception');
  const nurse = await login('demo-nurse');
  const doctor = await login('demo-physician');
  const admin = await login('demo-admin');
  const unassigned = await login('other-doctor');
  assert.equal(db.prepare('PRAGMA user_version').get()?.user_version, 5);
  assert.deepEqual(await ids(clerk), ['PT-001042', 'PT-001105', 'PT-001089']);
  assert.deepEqual(await ids(unassigned), []);
  assert.equal((await request(general, unassigned)).status, 404);
  assert.equal((await request(specialty, doctor)).status, 404);
  assert.equal((await request(list + '/PT-does-not-exist', doctor)).status, 404);
  assert.equal((await request(specialty + '/soap', doctor, { subjective: '別部署からの書込' })).status, 404);
  assert.equal((await request(specialty + '/referral', doctor, referral)).status, 404);
  assert.equal((await request(specialty, admin)).status, 200);
  assert.equal((await request(general + '/soap', doctor, { subjective: '別サイトからの書込' }, 'http://example.invalid')).status, 403);

  const newPatient = {
    kanjiName: 'テスト患者', kanaName: 'テストカンジャ', sex: '女性', birthDate: '1980-01-01',
    bloodType: '', phone: '', address: '', insuranceType: '国保・一般', copayRatio: 0.3,
    chiefComplaint: '試験データ', mynaVerified: false,
    departmentCode: 'demo-specialty', id: 'PT-000918', isSigned: true, allergies: [{ substance: '権限のない入力' }],
    currentSoap: { subjective: '権限のない入力' },
  };
  assert.equal((await request(list, unassigned, newPatient)).status, 403);
  const created = await request(list, clerk, newPatient);
  assert.equal(created.status, 200);
  const { patient } = await created.json();
  const target = list + '/' + patient.id;
  assert.notEqual(patient.id, newPatient.id);
  assert.equal(patient.currentSoap.subjective, '');
  assert.deepEqual(patient.allergies, []);
  assert.equal(patient.isSigned, false);
  assert.deepEqual((await search(doctor, { q: patient.id })).records, []);
  assert.deepEqual((await search(doctor, { q: 'PT-000918' })).records, []);
  const [specialtyRecord] = (await search(admin, { q: 'PT-000918' })).records;
  assert.ok(specialtyRecord);
  const outsideRecord = `clinical/records/${specialtyRecord.encounterId}/${specialtyRecord.revision}`;
  assert.equal((await request(outsideRecord, doctor)).status, 404);
  assert.equal((await request(outsideRecord + '/export', doctor, {})).status, 404);
  assert.equal((await request('clinical/records?from=2026-02-30', doctor)).status, 400);

  const vitals = { systolicBp: 120, diastolicBp: 80, pulse: 60, temperature: 36.5, spo2: 98, weightKg: 60, bmi: 21 };
  const allergy = { substance: '試験', category: 'other', severity: 'moderate', reaction: '試験' };
  assert.equal((await request(target + '/vitals', clerk, vitals)).status, 403);
  assert.equal((await request(target + '/allergy', clerk, allergy)).status, 403);
  assert.equal((await request(target + '/vitals', nurse, vitals)).status, 200);
  assert.equal((await request(target + '/allergy', nurse, allergy)).status, 200);
  let version = patient.draftVersion;
  const edit = (operation: string, cookie: string, data: unknown = {}, expectedVersion = version) =>
    request(target + '/' + operation, cookie, { expectedVersion, data });
  const successfulEdit = async (operation: string, cookie: string, data?: unknown): Promise<PatientRecord> => {
    const response = await edit(operation, cookie, data);
    assert.equal(response.status, 200, `operation ${operation}`);
    const { patient } = await response.json();
    assert.equal(patient.draftVersion, version + 1);
    version = patient.draftVersion;
    return patient;
  };

  assert.equal((await edit('soap', nurse, { subjective: '権限のない入力' })).status, 403);
  assert.equal((await edit('soap', doctor, { subjective: '医師の記録', isSigned: true })).status, 400);
  const beforeSave = version;
  await successfulEdit('soap', doctor, { subjective: '医師の記録' });
  assert.equal((await edit('soap', doctor, { subjective: '古い入力' }, beforeSave)).status, 409);

  middleware = startMiddleware();
  const draft = await chart(target, doctor);
  assert.equal(draft.currentSoap.subjective, '医師の記録');
  assert.equal(draft.draftVersion, version);
  assert.equal(draft.draftSavedBy, 'demo-physician');

  const prescription = {
    id: 'rx-test', drugName: '試験用', dosagePerDay: '1錠', usage: '朝食後', days: 1,
    category: 'internal', genericAllowed: false,
  };
  const lab = { id: 'lab-test', code: 'test', name: '試験用' };
  assert.equal((await edit('prescription', nurse, prescription)).status, 403);
  assert.equal((await edit('lab_order', nurse, lab)).status, 403);
  await successfulEdit('prescription', doctor, prescription);
  await successfulEdit('lab_order', doctor, lab);
  assert.equal((await edit('remove_prescription', nurse, { id: prescription.id })).status, 403);
  assert.equal((await edit('finalize', nurse)).status, 403);
  const first = await successfulEdit('finalize', admin, { authorId: 'fake-author' });
  assert.equal(first.revisions[0].authorId, 'demo-admin');
  assert.equal(first.revisions[0].enteredByName, 'demo-physician');
  assert.match(first.revisions[0].sha256Hash, /^[a-f0-9]{64}$/);
  assert.equal(first.revisions[0].soap.subjective, '医師の記録');
  assert.equal(first.revisions[0].prescriptions[0].id, prescription.id);
  assert.equal(first.revisions[0].labOrders[0].id, lab.id);
  assert.equal(first.vitalsHistory[0].pulse, 60);
  assert.equal((await edit('finalize', doctor)).status, 409);
  assert.equal((await edit('soap', doctor, { subjective: '直接書き換え' })).status, 409);
  assert.equal((await edit('remove_prescription', doctor, { id: prescription.id })).status, 409);
  assert.equal((await edit('start_correction', doctor, { reason: '  ' })).status, 400);
  assert.equal((await edit('start_correction', nurse, { reason: '訂正理由' })).status, 403);
  const correction = await successfulEdit('start_correction', doctor, { reason: '記載誤りの訂正' });
  assert.equal(correction.isSigned, false);
  assert.equal(correction.correctionReason, '記載誤りの訂正');
  assert.deepEqual(correction.revisions[0], first.revisions[0]);
  const correctedText = '医師の記録を訂正\n<追記> & 注記';
  const overlappingWrites = await Promise.all([
    edit('soap', doctor, { subjective: correctedText }),
    edit('soap', admin, { subjective: correctedText }),
  ]);
  assert.deepEqual(overlappingWrites.map((response) => response.status).sort(), [200, 409]);
  version += 1;
  await successfulEdit('remove_prescription', doctor, { id: prescription.id });
  middleware = startMiddleware();
  assert.equal((await chart(target, doctor)).correctionReason, '記載誤りの訂正');
  const newRevision = await successfulEdit('finalize', doctor);
  assert.deepEqual(newRevision.revisions.map((entry) => entry.revisionNumber), [2, 1]);
  assert.equal(newRevision.revisions[0].previousHash, first.revisions[0].sha256Hash);
  assert.equal(newRevision.revisions[0].reasonForRevision, '記載誤りの訂正');
  assert.deepEqual(newRevision.revisions[0].prescriptions, []);
  assert.equal(newRevision.revisions[0].soap.subjective, correctedText);
  assert.deepEqual(newRevision.revisions[1], first.revisions[0]);
  middleware = startMiddleware();
  assert.deepEqual((await chart(target, nurse)).revisions, newRevision.revisions);

  const encounterId = db.prepare(`
    SELECT e.id FROM encounters e JOIN patients p ON p.id = e.patient_id WHERE p.patient_number = ?
  `).get(patient.id)!.id;
  assert.throws(() => db.prepare('UPDATE clinical_note_revisions SET subjective = ? WHERE encounter_id = ?').run('直接変更', encounterId), /immutable/);
  assert.throws(() => db.prepare('DELETE FROM clinical_note_revisions WHERE encounter_id = ?').run(encounterId), /immutable/);
  assert.throws(() => db.prepare(`
    INSERT OR REPLACE INTO clinical_note_revisions
    SELECT * FROM clinical_note_revisions WHERE encounter_id = ? AND revision = 1
  `).run(encounterId), /already exists/);
  const actions = db.prepare('SELECT action FROM audit_events WHERE encounter_id = ? ORDER BY id')
    .all(encounterId).map((event) => event.action);
  assert.ok(actions.includes('SOAP_SAVE') && actions.includes('SOAP_CORRECTION_START') && actions.includes('SOAP_REVISION'));
  assert.equal((await request(target + '/settle', clerk, {})).status, 200);
  assert.equal((await request(target + '/settle', clerk, {})).status, 409);

  assert.equal((await request(target + '/referral', clerk, referral)).status, 403);
  const exported = await request(target + '/referral', doctor, referral);
  assert.equal(exported.status, 200);
  assert.match((await exported.json()).content, /医師の記録/);
  assert.equal((await request('clinical/archive', doctor)).status, 403);
  assert.equal((await request('clinical/admin-demo', doctor)).status, 403);
  assert.equal((await request('clinical/archive', admin)).status, 200);

  const { records: matches, hasNext } = await search(doctor, { q: 'テスト　カンジャ' });
  assert.equal(hasNext, false);
  assert.deepEqual(matches.map((entry) => entry.revision), [2, 1]);
  assert.equal(matches[0].encounterId, encounterId);
  assert.deepEqual((await search(clerk, { q: newPatient.kanjiName, from: matches[0].visitDate, to: matches[0].visitDate })).records, matches);
  assert.deepEqual((await search(clerk, { q: newPatient.kanjiName, to: '2000-01-01' })).records, []);
  assert.deepEqual((await search(clerk, { q: newPatient.kanjiName, page: '2' })).records, []);
  const record = `clinical/records/${encounterId}`;
  const document = async (revision: number, cookie: string, output = false): Promise<FinalizedRecordDocument> => {
    const response = await request(`${record}/${revision}${output ? '/export' : ''}`, cookie, output ? {} : undefined);
    assert.equal(response.status, 200);
    assert.match(response.headers.get('cache-control') ?? '', /no-store/);
    return response.json() as Promise<FinalizedRecordDocument>;
  };
  const originalDocument = await document(1, clerk);
  assert.match(originalDocument.html, /診療録 第1版/);
  assert.match(originalDocument.html, /1錠/);
  assert.doesNotMatch(originalDocument.html, /医師の記録を訂正/);
  assert.equal((await request(record + '/3', clerk)).status, 404);
  assert.equal((await request(record + '/1/export', clerk, {})).status, 403);
  assert.equal((await request(record + '/1/export', doctor, {}, 'http://example.invalid')).status, 403);
  const correctedDocument = await document(2, doctor, true);
  assert.equal(correctedDocument.filename, `dencal-record-${encounterId}-v2.html`);
  assert.match(correctedDocument.html, /<meta charset="utf-8">/);
  assert.match(correctedDocument.html, /@page \{ size: A4/);
  assert.match(correctedDocument.html, /訂正理由/);
  assert.match(correctedDocument.html, /&lt;追記&gt; &amp; 注記/);
  assert.doesNotMatch(correctedDocument.html, /<追記>/);
  assert.ok(correctedDocument.html.includes(first.revisions[0].sha256Hash));
  assert.equal(db.prepare("SELECT count(*) AS total FROM audit_events WHERE clinical_summary = '診療録 第2版を出力'").get()?.total, 1);

  const saved = join(directory, 'saved.sqlite3');
  const restored = join(directory, 'restored.sqlite3');
  assert.ok(existsSync(path + '-wal'));
  assert.equal(copyRecordDatabase(path, saved), 5);
  assert.equal(verifyRecordDatabase(saved), 5);
  assert.equal(copyRecordDatabase(saved, restored), 5);
  assert.throws(() => copyRecordDatabase(saved, path), /既存/);
  assert.throws(() => copyRecordDatabase(saved, restored), /既存/);
  if (process.platform !== 'win32') assert.equal(statSync(restored).mode & 0o777, 0o600);
  assert.ok(Number(db.prepare('SELECT count(*) AS total FROM staff_sessions').get()?.total) > 0);

  middleware = startMiddleware(restored);
  assert.equal((await request('session', doctor)).status, 401);
  const restoredDoctor = await login('demo-physician');
  assert.deepEqual(await search(restoredDoctor, { q: patient.id }), { records: matches, hasNext: false });
  assert.deepEqual(await document(1, restoredDoctor), originalDocument);
  assert.deepEqual(await document(2, restoredDoctor), correctedDocument);
  middleware = startMiddleware();

  db.exec("UPDATE staff SET department_id = (SELECT id FROM departments WHERE code = 'demo-specialty') WHERE staff_code = 'demo-physician'");
  assert.deepEqual(await ids(doctor), ['PT-000918']);
  assert.equal((await request(target, doctor)).status, 404);
  assert.equal((await request(target + '/soap', doctor, { subjective: '異動前の患者' })).status, 404);
  assert.equal((await request('logout', doctor, {})).status, 200);
  assert.equal((await request(list, doctor)).status, 401);
  const trigger = db.prepare("SELECT sql FROM sqlite_schema WHERE name = 'clinical_revision_no_update'").get()?.sql;
  assert.equal(typeof trigger, 'string');
  db.exec('DROP TRIGGER clinical_revision_no_update');
  db.prepare('UPDATE clinical_note_revisions SET subjective = ? WHERE encounter_id = ? AND revision = 1')
    .run('変更検知テスト', encounterId);
  db.exec(String(trigger));
  const corrupt = await request(target, admin);
  assert.equal(corrupt.status, 409);
  assert.equal((await corrupt.json()).error, 'record_integrity_error');
  assert.equal((await request(record + '/2', admin)).status, 409);
  const rejected = join(directory, 'corrupt-output.sqlite3');
  assert.throws(() => verifyRecordDatabase(path), /ハッシュ/);
  assert.throws(() => copyRecordDatabase(path, rejected), /ハッシュ/);
  assert.equal(existsSync(rejected), false);
});
