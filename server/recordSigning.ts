import { execFile } from 'node:child_process';
import { createHash, X509Certificate } from 'node:crypto';
import { readFileSync, realpathSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import { ClinicalError } from './clinicalInput';

type SignerFiles = { certificate: string; key: string; chain?: string };
type Signer = SignerFiles & { fingerprint: string };

type SigningConfig = {
  signerCaFile: string;
  tsaCaFile: string;
  tsaUrl?: string;
  tsaPolicy?: string;
  tsaAuthorization?: string;
  signers: Map<string, Signer>;
};

export type SignatureEvidence = {
  cms: Buffer;
  request: Buffer;
  response: Buffer;
  signerFingerprint: string;
  timestampUtc: string;
};

const run = promisify(execFile);
const MAX_DER = 256 * 1024;

function outsideApp(path: string) {
  const actual = realpathSync(path);
  const relativePath = relative(realpathSync(process.cwd()), actual);
  if (!isAbsolute(relativePath) && relativePath !== '..' && !relativePath.startsWith('..' + sep)) {
    throw new Error('署名設定と秘密鍵はアプリのディレクトリ外に配置してください。');
  }
  return actual;
}

export function loadSigningConfig(path = process.env.DENCAL_SIGNING_CONFIG): SigningConfig | undefined {
  if (!path) return undefined;
  const location = outsideApp(resolve(path));
  const config = JSON.parse(readFileSync(location, 'utf8'));
  function file(name: unknown) {
    if (typeof name !== 'string' || !name) throw new Error('署名設定のファイルパスを確認してください。');
    return realpathSync(resolve(dirname(location), name));
  }
  let tsaUrl: URL | undefined;
  if (config.tsaUrl !== undefined) {
    tsaUrl = new URL(config.tsaUrl);
    if (tsaUrl.protocol !== 'https:' || tsaUrl.username || tsaUrl.password || tsaUrl.hash) {
      throw new Error('タイムスタンプ局には認証情報を含まないHTTPS URLを指定してください。');
    }
  }
  if (config.tsaPolicy !== undefined && (typeof config.tsaPolicy !== 'string' || !/^\d+(\.\d+)+$/.test(config.tsaPolicy))) {
    throw new Error('タイムスタンプのポリシーOIDを確認してください。');
  }
  const tsaAuthorization = config.tsaAuthorizationFile === undefined ? undefined
    : readFileSync(outsideApp(file(config.tsaAuthorizationFile)), 'utf8').trim();
  if (tsaAuthorization !== undefined && (!tsaAuthorization || tsaAuthorization.length > 4096 || /[^ -~]/.test(tsaAuthorization))) {
    throw new Error('TSAのAuthorizationヘッダーを確認してください。');
  }
  const signers = new Map<string, Signer>();
  const fingerprints = new Set<string>();
  for (const [staff, raw] of Object.entries<SignerFiles>(config.signers ?? {})) {
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(staff)) throw new Error('署名設定の職員IDを確認してください。');
    const certificate = file(raw.certificate);
    const certificateFingerprint = fingerprint(readFileSync(certificate));
    if (fingerprints.has(certificateFingerprint)) throw new Error('署名証明書を複数の職員で共有できません。');
    fingerprints.add(certificateFingerprint);
    signers.set(staff, {
      certificate, key: outsideApp(file(raw.key)),
      chain: raw.chain ? file(raw.chain) : undefined, fingerprint: certificateFingerprint,
    });
  }
  return {
    signerCaFile: file(config.signerCaFile), tsaCaFile: file(config.tsaCaFile),
    tsaUrl: tsaUrl?.href, tsaPolicy: config.tsaPolicy, tsaAuthorization, signers,
  };
}

async function openssl(directory: string, args: string[]) {
  const { stdout } = await run('openssl', args, {
    cwd: directory, timeout: 8_000, maxBuffer: MAX_DER, windowsHide: true,
    env: { ...process.env, LC_ALL: 'C' },
  });
  return stdout;
}

async function inPrivateDirectory<T>(task: (directory: string) => Promise<T>): Promise<T> {
  const directory = await mkdtemp(join(tmpdir(), 'dencal-signature-'));
  try {
    return await task(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function timestampRequest(url: string, query: Buffer, authorization?: string) {
  const result = await fetch(url, {
    method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10_000),
    headers: {
      'Content-Type': 'application/timestamp-query', Accept: 'application/timestamp-reply',
      ...(authorization && { Authorization: authorization }),
    },
    body: new Uint8Array(query),
  });
  if (!result.ok || result.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/timestamp-reply' || !result.body) {
    await result.body?.cancel();
    throw new Error('Invalid TSA response');
  }
  const reader = result.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > MAX_DER) throw new Error('TSA response too large');
      chunks.push(value);
    }
  } finally {
    await reader.cancel();
  }
  return Buffer.concat(chunks, size);
}

