import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';

const setupScript = fileURLToPath(new URL('./setup.ts', import.meta.url));
const root = fileURLToPath(new URL('../', import.meta.url));
const ns = 'http://info.pmda.go.jp/namespace/prescription_drugs/package_insert/1.0';

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'dencal-setup-test-'));
  const input = join(directory, 'input');
  const masters = join(input, 'masters');
  const pmda = join(input, 'pmda', 'SGML_XML', 'テスト錠');
  mkdirSync(masters, { recursive: true });
  mkdirSync(pmda, { recursive: true });
  const row = (columns: number, code: string, kind: string) => {
    const fields = Array<string>(columns).fill('');
    fields[0] = '0';
    fields[1] = kind;
    fields[2] = code;
    fields[9] = '錠';
    if (kind === 'B') {
      fields[5] = 'テスト傷病'; fields[18] = '00'; fields[21] = '20261101';
    } else if (kind === 'Y') {
      fields[34] = 'テスト錠'; fields[27] = '1'; fields[29] = '20261101'; fields[31] = '1234567A9012';
    } else {
      fields[112] = 'テスト検査'; fields[86] = '20261101';
      fields[10] = '3'; fields[11] = '100'; fields[12] = '0';
      fields[14] = '600'; fields[15] = '0'; fields[29] = '0';
    }
    return fields.map(value => '"' + value.replaceAll('"', '""') + '"').join(',') + '\r\n';
  };
  writeFileSync(join(masters, 'b_20261101.txt'), row(46, '1234567', 'B'));
  writeFileSync(join(masters, 'y_20261101.csv'), row(42, '612345678', 'Y'));
  writeFileSync(join(masters, 's_20261101.csv'), row(150, '112345678', 'S'));
  writeFileSync(join(pmda, '1234567A9012_1_01.xml'), `<?xml version="1.0"?>
<PackIns xmlns="${ns}"><PackageInsertNo>1234567A9012_1_01</PackageInsertNo>
<DateOfPreparationOrRevision><PreparationOrRevision><YearMonth>2026-11</YearMonth></PreparationOrRevision></DateOfPreparationOrRevision>
<ApprovalEtc><DetailBrandName><ApprovalBrandName><Lang xml:lang="ja">テスト錠</Lang></ApprovalBrandName>
<BrandCode><YJCode>1234567A9012</YJCode></BrandCode></DetailBrandName></ApprovalEtc>
<ContraIndications><OrderedList><Item><Detail><Lang xml:lang="ja">テスト用の架空情報</Lang></Detail></Item></OrderedList></ContraIndications>
</PackIns>`);
  return { directory, input, masters, pmda, clinical: join(directory, 'clinical.sqlite3'), safety: join(directory, 'safety.sqlite3') };
}

function run(f: ReturnType<typeof fixture>) {
  return spawnSync(process.execPath, [
    '--import', 'tsx', setupScript, '--input', f.input, '--db', f.clinical, '--pmda-db', f.safety,
  ], { cwd: root, encoding: 'utf8', timeout: 120000, maxBuffer: 8 * 1024 * 1024 });
}

test('one command creates schema v7, all three masters, and PMDA safety DB', (t) => {
  const f = fixture();
  t.after(() => rmSync(f.directory, { recursive: true, force: true }));
  const first = run(f);
  assert.equal(first.status, 0, first.stderr || first.stdout);
  assert.ok(existsSync(f.clinical));
  assert.ok(existsSync(f.safety));
  const db = new DatabaseSync(f.clinical, { readOnly: true });
  try {
    assert.equal(db.prepare('PRAGMA user_version').get()?.user_version, 7);
    const kinds = db.prepare('SELECT kind, COUNT(*) AS n FROM master_items GROUP BY kind ORDER BY kind')
      .all().map(row => [row.kind, row.n]);
    assert.deepEqual(kinds, [['diagnosis', 1], ['drug', 1], ['procedure', 1]]);
    assert.equal(db.prepare('SELECT price_code FROM master_item_catalog_details WHERE price_code <> ?').get('')?.price_code, '1234567A9012');
    assert.equal(db.prepare('SELECT performance_selectable FROM master_item_catalog_details WHERE performance_selectable = 1').get()?.performance_selectable, 1);
  } finally {
    db.close();
  }
  const safety = new DatabaseSync(f.safety, { readOnly: true });
  try {
    assert.equal(safety.prepare('SELECT COUNT(*) AS n FROM document_products').get()?.n, 1);
    assert.match(String(safety.prepare('SELECT body FROM safety_sections').get()?.body), /架空情報/);
  } finally {
    safety.close();
  }
  const repeat = run(f);
  assert.notEqual(repeat.status, 0);
  assert.match(repeat.stderr, /既存DBの上書きは禁止/);
});

test('missing master or invalid master never produces a partial database', (t) => {
  const f = fixture();
  t.after(() => rmSync(f.directory, { recursive: true, force: true }));
  rmSync(join(f.masters, 's_20261101.csv'));
  const missing = run(f);
  assert.notEqual(missing.status, 0);
  assert.equal(existsSync(f.clinical), false);
  assert.equal(existsSync(f.safety), false);
  writeFileSync(join(f.masters, 's_20261101.csv'), 'invalid file');
  const malformed = run(f);
  assert.notEqual(malformed.status, 0);
  assert.equal(existsSync(f.clinical), false);
  assert.equal(existsSync(f.safety), false);
});

test('missing PMDA XML aborts without publishing either database', (t) => {
  const f = fixture();
  t.after(() => rmSync(f.directory, { recursive: true, force: true }));
  rmSync(f.pmda, { recursive: true, force: true });
  const result = run(f);
  assert.notEqual(result.status, 0);
  assert.equal(existsSync(f.clinical), false);
  assert.equal(existsSync(f.safety), false);
});
