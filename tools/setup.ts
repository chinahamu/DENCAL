/**
 * First-run setup: create both SQLite databases from user-provided official files.
 * Neither downloaded source files nor generated databases are distributed.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync,
  rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { parseOfficialCatalogFile, saveCatalog } from '../server/catalog';
import { CLINICAL_DB_VERSION, seedClinicalCharts } from '../server/clinicalStore';

const root = fileURLToPath(new URL('../', import.meta.url));

type Options = { input: string; db: string; pmdaDb: string };
type MasterReport = { file: string; kind: string; release: string; count: number };
type PmdaReport = { xml_files: number; imported_documents: number; products: number;
  sections: number; errors: { file: string; reason: string }[] };

function args(): Options {
  const options: Options = {
    input: resolve(root, 'setup-input'),
    db: resolve(root, 'data/dencal.sqlite3'),
    pmdaDb: resolve(root, 'data/pmda-safety.sqlite3'),
  };
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === '--input' || flag === '--db' || flag === '--pmda-db') {
      const value = argv[++i];
      if (!value || value.startsWith('--')) throw new Error(flag + ' の値を指定してください。');
      const key = flag === '--input' ? 'input' : flag === '--db' ? 'db' : 'pmdaDb';
      options[key] = resolve(value);
    } else if (flag === '--help' || flag === '-h') {
      console.log('npm run db:init -- [--input setup-input] [--db data/dencal.sqlite3] [--pmda-db data/pmda-safety.sqlite3]');
      process.exit(0);
    } else {
      throw new Error('不明な引数: ' + flag);
    }
  }
  if (options.db === options.pmdaDb) throw new Error('診療DBとPMDA DBには別のファイルを指定してください。');
  if (!options.db.endsWith('.sqlite3') || !options.pmdaDb.endsWith('.sqlite3')) {
    throw new Error('出力DBの拡張子は .sqlite3 にしてください。');
  }
  return options;
}

function officialMasters(directory: string) {
  if (!existsSync(directory) || !statSync(directory).isDirectory()) {
    throw new Error('公式マスターの配置先がありません: ' + directory);
  }
  const files = readdirSync(directory).filter(name => /^[bys]_[0-9]{8}\.(csv|txt)$/.test(name)).sort();
  for (const [kind, ext] of [['b', '.txt'], ['y', '.csv'], ['s', '.csv']]) {
    if (!files.some(name => name.startsWith(kind + '_') && name.endsWith(ext))) {
      throw new Error('公式マスターが不足しています。' + kind + '_YYYYMMDD' + ext + ' を ' + directory + ' に配置してください。');
    }
  }
  for (const name of files) {
    if ((name.startsWith('b_') && !name.endsWith('.txt')) ||
        (!name.startsWith('b_') && !name.endsWith('.csv'))) {
      throw new Error('マスターの拡張子が不正です: ' + name);
    }
  }
  return files;
}

function findPython(): string[] {
  const choices = process.env.DENCAL_PYTHON
    ? [[process.env.DENCAL_PYTHON]]
    : process.platform === 'win32'
      ? [['py', '-3'], ['python'], ['python3']]
      : [['python3'], ['python']];
  for (const candidate of choices) {
    const probe = spawnSync(candidate[0], [...candidate.slice(1), '-c', 'import sys; assert sys.version_info >= (3, 10)'], { encoding: 'utf8' });
    if (probe.status === 0) return candidate;
  }
  throw new Error('Python 3.10以降が必要です。DENCAL_PYTHON環境変数で実行ファイルを指定できます。');
}

function python(command: string[], script: string, params: string[]) {
  const result = spawnSync(command[0], [...command.slice(1), script, ...params], {
    cwd: root, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024,
  });
  if (result.error || result.status !== 0) {
    throw new Error('Python処理に失敗しました: ' + script + '\n' +
      (result.stderr?.trim() || result.stdout?.trim() || result.error?.message || String(result.status)));
  }
  return result.stdout;
}

function upgrade(db: DatabaseSync) {
  const version = db.prepare('PRAGMA user_version').get()?.user_version;
  if (version !== 3) throw new Error('初期DBが想定スキーマではありません: ' + String(version));
  db.exec('PRAGMA foreign_keys = ON; BEGIN IMMEDIATE');
  try {
    db.exec(readFileSync(join(root, 'database/clinical-records.sql'), 'utf8'));
    seedClinicalCharts(db);
    db.exec('PRAGMA user_version = 4');
    db.exec(readFileSync(join(root, 'database/clinical-signatures.sql'), 'utf8'));
    db.exec('PRAGMA user_version = 5');
    db.exec(readFileSync(join(root, 'database/recept-outbox.sql'), 'utf8'));
    db.exec('PRAGMA user_version = 6');
    db.exec(readFileSync(join(root, 'database/clinical-images.sql'), 'utf8'));
    db.exec('PRAGMA user_version = ' + CLINICAL_DB_VERSION);
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

function parsePmdaOutput(stdout: string): PmdaReport {
  const end = stdout.lastIndexOf('\n出力:');
  if (end < 0) throw new Error('PMDA生成ツールから取込結果を取得できません。');
  const result = JSON.parse(stdout.slice(0, end).trim()) as PmdaReport;
  if (!result.imported_documents) throw new Error('PMDAの有効な電子添文がありません。');
  return result;
}

export function setup(options: Options) {
  const mastersDir = join(options.input, 'masters');
  const pmdaDir = join(options.input, 'pmda/SGML_XML');
  const masterNames = officialMasters(mastersDir);
  if (!existsSync(pmdaDir) || !statSync(pmdaDir).isDirectory()) {
    throw new Error('PMDA XMLを ' + pmdaDir + ' に配置してください。');
  }
  if (existsSync(options.db) || existsSync(options.pmdaDb)) {
    throw new Error('既存DBの上書きは禁止です。両方の出力先が存在しないことを確認してください。');
  }
  const interpreter = findPython();
  mkdirSync(dirname(options.db), { recursive: true });
  mkdirSync(dirname(options.pmdaDb), { recursive: true });
  const clinicalStageDir = mkdtempSync(join(dirname(options.db), '.dencal-setup-'));
  const pmdaStageDir = mkdtempSync(join(dirname(options.pmdaDb), '.pmda-setup-'));
  const clinicalStage = join(clinicalStageDir, 'dencal.sqlite3');
  const pmdaStage = join(pmdaStageDir, 'pmda-safety.sqlite3');
  let createdClinical = false;
  let createdPmda = false;
  try {
    const credentials = python(interpreter, join(root, 'database/init.py'), [clinicalStage]);
    const masterResults: MasterReport[] = [];
    const db = new DatabaseSync(clinicalStage);
    try {
      upgrade(db);
      for (const filename of masterNames) {
        const file = join(mastersDir, filename);
        if (!statSync(file).isFile()) throw new Error('マスターファイルではありません: ' + file);
        const data = parseOfficialCatalogFile(filename, readFileSync(file));
        const result = saveCatalog(db, data);
        masterResults.push({ file: filename, kind: data.kind, release: data.releaseDate, count: result.count });
      }
      if (db.prepare('PRAGMA integrity_check').get()?.integrity_check !== 'ok' ||
          db.prepare('PRAGMA user_version').get()?.user_version !== CLINICAL_DB_VERSION) {
        throw new Error('診療DBの整合性確認に失敗しました。');
      }
    } finally {
      db.close();
    }
    const pmda = parsePmdaOutput(python(interpreter, join(root, 'tools/import_pmda.py'), [
      pmdaDir, '--output', pmdaStage,
    ]));
    // Exclusive hard links prevent overwriting databases created by another process.
    try {
      linkSync(clinicalStage, options.db);
      createdClinical = true;
      linkSync(pmdaStage, options.pmdaDb);
      createdPmda = true;
    } catch (error) {
      if (createdPmda) unlinkSync(options.pmdaDb);
      if (createdClinical) unlinkSync(options.db);
      throw error;
    }
    const report = {
      completedAt: new Date().toISOString(), masters: masterResults, pmda,
      clinicalDatabase: options.db, safetyDatabase: options.pmdaDb,
    };
    const reportPath = join(dirname(options.db), 'initial-setup-report.json');
    try {
      writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
    } catch (error) {
      console.warn('取込レポートの保存に失敗しました:', error);
    }
    console.log('DB初期セットアップ完了');
    for (const item of masterResults) console.log('  ' + item.file + ': ' + item.count.toLocaleString() + '件');
    console.log('  PMDA XML: ' + pmda.imported_documents.toLocaleString() + '/' +
      pmda.xml_files.toLocaleString() + '文書、エラー ' + pmda.errors.length.toLocaleString() + '件');
    if (pmda.errors.length) console.warn('PMDA取込エラーの詳細は initial-setup-report.json を確認してください。');
    console.log('診療DB: ' + options.db + '\n安全性DB: ' + options.pmdaDb);
    // Passwords are printed only after BOTH database files have been generated successfully.
    console.log(credentials.trim());
    return report;
  } finally {
    rmSync(clinicalStageDir, { recursive: true, force: true });
    rmSync(pmdaStageDir, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    setup(args());
  } catch (error) {
    console.error('初期セットアップ失敗: ' + (error instanceof Error ? error.message : String(error)));
    process.exitCode = 1;
  }
}
