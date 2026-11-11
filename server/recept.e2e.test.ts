import assert from 'node:assert/strict';
import { execFileSync, fork } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import type { ReceptWorkspace } from '../src/types/recept';
import { createAuthMiddleware } from './auth';
import { copyRecordDatabase } from './recordTransfer';

const name = '結合試験 同姓同名';
const token = 'integration-test-' + randomUUID();
const intake = '/api/integration/v1/encounters';
const inbox = '/api/integration/inbox';
const dencalRepo = process.cwd();
const receptRepo = resolve(process.env.RECEPT_REPO ?? '../RECEPT');

async function listen(server: Server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  return `http://127.0.0.1:${address.port}`;
}

function close(server: Server) {
  return new Promise<void>((resolve) => server.close(() => resolve()));
}

function staffRequest(origin: string, path: string, cookie = '', body?: unknown, binary = false) {
  return fetch(origin + path, {
    headers: { Origin: origin, Cookie: cookie, 'Content-Type': binary ? 'application/octet-stream' : 'application/json' },
    ...(body === undefined ? {} : { method: 'POST', body: binary ? String(body) : JSON.stringify(body) }),
    signal: AbortSignal.timeout(10_000),
  });
}

async function status(response: Promise<Response>, expected: number, operation: string) {
  const result = await response;
  assert.equal(result.status, expected, operation);
  return result;
}

async function json(response: Promise<Response>, expected = 200, operation = 'API応答') {
  return (await status(response, expected, operation)).json();
}

async function login(origin: string, credentials: object) {
  const response = await status(staffRequest(origin, '/api/login', '', credentials), 200, '職員ログイン');
  const cookie = response.headers.get('set-cookie')?.split(';')[0];
  assert.ok(cookie);
  return cookie;
}

function masterRow(columns: number, fields: Record<number, string>) {
  return Object.assign(Array<string>(columns).fill(''), fields).join(',');
}

const procedure = masterRow(150, {
  0: '0', 1: 'S', 2: '199000001', 4: '架空の検査', 9: '回', 10: '3', 11: '100', 12: '0',
  14: '600', 15: '0', 29: '0', 86: '20000101',
});
const diagnosis = masterRow(46, {
  0: '0', 1: 'B', 2: '9990001', 5: '架空の傷病', 18: '00', 19: '0', 21: '20000101',
});
const masters = [['s_20000101.csv', procedure], ['b_20000101.txt', diagnosis]] as const;

function run(repo: string, command: string, args: string[], env = process.env) {
  return execFileSync(command, args, { cwd: repo, env, encoding: 'utf8', timeout: 10_000 });
}

type Fixture = { origin: string; passwords?: Record<string, string> };

async function receiver(filename: string, facilityId: string, senderId: string, initialize = false, receiverToken = token) {
  const env = { ...process.env, RECEPT_DB: filename, RECEPT_ENABLE_DEMO_EXPORTS: '0',
    RECEPT_DENCAL_TOKEN: receiverToken, RECEPT_DENCAL_FACILITY_ID: facilityId, RECEPT_DENCAL_SENDER_ID: senderId };
  const child = fork(join(receptRepo, 'integration/e2e/serve.mjs'), [filename, initialize ? 'initialize' : 'restart'], {
    cwd: receptRepo, execArgv: ['--import', 'tsx'], env,
  });
  const exited = once(child, 'exit');
  const stop = async () => {
    if (child.connected) child.disconnect();
    await exited;
  };
  try {
    const fixture = await Promise.race([
      once(child, 'message').then(([message]) => message as Fixture),
      exited.then(([code]) => { throw new Error(`RECEPTのテストサーバーが終了しました (${code})`); }),
    ]);
    return { ...fixture, stop };
  } catch (error) {
    if (child.connected) child.disconnect();
    throw error;
  }
}

function machine(origin: string, path: string, bytes?: Buffer, authorization = 'Bearer ' + token) {
  return fetch(origin + path, {
    headers: { Authorization: authorization, 'Content-Type': 'application/json' },
    ...(bytes === undefined ? {} : { method: 'POST', body: new Uint8Array(bytes) }),
    signal: AbortSignal.timeout(10_000),
  });
}

