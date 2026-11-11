import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { IncomingMessage } from 'node:http';
import type { DatabaseSync } from 'node:sqlite';
import { calendarDate } from './clinicalInput';
import { catalogKinds, masterUploadLimit, type CatalogKind } from '../src/types/catalog';

const source = 'MHLW-RECEIPT';
// RECEPT's supported fixed-point outpatient categories in v1.
const billingCategories = new Set(['110', '120', '122', '123', '124', '125', '130', '140', '210',
  '230', '240', '250', '260', '270', '300', '311', '321', '331', '400', '600', '700', '800']);
const formats = {
  b: { kind: 'diagnosis', columns: 46, code: /^\d{7}$/, extension: 'txt' },
  y: { kind: 'drug', columns: 42, code: /^6\d{8}$/, extension: 'csv' },
  s: { kind: 'procedure', columns: 150, code: /^1\d{8}$/, extension: 'csv' },
} as const;

export class CatalogError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

function normal(text: string) {
  return text.normalize('NFKC').toLowerCase().trim();
}

function date(value: string) {
  if (!value || /^0+$/.test(value) || value === '99999999') return '';
  const iso = value.replace(/^(\d{4})(\d{2})(\d{2})$/, '$1-$2-$3');
  const parsed = new Date(iso);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso) || !Number.isFinite(parsed.getTime()) ||
      parsed.toISOString().slice(0, 10) !== iso) throw new Error('date');
  return iso;
}

function todayJst() {
  return new Date(Date.now() + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

function parseRow(kind: CatalogKind, fields: string[]) {
  const [change, , code] = fields;
  const active = change !== '1';
  let name = '';
  let kana = '';
  let icd10 = '';
  let unit = '';
  let drugForm = '';
  let priceCode = '';
  let effectiveFrom = '';
  let effectiveUntil = '';
  let selectable = false;
  let performanceSelectable = false;
  if (kind === 'diagnosis') {
    name = fields[5].trim() || fields[7].trim();
    kana = fields[9];
    icd10 = fields.slice(15, 17).map((field) => field.trim()).filter(Boolean).join(' / ');
    effectiveFrom = [date(fields[21]), date(fields[22])].sort().at(-1)!;
    effectiveUntil = date(fields[23]);
    selectable = active && change !== '9' && code !== '0000999' && fields[18] === '00';
  } else if (kind === 'drug') {
    name = fields[34].trim() || fields[4].trim();
    kana = fields[6];
    unit = fields[9].trim();
    drugForm = fields[27];
    priceCode = fields[31].trim();
    effectiveFrom = [date(fields[29]), date(fields[35])].sort().at(-1)!;
    effectiveUntil = [date(fields[30]), date(fields[33])].filter(Boolean).sort()[0] ?? '';
    selectable = active && ['1', '6'].includes(drugForm);
  } else {
    name = fields[112].trim() || fields[4].trim();
    kana = fields[6];
    effectiveFrom = date(fields[86]);
    effectiveUntil = date(fields[87]);
    unit = fields[9].trim();
    selectable = active && fields[12] !== '1' && fields[14] === '600';
    const points = Number(fields[11]);
    performanceSelectable = active && change !== '9' && billingCategories.has(fields[14]) &&
      fields[10] === '3' && fields[12] !== '1' && fields[15] === '0' && fields[29] === '0' &&
      Number.isFinite(points) && points > 0 && points <= 100_000;
  }
  if (!name) throw new Error('name');
  const searchText = normal([code, name, kana, icd10, priceCode].join(' '));
  // Some discontinued rows have a change date later than their last usable date.
  if (effectiveUntil && effectiveFrom > effectiveUntil) {
    selectable = false;
    performanceSelectable = false;
    effectiveFrom = '';
  }
  return { code, name, searchText, icd10, unit, drugForm, priceCode, effectiveFrom, effectiveUntil, selectable, performanceSelectable };
}

function parseCatalog(format: typeof formats[keyof typeof formats], marker: string, bytes: Buffer) {
  let decoded: string;
  try {
    try { decoded = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
    catch { decoded = new TextDecoder('shift_jis', { fatal: true }).decode(bytes); }
  } catch {
    throw new CatalogError(400, 'Shift_JIS系またはUTF-8の公式ファイルを選んでください。');
  }
  const rows = [];
  const codes = new Set<string>();
  const fieldsPattern = /(?:"((?:[^"]|"")*)"|([^",]*))(,|$)/gy;
  for (const [index, line] of decoded.replace(/\r?\n$/, '').split(/\r\n|\n|\r/).entries()) {
    fieldsPattern.lastIndex = 0;
    const fields: string[] = [];
    let field: RegExpExecArray | null;
    while ((field = fieldsPattern.exec(line))) {
      fields.push(field[1] === undefined ? field[2] : field[1].replaceAll('""', '"'));
      if (!field[3]) break;
    }
    try {
      if (!field || fields.length !== format.columns || !/^[012359]$/.test(fields[0]) ||
          fields[1] !== marker || !format.code.test(fields[2]) || codes.has(fields[2]) ||
          line.includes('\0')) throw new Error('layout');
      rows.push(parseRow(format.kind, fields));
      codes.add(fields[2]);
    } catch {
      throw new CatalogError(400, `${index + 1}行目を読み込めません。公式の全件マスターのファイル形式を確認してください。`);
    }
  }
  return rows;
}

