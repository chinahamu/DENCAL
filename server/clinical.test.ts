import assert from 'node:assert/strict';
import { scryptSync } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { createAuthMiddleware } from './auth';

test('clinical API checks role and patient scope on the server', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'dencal-clinical-'));
  const path = join(directory, 'test.sqlite3');
  const db = new DatabaseSync(path);
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

  const previous = process.env.DENCAL_DB;
  process.env.DENCAL_DB = path;
  const middleware = createAuthMiddleware();
  if (previous === undefined) delete process.env.DENCAL_DB;
  else process.env.DENCAL_DB = previous;
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
  const chart = async (route: string, cookie: string) => {
    const response = await request(route, cookie);
    assert.equal(response.status, 200);
    return (await response.json()).patient;
  };

  assert.equal((await request(list)).status, 401);
  const clerk = await login('demo-reception');
  const nurse = await login('demo-nurse');
  const doctor = await login('demo-physician');
  const admin = await login('demo-admin');
  const unassigned = await login('other-doctor');
  assert.equal(db.prepare('PRAGMA user_version').get()?.user_version, 3);
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

  const vitals = { systolicBp: 120, diastolicBp: 80, pulse: 60, temperature: 36.5, spo2: 98, weightKg: 60, bmi: 21 };
  const allergy = { substance: '試験', category: 'other', severity: 'moderate', reaction: '試験' };
  assert.equal((await request(target + '/vitals', clerk, vitals)).status, 403);
  assert.equal((await request(target + '/allergy', clerk, allergy)).status, 403);
  assert.equal((await request(target + '/vitals', nurse, vitals)).status, 200);
  assert.equal((await request(target + '/allergy', nurse, allergy)).status, 200);
  assert.equal((await request(target + '/soap', nurse, { subjective: '権限のない入力' })).status, 403);
  assert.equal((await request(target + '/soap', doctor, { subjective: '医師の記録', isSigned: true })).status, 400);
  assert.equal((await request(target + '/soap', doctor, { subjective: '医師の記録' })).status, 200);
  const prescription = {
    id: 'rx-test', drugName: '試験用', dosagePerDay: '1錠', usage: '朝食後', days: 1,
    category: 'internal', genericAllowed: false,
  };
  const lab = { id: 'lab-test', code: 'test', name: '試験用' };
  assert.equal((await request(target + '/prescription', nurse, prescription)).status, 403);
  assert.equal((await request(target + '/lab_order', nurse, lab)).status, 403);
  assert.equal((await request(target + '/prescription', doctor, prescription)).status, 200);
  assert.equal((await request(target + '/lab_order', doctor, lab)).status, 200);
  assert.equal((await request(target + '/remove_prescription', nurse, { id: prescription.id })).status, 403);
  assert.equal((await request(target + '/finalize', nurse, { reason: '試験' })).status, 403);
  assert.equal((await request(target + '/finalize', doctor, { reason: '試験', authorId: 'demo-admin' })).status, 200);
  assert.equal((await request(target + '/finalize', doctor, { reason: '重複' })).status, 409);
  const updated = await chart(target, nurse);
  assert.equal(updated.revisions[0].authorId, 'demo-physician');
  assert.equal(updated.revisions[0].soap.subjective, '医師の記録');
  assert.equal(updated.revisions[0].prescriptions[0].id, prescription.id);
  assert.equal(updated.revisions[0].labOrders[0].id, lab.id);
  assert.equal(updated.vitalsHistory[0].pulse, 60);
  assert.equal((await request(target + '/settle', clerk, {})).status, 200);
  assert.equal((await request(target + '/settle', clerk, {})).status, 409);

  assert.equal((await request(target + '/referral', clerk, referral)).status, 403);
  const exported = await request(target + '/referral', doctor, referral);
  assert.equal(exported.status, 200);
  assert.match((await exported.json()).content, /医師の記録/);
  assert.equal((await request('clinical/archive', doctor)).status, 403);
  assert.equal((await request('clinical/admin-demo', doctor)).status, 403);
  assert.equal((await request('clinical/archive', admin)).status, 200);

  db.exec("UPDATE staff SET department_id = (SELECT id FROM departments WHERE code = 'demo-specialty') WHERE staff_code = 'demo-physician'");
  assert.deepEqual(await ids(doctor), ['PT-000918']);
  assert.equal((await request(target, doctor)).status, 404);
  assert.equal((await request(target + '/soap', doctor, { subjective: '異動前の患者' })).status, 404);
  assert.equal((await request('logout', doctor, {})).status, 200);
  assert.equal((await request(list, doctor)).status, 401);
});
