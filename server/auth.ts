import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { extname, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { CatalogError, listCatalogs, receiveCatalog, saveCatalog, searchCatalog } from './catalog';
import { clinicalRoute, handleClinical, prepareClinicalSignature } from './clinical';
import { CLINICAL_DB_VERSION, findEncounterChart, readRevisionSignature, seedClinicalCharts, type Actor, type SignedFinalization } from './clinicalStore';
import { loadSigningConfig, signRevision, verifyRevisionSignature } from './recordSigning';
import { ClinicalError, readClinicalInput } from './clinicalInput';
import type { StaffMember } from '../src/types/emr';
import { canPerformAction, isEmrAction } from '../src/utils/permissions';

const COOKIE = 'dencal_session';
const SESSION_SECONDS = 30 * 60;
const MAX_BODY = 4096;
const loopbackHost = /^(?:127\.0\.0\.1|localhost)(?::[0-9]{1,5})?$/;
const roles = {
  reception: ['clerk', '受付'],
  nurse: ['nurse', '看護師'],
  physician: ['doctor', '医師'],
  admin: ['admin', '管理者'],
} as const;

type StaffRow = {
  id: number;
  staff_code: string;
  display_name: string;
  department: string | null;
  department_code: string | null;
  role: keyof typeof roles;
};

type CredentialRow = StaffRow & { salt: Uint8Array; password_hash: Uint8Array };

function staffMember(row: StaffRow): StaffMember {
  const [role, roleLabel] = roles[row.role];
  return {
    id: row.staff_code, name: row.display_name, role, roleLabel,
    department: row.department ?? '', departmentCode: row.department_code ?? undefined, twoFactorEnabled: false,
  };
}

function digestToken(token: string) {
  return createHash('sha256').update(token).digest('hex');
}

function sessionHash(req: IncomingMessage) {
  const token = req.headers.cookie?.split(';').map((part) => part.trim())
    .find((part) => part.startsWith(COOKIE + '='))?.slice(COOKIE.length + 1);
  return token && /^[A-Za-z0-9_-]{43}$/.test(token) ? digestToken(token) : null;
}

function json(res: ServerResponse, status: number, value: unknown) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(JSON.stringify(value));
}

async function credentials(req: IncomingMessage) {
  if (req.headers['content-type']?.split(';')[0] !== 'application/json') return null;
  const length = Number(req.headers['content-length']);
  if (!Number.isSafeInteger(length) || length < 1 || length > MAX_BODY) return null;
  const buffers: Buffer[] = [];
  try {
    for await (const chunk of req) buffers.push(chunk);
    const input = JSON.parse(Buffer.concat(buffers).toString('utf8'));
    const { staffId, password } = input ?? {};
    if (typeof staffId === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(staffId)
      && typeof password === 'string' && password.length && Buffer.byteLength(password) <= 256) {
      return { staffId, password };
    }
  } catch {
    // Invalid JSON follows the same error path as missing fields.
  }
  return null;
}

function openDatabase(path: string, readOnly: boolean) {
  // A read-only probe prevents SQLite from creating an uninitialized database.
  const probe = new DatabaseSync(path, { readOnly: true });
  let version: unknown;
  try {
    version = probe.prepare('PRAGMA user_version').get()?.user_version;
  } finally {
    probe.close();
  }
  if (version === 2 || version === 3 || version === 4) {
    const migration = new DatabaseSync(path);
    try {
      migration.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 3000; BEGIN IMMEDIATE');
      if (migration.prepare('PRAGMA user_version').get()?.user_version === 2) {
        migration.exec(readFileSync(resolve('database/clinical-departments.sql'), 'utf8'));
      }
      version = migration.prepare('PRAGMA user_version').get()?.user_version;
      if (version === 3) {
        migration.exec(readFileSync(resolve('database/clinical-records.sql'), 'utf8'));
        seedClinicalCharts(migration);
        migration.exec('PRAGMA user_version = 4');
        version = 4;
      }
      if (version === 4) {
        migration.exec(readFileSync(resolve('database/clinical-signatures.sql'), 'utf8'));
        migration.exec(`PRAGMA user_version = ${CLINICAL_DB_VERSION}`);
        version = CLINICAL_DB_VERSION;
      }
      migration.exec('COMMIT');
    } finally {
      migration.close();
    }
  }
  if (version !== CLINICAL_DB_VERSION) throw new Error('Unsupported database version');
  return new DatabaseSync(path, { readOnly });
}

