import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { createAuthMiddleware } from './auth';
import { copyRecordDatabase } from './recordTransfer';

const opensslInstalled = spawnSync('openssl', ['version']).status === 0;

test('CMS and RFC 3161 evidence are verified and committed with the exact finalized draft', { skip: !opensslInstalled }, async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'dencal-tsa-test-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const openssl = (...args: string[]) => execFileSync('openssl', args, { cwd: directory, stdio: 'pipe' });
  openssl('req', '-new', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '2', '-subj', '/CN=Local Test CA',
    '-addext', 'basicConstraints=critical,CA:TRUE', '-addext', 'keyUsage=critical,keyCertSign,cRLSign',
    '-keyout', 'ca.key', '-out', 'ca.pem');
  for (const [name, ext] of [
    ['doctor', 'keyUsage=critical,digitalSignature,nonRepudiation'],
    ['tsa', 'keyUsage=critical,digitalSignature\nextendedKeyUsage=critical,timeStamping'],
  ]) {
    writeFileSync(join(directory, name + '.ext'), 'basicConstraints=critical,CA:FALSE\n' + ext + '\n');
    openssl('req', '-new', '-newkey', 'rsa:2048', '-nodes', '-subj', '/CN=Local Test ' + name,
      '-keyout', name + '.key', '-out', name + '.csr');
    openssl('x509', '-req', '-days', '2', '-in', name + '.csr', '-CA', 'ca.pem', '-CAkey', 'ca.key',
      '-CAcreateserial', '-extfile', name + '.ext', '-out', name + '.pem');
  }
  writeFileSync(join(directory, 'tsa.serial'), '01\n');
  writeFileSync(join(directory, 'tsa.cnf'), `
[tsa]
default_tsa = authority
[authority]
serial = tsa.serial
signer_cert = tsa.pem
certs = ca.pem
signer_key = tsa.key
signer_digest = sha256
default_policy = 1.2.3.4.5
digests = sha256
accuracy = secs:1
ordering = no
tsa_name = yes
ess_cert_id_chain = no
ess_cert_id_alg = sha256
`);
  const database = join(directory, 'clinical.sqlite3');
  const init = execFileSync('python3', ['database/init.py', database], { encoding: 'utf8' });
  const credentials = new Map(init.split('\n').filter((line) => line.startsWith('demo-'))
    .map((line) => line.split(' ') as [string, string]));
  const tsaUrl = 'https://tsa.example.invalid/';
  const config = join(directory, 'signing.json');
  writeFileSync(config, JSON.stringify({
    signerCaFile: 'ca.pem', tsaCaFile: 'ca.pem', tsaUrl, tsaPolicy: '1.2.3.4.5',
    signers: { 'demo-physician': { certificate: 'doctor.pem', key: 'doctor.key' } },
  }), { mode: 0o600 });
  function middlewareFor(path: string, configured = true) {
    const oldDb = process.env.DENCAL_DB;
    const oldConfig = process.env.DENCAL_SIGNING_CONFIG;
    process.env.DENCAL_DB = path;
    if (configured) process.env.DENCAL_SIGNING_CONFIG = config;
    else delete process.env.DENCAL_SIGNING_CONFIG;
    try {
      return createAuthMiddleware();
    } finally {
      if (oldDb === undefined) delete process.env.DENCAL_DB;
      else process.env.DENCAL_DB = oldDb;
      if (oldConfig === undefined) delete process.env.DENCAL_SIGNING_CONFIG;
      else process.env.DENCAL_SIGNING_CONFIG = oldConfig;
    }
  }

  let middleware = middlewareFor(database);
  const server = createServer((req, res) => {
    void middleware(req, res, () => res.writeHead(404).end());
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const origin = `http://127.0.0.1:${address.port}`;
  const realFetch = globalThis.fetch;
  let requests = 0;
  let offline = true;
  let duringTimestamp: (() => Promise<void>) | undefined;
  t.mock.method(globalThis, 'fetch', async (url: string, init?: RequestInit) => {
    if (url !== tsaUrl) return realFetch(url, init);
    requests++;
    assert.equal(init?.method, 'POST');
    const query = Buffer.from(init?.body as Uint8Array);
    assert.equal(query.includes('テスト署名対象'), false);
    if (offline) return new Response(null, { status: 503 });
    if (duringTimestamp) await duringTimestamp();
    writeFileSync(join(directory, 'test.tsq'), query);
    openssl('ts', '-reply', '-config', 'tsa.cnf', '-queryfile', 'test.tsq', '-out', 'test.tsr');
    return new Response(new Uint8Array(readFileSync(join(directory, 'test.tsr'))), {
      headers: { 'Content-Type': 'application/timestamp-reply' },
    });
  });

  const request = (route: string, cookie = '', body?: unknown) => realFetch(origin + '/api/' + route, {
    headers: { Cookie: cookie, Origin: origin, 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }),
  });
  async function login(staffId: string) {
    const response = await request('login', '', { staffId, password: credentials.get(staffId) });
    assert.equal(response.status, 200);
    return response.headers.get('set-cookie')!.split(';')[0];
  }
  const doctor = await login('demo-physician');
  const admin = await login('demo-admin');
  const target = 'clinical/patients/PT-001105';
  const chart = async () => (await (await request(target, doctor)).json()).patient;
  let version = (await chart()).draftVersion;
  async function edit(action: string, cookie: string, data: unknown = {}) {
    return request(target + '/' + action, cookie, { expectedVersion: version, data });
  }
  const entered = await edit('soap', doctor, { subjective: 'テスト署名対象' });
  assert.equal(entered.status, 200);
  version = (await entered.json()).patient.draftVersion;
  assert.equal((await edit('finalize', admin)).status, 503);
  assert.equal(requests, 0);
  assert.equal((await edit('finalize', doctor)).status, 503);
  assert.equal((await chart()).draftVersion, version);
  assert.equal((await chart()).revisions.length, 0);

  offline = false;
  duringTimestamp = async () => {
    const changed = await edit('soap', doctor, { plan: '時刻取得中の更新' });
    assert.equal(changed.status, 200);
    version = (await changed.json()).patient.draftVersion;
  };
  assert.equal((await edit('finalize', doctor)).status, 409);
  assert.equal((await chart()).revisions.length, 0);
  duringTimestamp = undefined;
  const completed = await edit('finalize', doctor);
  assert.equal(completed.status, 200, await completed.clone().text());
  const { patient } = await completed.json();
  const revision = patient.revisions[0];
  assert.equal(revision.soap.plan, '時刻取得中の更新');
  assert.match(revision.electronicSignature.signerFingerprint, /^[0-9a-f]{64}$/);
  const records = await (await request('clinical/records?q=PT-001105', doctor)).json();
  const record = 'clinical/records/' + records.records[0].encounterId;
  const older = await (await request('clinical/records?q=PT-001089', doctor)).json();
  const unsigned = await request(`clinical/records/${older.records[0].encounterId}/1/signature`, doctor);
  assert.deepEqual(await unsigned.json(), { status: 'unsigned' });
  const checked = await request(record + '/1/signature', doctor);
  assert.equal(checked.status, 200);
  assert.deepEqual(await checked.json(), { status: 'verified', ...revision.electronicSignature });
  assert.equal(requests, 3);

  const restored = join(directory, 'restored.sqlite3');
  assert.equal(copyRecordDatabase(database, restored), 4);
  writeFileSync(config, JSON.stringify({ signerCaFile: 'ca.pem', tsaCaFile: 'ca.pem' }));
  middleware = middlewareFor(restored);
  const restoredDoctor = await login('demo-physician');
  const rechecked = await request(record + '/1/signature', restoredDoctor);
  assert.equal(rechecked.status, 200);
  assert.deepEqual(await rechecked.json(), { status: 'verified', ...revision.electronicSignature });
  assert.equal(requests, 3);
  writeFileSync(config, JSON.stringify({ signerCaFile: 'ca.pem', tsaCaFile: 'doctor.pem' }));
  middleware = middlewareFor(restored);
  const wrongTrust = await request(record + '/1/signature', restoredDoctor);
  assert.equal(wrongTrust.status, 409);
  assert.equal((await wrongTrust.json()).error, 'signature_verification_failed');
  middleware = middlewareFor(restored, false);
  const another = (await (await request('clinical/patients/PT-001042', restoredDoctor)).json()).patient;
  const refused = await request('clinical/patients/PT-001042/finalize', restoredDoctor, {
    expectedVersion: another.draftVersion, data: {},
  });
  assert.equal(refused.status, 503);
  assert.equal((await refused.json()).error, 'signing_not_configured');
  writeFileSync(config, JSON.stringify({ signerCaFile: 'ca.pem', tsaCaFile: 'ca.pem' }));
  middleware = middlewareFor(restored);

  const db = new DatabaseSync(restored);
  try {
    assert.throws(() => db.exec("UPDATE clinical_revision_signatures SET response_der = X'00'"), /immutable/);
    db.exec("DROP TRIGGER clinical_signature_no_update; UPDATE clinical_revision_signatures SET response_der = X'00'");
  } finally {
    db.close();
  }
  const broken = await request(record + '/1/signature', restoredDoctor);
  assert.equal(broken.status, 409);
  assert.equal((await broken.json()).error, 'record_integrity_error');
});