test('DENCALからRECEPTへの送信・請求確定・訂正と片側復元', { timeout: 60_000 }, async (t) => {
  assert.ok(existsSync(join(receptRepo, 'integration/e2e/serve.mjs')),
    '結合テストを含むRECEPTを取得し、RECEPT_REPOにリポジトリのパスを指定してください。');
  const directory = mkdtempSync(join(tmpdir(), 'dencal-recept-e2e-'));
  const dencalFile = join(directory, 'dencal.sqlite3');
  const receptFile = join(directory, 'recept.sqlite3');
  const envKeys = ['DENCAL_DB', 'DENCAL_RECEPT_URL', 'DENCAL_RECEPT_TOKEN', 'DENCAL_SIGNING_CONFIG'] as const;
  const original = envKeys.map((key) => process.env[key]);
  const servers: Server[] = [];
  let currentReceiver: Awaited<ReturnType<typeof receiver>> | undefined;
  t.after(async () => {
    try {
      await Promise.all([...servers.map(close), currentReceiver?.stop()]);
    } finally {
      for (const [index, key] of envKeys.entries()) {
        if (original[index] === undefined) delete process.env[key];
        else process.env[key] = original[index];
      }
      rmSync(directory, { recursive: true, force: true });
    }
  });

  const dencalSetup = run(dencalRepo, 'python3', ['database/init.py', dencalFile]);
  const passwords = Object.fromEntries(dencalSetup.split('\n')
    .filter((line) => line.startsWith('demo-')).map((line) => line.split(' ')));
  run(receptRepo, 'python3', ['database/init.py', receptFile]);
  process.env.DENCAL_DB = dencalFile;
  delete process.env.DENCAL_SIGNING_CONFIG;
  let dencalApi = createAuthMiddleware();
  const dencalServer = createServer((req, res) => { void dencalApi(req, res, () => res.writeHead(404).end()); });
  servers.push(dencalServer);
  const dencal = await listen(dencalServer);
  const signIn = (staffId: string) => login(dencal, { staffId, password: passwords[staffId] });
  const dencalAdmin = await signIn('demo-admin');
  let doctor = await signIn('demo-physician');
  const nurse = await signIn('demo-nurse');
  const clerk = await signIn('demo-reception');
  for (const [file, contents] of masters) {
    await status(staffRequest(dencal, '/api/catalog?filename=' + file, dencalAdmin, contents, true), 200, file);
  }

  let { patient } = await json(staffRequest(dencal, '/api/clinical/patients', clerk, {
    kanjiName: name, kanaName: 'ケツゴウ シケン', sex: '男性', birthDate: '1980-01-01',
    bloodType: '', phone: '', address: '', insuranceType: '国保・一般', copayRatio: 0.3, mynaVerified: false,
    chiefComplaint: '送信対象外の架空主訴',
  }));
  const chartPath = '/api/clinical/patients/' + patient.id;
  const dencalWorkspace = async (operation = 'recept', body?: unknown, cookie = doctor): Promise<ReceptWorkspace> =>
    json(staffRequest(dencal, chartPath + '/' + operation, cookie, body), 200, operation);
  const state = await dencalWorkspace();
  const { facilityId, senderId, visitDate } = state;
  const month = visitDate.slice(0, 7);
  const { entries: [exam] } = await json(staffRequest(dencal,
    '/api/catalog/search?kind=procedure&use=performance&on=' + visitDate, nurse));
  const { entries: [disease] } = await json(staffRequest(dencal, '/api/catalog/search?kind=diagnosis', doctor));

  const specialty = '/api/clinical/patients/PT-000918';
  await status(staffRequest(dencal, specialty + '/recept', dencalAdmin), 200, '管理者の別部署参照');
  await status(staffRequest(dencal, specialty + '/recept', doctor), 404, '医師の別部署参照');
  await status(staffRequest(dencal, specialty + '/recept_queue', doctor, {
    event: 'upsert', expectedChartRevision: 1, expectedPerformanceVersion: state.performanceVersion,
  }), 404, '医師の別部署送信待ち登録');

  for (const [operation, data] of [
    ['diagnosis', { id: 'e2e-diagnosis', master: { itemId: disease.id, code: disease.code, releaseDate: disease.releaseDate },
      name: disease.name, icd10Code: '', isMain: true, isChronicDiseaseTarget: false, startDate: visitDate, outcome: 'ongoing' }],
    ['lab_order', { id: 'e2e-order-only', code: exam.code, name: exam.name }],
    ['finalize', {}],
  ] as const) {
    ({ patient } = await json(staffRequest(dencal, chartPath + '/' + operation, doctor, {
      expectedVersion: patient.draftVersion, data,
    }), 200, operation));
  }
  const addPerformance = (quantity: number) => ({
    id: randomUUID(), masterItemId: exam.id, performedOn: visitDate, quantity, unit: '回',
  });
  const firstPerformance = addPerformance(2);
  const performed = await dencalWorkspace('performance_add', firstPerformance, nurse);
  const queue = (current: ReceptWorkspace, event = 'upsert') => dencalWorkspace('recept_queue', {
    event, reason: '結合試験の訂正・取消', expectedChartRevision: current.chartRevision,
    expectedPerformanceVersion: current.performanceVersion,
  });
  const queued = await queue(performed);
  assert.equal(queued.outbox.length, 1);
  const firstId = queued.outbox[0].id;
  const send = (id: string) => dencalWorkspace('recept_send', { id });

  currentReceiver = await receiver(receptFile, facilityId, senderId, true);
  const receptPasswords = currentReceiver.passwords;
  assert.ok(receptPasswords);
  const receptLogin = (id: string) => login(currentReceiver!.origin, { id, password: receptPasswords[id] });
  let admin = await receptLogin('e2e-admin');
  let reception = await receptLogin('e2e-reception');
  const request = (path: string, body?: unknown, cookie = admin) => staffRequest(currentReceiver!.origin, path, cookie, body);
  for (const [file, contents] of masters) {
    await status(staffRequest(currentReceiver.origin, '/api/official-masters?publishedOn=2000-01-01&filename=' + file,
      admin, contents, true), 200, file);
  }

  const workspace = () => json(request('/api/workspace'));
  async function registerSameName(birthDate: string) {
    const { revision, patients } = await workspace();
    const template = patients[0];
    const result = await json(request('/api/workspace', { revision, action: { type: 'register', patient: {
      ...template, name, kana: 'ケツゴウ シケン', birthDate, lastVisitDate: visitDate,
      diagnoses: [], billingItems: [], mynaVerified: true,
    } } }, reception));
    return result.workspace.patients[0];
  }
  const otherPatient = await registerSameName('1990-02-02');
  const target = await registerSameName('1980-01-01');
  assert.notEqual(otherPatient.id, target.id);
  assert.equal(otherPatient.name, target.name);

  // Keep a RECEPT checkpoint before either app exchanges a receipt.
  const backupEnv = { ...process.env, RECEPT_DB: receptFile };
  const backup = JSON.parse(run(receptRepo, process.execPath, [
    '--import', 'tsx', 'server/backupCli.ts', 'create', join(directory, 'backups'),
  ], backupEnv));
  const attempts: { bytes: Buffer; status: number }[] = [];
  const proxyErrors: unknown[] = [];
  const proxy = createServer(async (req, res) => {
    try {
      assert.equal(req.method, 'POST');
      assert.equal(req.url, intake);
      assert.equal(req.headers.authorization, 'Bearer ' + token);
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk);
      const bytes = Buffer.concat(chunks);
      const response = await machine(currentReceiver!.origin, intake, bytes, req.headers.authorization);
      const reply = await response.text();
      attempts.push({ bytes, status: response.status });
      // Drop the first acknowledgment only after the real RECEPT API commits the receipt.
      if (attempts.length === 1 && response.status === 202) return res.destroy();
      res.writeHead(response.status, { 'Content-Type': 'application/json' }).end(reply);
    } catch (error) {
      proxyErrors.push(error);
      res.writeHead(502).end();
    }
  });
  servers.push(proxy);
  process.env.DENCAL_RECEPT_URL = await listen(proxy);
  process.env.DENCAL_RECEPT_TOKEN = token;

  const lost = await send(firstId);
  assert.equal(lost.outbox[0].lastError, 'connection_failed');
  assert.equal(lost.outbox[0].receipt, null);
  assert.equal(lost.finalized, true);
  const entries = async () => (await json(request(inbox))).records;
  const firstEntry = async () => {
    const row = (await entries()).find(({ integrationId }) => integrationId === firstId);
    assert.ok(row);
    return row;
  };
  assert.equal((await entries()).length, 1);
  assert.equal((await firstEntry()).patient, null);
  assert.deepEqual((await firstEntry()).receipt.issues, [{ code: 'patient_unmatched', path: '/patientId' }]);

  // Restore DENCAL from its backup and retry through the normal sender endpoint.
  const restoredDencal = join(directory, 'dencal-restored.sqlite3');
  copyRecordDatabase(dencalFile, restoredDencal);
  process.env.DENCAL_DB = restoredDencal;
  dencalApi = createAuthMiddleware();
  doctor = await signIn('demo-physician');
  const retried = await send(firstId);
  assert.equal(retried.senderId, senderId);
  assert.equal(retried.outbox[0].attempts, 2);
  assert.equal(retried.outbox[0].receipt?.status, 'confirmation_required');
  assert.deepEqual(attempts.map(({ status }) => status), [202, 200]);
  assert.deepEqual(attempts[0].bytes, attempts[1].bytes);
  const originalBytes = attempts[0].bytes;
  const originalMessage = JSON.parse(originalBytes.toString());
  const sha256 = createHash('sha256').update(originalBytes).digest('hex');
  assert.equal(retried.outbox[0].receipt?.bodySha256, sha256);
  assert.equal(originalMessage.patientId, patient.id);
  assert.deepEqual(originalMessage.performances.map(({ id }) => id), [firstPerformance.id]);
  assert.doesNotMatch(originalBytes.toString(), /結合試験 同姓同名|送信対象外の架空主訴|e2e-order-only/);
  assert.equal((await entries()).length, 1);

  const bind = (seq: number, person = target) => json(request(`${inbox}/${seq}/match`, {
    patientId: person.id, chartNumber: person.chartNumber,
  }, reception));
  const apply = async (seq: number) => {
    const path = `${inbox}/${seq}/draft`;
    const review = await json(request(path));
    const applied = await json(request(path, { reviewHash: review.reviewHash, qualificationConfirmed: true }));
    assert.equal(applied.receipt.status, 'applied');
    return review;
  };
  const preview = (person = target) => json(request(`/api/claim-records?patientId=${person.id}&month=${month}`));
  const finalize = async (draft: { revision: number; reviewHash: string }, reason?: string) => (await json(request('/api/workspace', {
    revision: draft.revision, action: { type: 'finalize', month, patientId: target.id, reviewHash: draft.reviewHash, correctionReason: reason },
  }))).claimRecord;
  const getRecord = (id: string) => json(request('/api/claim-records?id=' + id));
  const receiptPath = '/api/integration/v1/receipts/';
  const receipt = (id: string, expected = 200) => json(machine(currentReceiver!.origin, receiptPath + id), expected);

  const matched = await bind((await firstEntry()).seq);
  assert.equal(matched.patient.id, target.id);
  await status(request(`${inbox}/${matched.seq}/draft`, undefined, reception), 403, '受付の反映権限');
  await status(request(`${inbox}/${matched.seq}/match`, {
    patientId: otherPatient.id, chartNumber: otherPatient.chartNumber,
  }, reception), 409, '同姓同名の別人への変更');
  assert.deepEqual((await apply(matched.seq)).months, [{ month, confirmedVersion: null }]);
  assert.equal((await receipt(firstId)).status, 'applied');
  assert.equal((await preview(otherPatient)).snapshot.calculation.totalPoints, 0);
  const firstClaim = await finalize(await preview());
  assert.equal(firstClaim.version, 1);
  assert.equal(firstClaim.snapshot.month, month);
  assert.equal(firstClaim.snapshot.calculation.totalPoints, 200);
  assert.equal(firstClaim.snapshot.patient.billingItems[0].dencalSource.sourceId, firstPerformance.id);

  // Register a different sender against the same RECEPT DB. The same IDs remain isolated.
  await currentReceiver.stop();
  const anotherSender = 'e2e-other-sender';
  const otherAuthorization = 'Bearer ' + randomUUID();
  currentReceiver = await receiver(receptFile, facilityId, anotherSender, false, otherAuthorization.slice(7));
  const otherMachine = (path: string, bytes?: Buffer) => machine(currentReceiver!.origin, path, bytes, otherAuthorization);
  assert.equal((await json(otherMachine(receiptPath + firstId), 404)).error, 'receipt_not_found');
  assert.equal((await json(otherMachine(intake, originalBytes), 403)).error, 'source_scope_mismatch');
  await status(machine(currentReceiver.origin, intake, originalBytes), 401, '送信トークンの分離');
  const otherBytes = Buffer.from(JSON.stringify({ ...originalMessage, senderId: anotherSender }));
  const independent = await json(otherMachine(intake, otherBytes), 202);
  assert.deepEqual(independent.issues, [{ code: 'patient_unmatched', path: '/patientId' }]);
  await currentReceiver.stop();

  // Restore RECEPT only. DENCAL still holds the earlier receipt and can send a newer revision.
  const restoredRecept = join(directory, 'recept-restored.sqlite3');
  run(receptRepo, process.execPath, ['--import', 'tsx', 'server/backupCli.ts', 'restore', backup.generation, restoredRecept], backupEnv);
  currentReceiver = await receiver(restoredRecept, facilityId, senderId);
  admin = await receptLogin('e2e-admin');
  reception = await receptLogin('e2e-reception');
  assert.deepEqual(await entries(), []);
  assert.equal((await receipt(firstId, 404)).error, 'receipt_not_found');
  await status(request('/api/claim-records?id=' + firstClaim.id), 404, '復元時点より後の確定記録');
  await dencalWorkspace('performance_cancel', { id: firstPerformance.id, reason: '入力を取り消す' });
  const replacement = addPerformance(3);
  const corrected = await dencalWorkspace('performance_add', replacement);
  const correctionId = (await queue(corrected)).outbox[1].id;
  const early = await send(correctionId);
  assert.deepEqual(early.outbox[1].receipt?.issues.map(({ code }) => code), ['predecessor_missing', 'patient_unmatched']);
  const correctionRow = (await entries())[0];
  await status(request(`${inbox}/${correctionRow.seq}/draft`), 409, '先行版待ちの下書き');
  assert.equal((await preview()).snapshot.calculation.totalPoints, 0);

  // Recovery replays the retained original wire bytes through RECEPT's authenticated API.
  assert.equal((await json(machine(currentReceiver.origin, intake, originalBytes), 202)).bodySha256, sha256);
  assert.equal((await json(machine(currentReceiver.origin, intake, originalBytes), 200)).bodySha256, sha256);
  const changedBytes = Buffer.concat([originalBytes, Buffer.from('\n')]);
  assert.equal((await json(machine(currentReceiver.origin, intake, changedBytes), 409)).error, 'integration_id_conflict');
  assert.equal((await entries()).length, 2);
  const recovered = await bind((await firstEntry()).seq);
  assert.equal((await receipt(correctionId)).status, 'received');
  await apply(recovered.seq);
  const baseClaim = await finalize(await preview());
  assert.equal(baseClaim.snapshot.calculation.totalPoints, 200);
  assert.deepEqual((await apply(correctionRow.seq)).months, [{ month, confirmedVersion: 1 }]);
  assert.equal((await receipt(correctionId)).status, 'applied');
  assert.deepEqual(await getRecord(baseClaim.id), baseClaim);
  const amended = await finalize(await preview(), '診療行為の実施数量を訂正');
  assert.equal(amended.previousId, baseClaim.id);
  assert.equal(amended.snapshot.calculation.totalPoints, 300);
  assert.deepEqual(amended.snapshot.patient.billingItems.map(({ dencalSource }) => dencalSource.sourceId), [replacement.id]);

  const cancelId = (await queue(await dencalWorkspace(), 'cancel')).outbox[2].id;
  const sentCancel = await send(cancelId);
  assert.equal(sentCancel.outbox[2].receipt?.status, 'received');
  await apply((await entries())[0].seq);
  const cancelled = await finalize(await preview(), '受診の取消');
  assert.equal(cancelled.previousId, amended.id);
  assert.equal(cancelled.snapshot.calculation.totalPoints, 0);
  assert.deepEqual(await getRecord(amended.id), amended);
  assert.deepEqual(proxyErrors, []);
});