export function createAuthMiddleware() {
  const path = resolve(process.env.DENCAL_DB || 'data/dencal.sqlite3');
  if (extname(path) !== '.sqlite3') throw new Error('DENCAL_DB には .sqlite3 ファイルを指定してください。');
  const signing = loadSigningConfig();
  let failedLogins = 0;
  let windowEnd = 0;

  return async (req: IncomingMessage, res: ServerResponse, next: () => void) => {
    const route = req.url?.split('?')[0];
    if (!route?.startsWith('/api/')) return next();
    const host = req.headers.host ?? '';
    if (!loopbackHost.test(host) || !['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress ?? '')) return json(res, 403, { error: 'forbidden' });

    const access = /^\/api\/access\/([a-z_]+)$/.exec(route)?.[1];
    const catalogSearch = route === '/api/catalog/search';
    const catalog = route === '/api/catalog';
    const clinical = clinicalRoute(route, req.method);
    const read = clinical?.method === 'GET' || catalogSearch || (catalog && req.method !== 'POST') || route === '/api/session' || (access !== undefined && isEmrAction(access));
    const write = clinical?.method === 'POST' || (catalog && req.method === 'POST') || route === '/api/login' || route === '/api/logout';
    if (!read && !write) return json(res, 404, { error: 'not_found' });
    if (req.method !== (read ? 'GET' : 'POST')) {
      res.setHeader('Allow', read ? 'GET' : 'POST');
      return json(res, 405, { error: 'method_not_allowed' });
    }
    if (write && req.headers.origin !== 'http://' + host) return json(res, 403, { error: 'forbidden' });

    let login: Awaited<ReturnType<typeof credentials>> = null;
    if (route === '/api/login') {
      login = await credentials(req);
      if (!login) return json(res, 400, { error: 'invalid_input' });
      const now = Date.now();
      if (now >= windowEnd) {
        failedLogins = 0;
        windowEnd = now + 60_000;
      }
      if (failedLogins >= 10) {
        res.setHeader('Retry-After', String(Math.ceil((windowEnd - now) / 1000)));
        return json(res, 429, { error: 'too_many_attempts' });
      }
    }

    let db: DatabaseSync | undefined;
    try {
      const clinicalWrites = clinical && (write || clinical.kind === 'patient' || clinical.kind === 'archive' || clinical.kind === 'record');
      db = openDatabase(path, read && !clinicalWrites);
      db.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 3000');
      const now = Math.floor(Date.now() / 1000);
      const hash = sessionHash(req);
      const clearCookie = COOKIE + '=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0';

      if (login) {
        const account = db.prepare(`
          SELECT s.id, s.staff_code, s.display_name, s.role, d.name AS department, d.code AS department_code, c.salt, c.password_hash
          FROM staff s JOIN staff_credentials c ON c.staff_id = s.id
          LEFT JOIN departments d ON d.id = s.department_id WHERE s.staff_code = ? AND s.active = 1
        `).get(login.staffId) as CredentialRow | undefined;
        const candidate = scryptSync(login.password, account?.salt ?? Buffer.alloc(16), 32,
          { N: 32768, r: 8, p: 3, maxmem: 64 * 1024 * 1024 });
        if (!timingSafeEqual(candidate, account?.password_hash ?? Buffer.alloc(32)) || !account) {
          failedLogins++;
          return json(res, 401, { error: 'invalid_credentials' });
        }
        const token = randomBytes(32).toString('base64url');
        db.exec('BEGIN IMMEDIATE');
        db.prepare('DELETE FROM staff_sessions WHERE expires_at <= ? OR token_hash = ?').run(now, hash);
        db.prepare('INSERT INTO staff_sessions(token_hash, staff_id, expires_at) VALUES (?, ?, ?)')
          .run(digestToken(token), account.id, now + SESSION_SECONDS);
        db.exec('COMMIT');
        res.setHeader('Set-Cookie', COOKIE + '=' + token + '; Path=/; HttpOnly; SameSite=Strict; Max-Age=' + SESSION_SECONDS);
        return json(res, 200, { staff: staffMember(account) });
      }

      if (route === '/api/logout') {
        if (hash) db.prepare('DELETE FROM staff_sessions WHERE token_hash = ?').run(hash);
        res.setHeader('Set-Cookie', clearCookie);
        return json(res, 200, { staff: null });
      }

      const session = db.prepare(`
        SELECT s.id, s.staff_code, s.display_name, s.role, d.name AS department, d.code AS department_code
        FROM staff_sessions ss JOIN staff s ON s.id = ss.staff_id
        LEFT JOIN departments d ON d.id = s.department_id
        WHERE ss.token_hash = ? AND ss.expires_at > ? AND s.active = 1
      `);
      const currentSession = () => hash ? session.get(hash, Math.floor(Date.now() / 1000)) as StaffRow | undefined : undefined;
      const row = currentSession();
      if (!row) return json(res, 401, { error: 'login_required' });

      const staff = staffMember(row);
      if (clinical) {
        if (!canPerformAction(staff.role, clinical.action)) return json(res, 403, { error: 'forbidden' });
        const input = write ? await readClinicalInput(req) : undefined;
        function transaction<T>(writing: boolean, action: (actor: Actor) => T): T {
          db!.exec(writing ? 'BEGIN IMMEDIATE' : 'BEGIN');
          try {
            const actor = currentSession();
            if (!actor) throw new ClinicalError(401, 'login_required');
            const staff = staffMember(actor);
            if (!canPerformAction(staff.role, clinical.action)) throw new ClinicalError(403, 'forbidden');
            const result = action({
              ...staff, staffId: actor.id, databaseRole: actor.role, departmentCode: actor.department_code,
            });
            db!.exec('COMMIT');
            return result;
          } catch (error) {
            db!.exec('ROLLBACK');
            throw error;
          }
        }

        if (clinical.kind === 'signature_check') {
          const proof = transaction(false, (actor) =>
            readRevisionSignature(db!, findEncounterChart(db!, actor, clinical.encounterId), clinical.revision));
          if (!proof) return json(res, 200, { status: 'unsigned' });
          if (!signing) throw new ClinicalError(503, 'signing_not_configured');
          const metadata = await verifyRevisionSignature(signing, proof.payload, proof.evidence);
          // Do not return evidence metadata if access expired while OpenSSL was running.
          transaction(false, (actor) => { findEncounterChart(db!, actor, clinical.encounterId); });
          return json(res, 200, { status: 'verified', ...metadata });
        }

        let signed: SignedFinalization | undefined;
        if (signing && clinical.kind === 'operation' && clinical.operation === 'finalize') {
          const candidate = transaction(false, (actor) => ({
            staffId: actor.id, ...prepareClinicalSignature(db!, actor, clinical.patientId, input),
          }));
          // No database lock is held while waiting for the timestamp authority.
          const evidence = await signRevision(signing, candidate.staffId, candidate.payload);
          signed = { time: candidate.time, payload: candidate.payload, evidence };
        }
        const result = transaction(Boolean(clinicalWrites), (actor) =>
          handleClinical(db!, clinical, actor, input, new URLSearchParams(req.url?.split('?')[1]), signed));
        return json(res, 200, result);
      }
      if (access && (!isEmrAction(access) || !canPerformAction(staff.role, access))) {
        return json(res, 403, { error: 'forbidden' });
      }
      if (catalog || catalogSearch) {
        if (!canPerformAction(staff.role, catalog ? 'manage_catalog' : 'edit_soap')) {
          return json(res, 403, { error: 'この操作を行う職種の権限がありません。' });
        }
        const params = new URLSearchParams(req.url?.split('?')[1]);
        if (catalogSearch) return json(res, 200, searchCatalog(db, params));
        if (read) return json(res, 200, listCatalogs(db));
        return json(res, 200, saveCatalog(db, await receiveCatalog(req, params)));
      }
      return json(res, 200, access ? { allowed: true } : { staff });
    } catch (error) {
      if (error instanceof CatalogError || error instanceof ClinicalError) return json(res, error.status, { error: error.message });
      return json(res, 503, { error: 'database_unavailable' });
    } finally {
      db?.close();
    }
  };
}
