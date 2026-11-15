import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export type DrugSafetySection = { section: string; body: string };
export type DrugSafetyDocument = {
  documentId: string; sourceFile: string; title: string; productName: string;
  revision: string; companyId: string; sha256: string; importedAt: string;
  sections: DrugSafetySection[];
};
export type DrugSafetyResult = {
  status: 'no_code' | 'not_imported' | 'not_found' | 'matched' | 'unavailable';
  yjCode: string;
  documents: DrugSafetyDocument[];
};

export function readDrugSafety(yjInput: string | null): DrugSafetyResult {
  const yjCode = (yjInput ?? '').trim().toUpperCase();
  const empty = (status: DrugSafetyResult['status']): DrugSafetyResult => ({ status, yjCode, documents: [] });
  if (!/^[0-9A-Z]{12}$/.test(yjCode)) return empty('no_code');
  const path = resolve(process.env.DENCAL_PMDA_DB || 'data/pmda-safety.sqlite3');
  if (!existsSync(path)) return empty('not_imported');
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(path, { readOnly: true });
    if (db.prepare('PRAGMA user_version').get()?.user_version !== 1) return empty('unavailable');
    const results = db.prepare(`
      SELECT d.document_id AS documentId, d.source_file AS sourceFile, d.title,
             d.company_id AS companyId, d.revision, d.sha256, d.imported_at AS importedAt,
             p.name AS productName
      FROM document_products p JOIN source_documents d ON p.document_id = d.document_id
      WHERE p.yj_code = ?
      ORDER BY d.revision DESC, d.document_id LIMIT 20
    `).all(yjCode) as Omit<DrugSafetyDocument, 'sections'>[];
    if (!results.length) return empty('not_found');
    const sections = db.prepare('SELECT section, body FROM safety_sections WHERE document_id = ?');
    return {
      status: 'matched',
      yjCode,
      documents: results.map((row) => ({
        ...row, sections: sections.all(row.documentId) as DrugSafetySection[],
      })),
    };
  } catch {
    // A corrupt/mismatched local safety DB must never be treated as a negative safety result.
    return empty('unavailable');
  } finally {
    db?.close();
  }
}
