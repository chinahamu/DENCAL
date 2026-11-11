import { closeSync, fsyncSync, linkSync, lstatSync, mkdtempSync, openSync, rmSync } from 'node:fs';
import { dirname, extname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';
import { verifyReceptOutbox } from './receptOutbox';
import { CLINICAL_DB_VERSION, verifyClinicalStore } from './clinicalStore';

const expectedTriggers = ['clinical_revision_no_update', 'clinical_revision_no_delete', 'clinical_revision_no_replace'];

function openDatabase(path: string, readOnly: boolean) {
  if (extname(path) !== '.sqlite3') throw new Error('拡張子 .sqlite3 のファイルを指定してください。');
  const db = new DatabaseSync(path, { readOnly });
  try {
    db.exec('PRAGMA busy_timeout = 5000; PRAGMA trusted_schema = OFF; PRAGMA foreign_keys = ON');
    const version = db.prepare('PRAGMA user_version').get()?.user_version;
    if (version !== 4 && version !== 5 && version !== CLINICAL_DB_VERSION) {
      throw new Error(`診療録の保存に対応した DENCAL のDB（バージョン 4〜${CLINICAL_DB_VERSION}）を指定してください。`);
    }
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

function verify(db: DatabaseSync) {
  const check = db.prepare('PRAGMA integrity_check(1)').get()?.integrity_check;
  if (check !== 'ok' || db.prepare('PRAGMA foreign_key_check').get()) {
    throw new Error('SQLiteの整合性検査に失敗しました。');
  }
  const triggers = db.prepare("SELECT name FROM sqlite_schema WHERE type = 'trigger' AND tbl_name = 'clinical_note_revisions'")
    .all().map((row) => row.name);
  if (!expectedTriggers.every((trigger) => triggers.includes(trigger))) {
    throw new Error('確定版を保護するトリガーがありません。');
  }
  if (Number(db.prepare('PRAGMA user_version').get()?.user_version) >= 5) {
    const signatures = db.prepare("SELECT count(*) AS total FROM sqlite_schema WHERE type = 'trigger' AND name IN ('clinical_signature_no_update', 'clinical_signature_no_delete', 'clinical_signature_no_replace')").get();
    if (signatures?.total !== 3) throw new Error('署名証跡を保護するトリガーがありません。');
  }
  try {
    const count = verifyClinicalStore(db);
    if (Number(db.prepare('PRAGMA user_version').get()?.user_version) >= 6) verifyReceptOutbox(db);
    return count;
  } catch {
    throw new Error('診療録の構造または確定版のハッシュを検証できませんでした。');
  }
}

export function verifyRecordDatabase(path: string): number {
  const db = openDatabase(resolve(path), true);
  try {
    db.exec('BEGIN');
    return verify(db);
  } finally {
    db.close();
  }
}

export function copyRecordDatabase(source: string, target: string): number {
  const destination = resolve(target);
  if (extname(destination) !== '.sqlite3') throw new Error('保存先の拡張子には .sqlite3 を指定してください。');
  if (lstatSync(destination, { throwIfNoEntry: false })) throw new Error('保存先に既存のファイルがあります。');

  const directory = mkdtempSync(join(dirname(destination), '.dencal-transfer-'));
  const snapshot = join(directory, 'records.sqlite3');
  try {
    closeSync(openSync(snapshot, 'wx', 0o600));
    const db = openDatabase(resolve(source), true);
    try {
      // A consistent SQLite snapshot, including committed data still in the source WAL.
      db.prepare('VACUUM INTO ?').run(snapshot);
    } finally {
      db.close();
    }

    const copy = openDatabase(snapshot, false);
    let count: number;
    try {
      copy.exec('PRAGMA journal_mode = DELETE; PRAGMA synchronous = FULL');
      // Credentials stay with the database. Browser sessions must not move between installations.
      copy.exec('DELETE FROM staff_sessions');
      count = verify(copy);
    } finally {
      copy.close();
    }

    const fd = openSync(snapshot, 'r+');
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    // Publish only the verified file, and fail atomically if another process took the destination.
    linkSync(snapshot, destination);
    return count;
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const [operation, first, second, extra] = process.argv.slice(2);
  try {
    let count: number;
    if (operation === 'export' && first && !second) {
      count = copyRecordDatabase(process.env.DENCAL_DB || 'data/dencal.sqlite3', first);
    } else if (operation === 'verify' && first && !second) {
      count = verifyRecordDatabase(first);
    } else if (operation === 'restore' && first && second && !extra) {
      count = copyRecordDatabase(first, second);
    } else {
      throw new Error('使い方: records:export -- 保存先.sqlite3 / records:verify -- 保存済み.sqlite3 / records:restore -- 保存済み.sqlite3 復元先.sqlite3');
    }
    console.log(`検証済みの受診記録 ${count} 件`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