function fingerprint(certificate: Buffer) {
  return new X509Certificate(certificate).fingerprint256.replaceAll(':', '').toLowerCase();
}

async function verifyFiles(directory: string, config: SigningConfig) {
  const text = await openssl(directory, ['ts', '-reply', '-in', 'time.tsr', '-text']);
  const match = /^Time stamp:\s*(.+)$/m.exec(text);
  const epochMs = match ? Date.parse(match[1].trim()) : NaN;
  if (!Number.isFinite(epochMs)) throw new Error('Timestamp missing');
  const attime = String(Math.floor(epochMs / 1000));
  const tsVerify = ['ts', '-verify', '-in', 'time.tsr', '-CAfile', config.tsaCaFile, '-attime', attime];
  // The saved request checks the nonce and requested policy. The independent data check binds the token to the CMS.
  await openssl(directory, [...tsVerify, '-queryfile', 'time.tsq']);
  await openssl(directory, [...tsVerify, '-data', 'signature.der']);
  await openssl(directory, ['cms', '-verify', '-binary', '-inform', 'DER', '-cades', '-in', 'signature.der',
    '-content', 'revision.json', '-CAfile', config.signerCaFile, '-no-CApath', '-no-CAstore',
    '-purpose', 'any', '-attime', attime, '-signer', 'verified.pem', '-out', 'verified.json']);
  const verified = await readFile(join(directory, 'verified.pem'));
  if (verified.toString().match(/-----BEGIN CERTIFICATE-----/g)?.length !== 1) throw new Error('Expected one signer');
  const usage = await openssl(directory, ['x509', '-in', 'verified.pem', '-noout', '-ext', 'keyUsage']);
  if (!/Digital Signature|Non Repudiation/.test(usage) || new X509Certificate(verified).ca) {
    throw new Error('Certificate is not a leaf signing certificate');
  }
  return { signerFingerprint: fingerprint(verified), timestampUtc: new Date(epochMs).toISOString() };
}

export async function signRevision(config: SigningConfig, staffId: string, payload: Buffer): Promise<SignatureEvidence> {
  const signer = config.signers.get(staffId);
  if (!signer || !config.tsaUrl) throw new ClinicalError(503, 'signing_not_configured');
  try {
    return await inPrivateDirectory(async (directory) => {
      await writeFile(join(directory, 'revision.json'), payload, { mode: 0o600 });
      await openssl(directory, ['cms', '-sign', '-binary', '-md', 'sha256', '-cades', '-in', 'revision.json',
        '-signer', signer.certificate, '-inkey', signer.key, '-passin', 'pass:', '-outform', 'DER', '-out', 'signature.der',
        ...(signer.chain ? ['-certfile', signer.chain] : [])]);
      await openssl(directory, ['ts', '-query', '-data', 'signature.der', '-sha256', '-cert', '-out', 'time.tsq',
        ...(config.tsaPolicy ? ['-tspolicy', config.tsaPolicy] : [])]);
      const request = await readFile(join(directory, 'time.tsq'));
      const response = await timestampRequest(config.tsaUrl, request, config.tsaAuthorization);
      await writeFile(join(directory, 'time.tsr'), response, { mode: 0o600 });
      const metadata = await verifyFiles(directory, config);
      if (metadata.signerFingerprint !== signer.fingerprint ||
          Math.abs(Date.now() - Date.parse(metadata.timestampUtc)) > 300_000) {
        throw new Error('Signer or timestamp mismatch');
      }
      const cms = await readFile(join(directory, 'signature.der'));
      if (cms.length > MAX_DER || request.length > MAX_DER) throw new Error('Evidence too large');
      return { cms, request, response, ...metadata };
    });
  } catch {
    throw new ClinicalError(503, 'signing_failed');
  }
}

export async function verifyRevisionSignature(config: SigningConfig, payload: Buffer, evidence: SignatureEvidence) {
  try {
    return await inPrivateDirectory(async (directory) => {
      await writeFile(join(directory, 'revision.json'), payload, { mode: 0o600 });
      await writeFile(join(directory, 'signature.der'), evidence.cms, { mode: 0o600 });
      await writeFile(join(directory, 'time.tsq'), evidence.request, { mode: 0o600 });
      await writeFile(join(directory, 'time.tsr'), evidence.response, { mode: 0o600 });
      const metadata = await verifyFiles(directory, config);
      if (metadata.signerFingerprint !== evidence.signerFingerprint || metadata.timestampUtc !== evidence.timestampUtc) {
        throw new Error('Evidence metadata mismatch');
      }
      return metadata;
    });
  } catch {
    throw new ClinicalError(409, 'signature_verification_failed');
  }
}

export function evidenceDigest(evidence: SignatureEvidence) {
  const hash = createHash('sha256');
  for (const value of [evidence.cms, evidence.request, evidence.response]) {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(value.length);
    hash.update(length).update(value);
  }
  return hash.update(JSON.stringify([evidence.signerFingerprint, evidence.timestampUtc])).digest('hex');
}