export async function receiveCatalog(req: IncomingMessage, params: URLSearchParams) {
  if (req.headers['content-type'] !== 'application/octet-stream') {
    throw new CatalogError(415, '解凍したCSVまたはTXTを選んでください。');
  }
  const filename = params.get('filename') ?? '';
  const match = /^([bys])_(\d{8})\.(csv|txt)$/.exec(filename);
  if (!match || match[0] !== filename) throw new CatalogError(400, '公式の全件マスターを元のファイル名で選んでください。');
  const format = formats[match[1] as keyof typeof formats];
  let releaseDate: string;
  try { releaseDate = date(match[2]); }
  catch { throw new CatalogError(400, 'ファイル名の日付が不正です。'); }
  if (!releaseDate || match[3] !== format.extension) throw new CatalogError(400, '対象の公式ファイルを選んでください。');

  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req.iterator({ destroyOnReturn: false })) {
    size += chunk.length;
    if (size > masterUploadLimit) {
      req.resume();
      throw new CatalogError(413, 'ファイルは20 MiBまで取り込めます。');
    }
    chunks.push(chunk);
  }
  const bytes = Buffer.concat(chunks);
  const rows = parseCatalog(format, match[1].toUpperCase(), bytes);
  return { kind: format.kind, releaseDate, sha256: createHash('sha256').update(bytes).digest('hex'), rows };
}

export function saveCatalog(db: DatabaseSync, input: Awaited<ReturnType<typeof receiveCatalog>>) {
  const { kind, releaseDate, sha256, rows } = input;
  const releaseCode = `${releaseDate}-${sha256}`;
  db.exec('BEGIN IMMEDIATE');
  try {
    db.exec(readFileSync(new URL('../database/catalog-details.sql', import.meta.url), 'utf8'));
    const release = db.prepare(`
      INSERT INTO master_releases (kind, source, release_code, effective_from, imported_at, file_sha256)
      VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(kind, source, release_code) DO NOTHING
    `).run(kind, source, releaseCode, releaseDate, new Date().toISOString(), sha256);
    if (release.changes) {
      const insert = db.prepare(`
        INSERT INTO master_items (kind, release_id, code_system, code, name, effective_from, effective_until)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `);
      const details = db.prepare(`INSERT INTO master_item_catalog_details
        (item_id, search_text, icd10, unit, drug_form, price_code, selectable, performance_selectable)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
      for (const row of rows) {
        const id = insert.run(kind, release.lastInsertRowid, 'レセ電算', row.code, row.name,
          row.effectiveFrom || '0001-01-01', row.effectiveUntil || null).lastInsertRowid;
        details.run(id, row.searchText, row.icd10, row.unit, row.drugForm, row.priceCode, Number(row.selectable), Number(row.performanceSelectable));
      }
    }
    if (!release.changes && kind === 'procedure') {
      const refresh = db.prepare(`
        UPDATE master_item_catalog_details SET performance_selectable = ?, unit = ?
        WHERE performance_selectable IS NULL AND item_id = (
          SELECT i.id FROM master_items i JOIN master_releases r ON r.id = i.release_id
          WHERE r.kind = ? AND r.source = ? AND r.release_code = ? AND i.code = ?
        )
      `);
      for (const row of rows) refresh.run(Number(row.performanceSelectable), row.unit, kind, source, releaseCode, row.code);
    }
    db.exec('COMMIT');
    return { kind, count: rows.length, duplicate: !release.changes };
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

export function listCatalogs(db: DatabaseSync) {
  return db.prepare(`
    SELECT r.kind, r.effective_from AS releaseDate, r.imported_at AS importedAt, r.file_sha256 AS sha256,
      (SELECT count(*) FROM master_items WHERE release_id = r.id) AS count
    FROM master_releases r WHERE r.source = ? ORDER BY r.effective_from DESC, r.id DESC
  `).all(source);
}

export function searchCatalog(db: DatabaseSync, params: URLSearchParams) {
  const kind = params.get('kind') ?? '';
  const query = normal(params.get('q') ?? '');
  if (!Object.hasOwn(catalogKinds, kind) || query.length > 120) throw new CatalogError(400, '検索条件を確認してください。');
  const performance = kind === 'procedure' && params.get('use') === 'performance';
  const now = performance ? calendarDate(params.get('on')) : todayJst();
  const release = db.prepare(`
    SELECT id, effective_from FROM master_releases WHERE kind = ? AND source = ? AND effective_from <= ?
    ORDER BY effective_from DESC, id DESC LIMIT 1
  `).get(kind, source, now);
  if (!release) return { ready: false, entries: [] };
  return {
    ready: true,
    entries: db.prepare(`
      SELECT i.id, i.code, i.name, ? AS releaseDate, d.icd10, d.unit, d.drug_form AS drugForm, d.price_code AS priceCode
      FROM master_items i JOIN master_item_catalog_details d ON d.item_id = i.id
      WHERE i.release_id = ? AND ${performance ? 'd.performance_selectable' : 'd.selectable'} = 1 AND i.effective_from <= ?
        AND (i.effective_until IS NULL OR i.effective_until >= ?) AND instr(d.search_text, ?) > 0
      ORDER BY (i.code = ?) DESC, i.code LIMIT 40
    `).all(release.effective_from, release.id, now, now, query, query),
  };
}

export function performanceMaster(db: DatabaseSync, id: number, on: string) {
  return db.prepare(`
    SELECT i.id, i.code, i.name, d.unit
    FROM master_items i JOIN master_item_catalog_details d ON d.item_id = i.id
    WHERE i.id = ? AND d.performance_selectable = 1 AND i.effective_from <= ?
      AND (i.effective_until IS NULL OR i.effective_until >= ?)
      AND i.release_id = (SELECT r.id FROM master_releases r
        WHERE r.kind = 'procedure' AND r.source = ? AND r.effective_from <= ?
        ORDER BY r.effective_from DESC, r.id DESC LIMIT 1)
  `).get(id, on, on, source, on);
}
