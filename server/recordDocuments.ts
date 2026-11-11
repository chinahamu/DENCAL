import type { DatabaseSync, SQLOutputValue } from 'node:sqlite';
import { CLINIC_INFO } from '../src/data/seedData';
import type { FinalizedRecordDocument, FinalizedRecordPage, FinalizedRecordResult } from '../src/types/records';
import { calendarDate, ClinicalError } from './clinicalInput';
import type { Actor, Chart } from './clinicalStore';

const PAGE_SIZE = 30;

export function searchFinalizedRecords(db: DatabaseSync, actor: Actor, params: URLSearchParams): FinalizedRecordPage {
  const query = (params.get('q') ?? '').trim();
  const start = params.get('from');
  const end = params.get('to');
  const from = start ? calendarDate(start) : '';
  const to = end ? calendarDate(end) : '';
  const page = Number(params.get('page') ?? '1');
  if (query.length > 100 || (from && to && from > to) || !Number.isSafeInteger(page) || page < 1 ||
      page > Math.floor(Number.MAX_SAFE_INTEGER / PAGE_SIZE)) {
    throw new ClinicalError(400, 'invalid_input');
  }

  const term = query.replace(/[ 　]/g, '').toLowerCase();
  const results = db.prepare(`
    SELECT e.id AS encounterId, r.revision, p.patient_number AS patientId, p.name AS patientName,
      coalesce(p.name_kana, '') AS patientKana, e.reception_date AS visitDate, r.finalized_at AS finalizedAt
    FROM clinical_note_revisions r
    JOIN clinical_workspaces w ON w.encounter_id = r.encounter_id
    JOIN encounters e ON e.id = w.encounter_id JOIN patients p ON p.id = e.patient_id
    JOIN departments d ON d.id = e.department_id
    WHERE (? = 1 OR d.code = ?)
      AND (? = '' OR instr(lower(p.patient_number), ?) > 0
        OR instr(replace(replace(lower(p.name), ' ', ''), '　', ''), ?) > 0
        OR instr(replace(replace(lower(coalesce(p.name_kana, '')), ' ', ''), '　', ''), ?) > 0)
      AND (? = '' OR e.reception_date >= ?) AND (? = '' OR e.reception_date <= ?)
    ORDER BY e.reception_date DESC, e.id DESC, r.revision DESC
    LIMIT ? OFFSET ?
  `).all(Number(actor.role === 'admin'), actor.departmentCode, term, term, term, term, from, from, to, to,
    PAGE_SIZE + 1, (page - 1) * PAGE_SIZE) as (Record<string, SQLOutputValue> & FinalizedRecordResult)[];
  return { records: results.slice(0, PAGE_SIZE), hasNext: results.length > PAGE_SIZE };
}

const htmlEntities: Record<string, string> = {
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
};

function escape(value: string | number): string {
  return String(value).replace(/[&<>"']/g, (character) => htmlEntities[character]);
}

function list(items: string[]): string {
  return items.length
    ? `<ul>${items.map((item) => `<li>${escape(item)}</li>`).join('')}</ul>`
    : '<p>なし</p>';
}

export function finalizedRecordDocument(chart: Chart, revisionNumber: number): FinalizedRecordDocument {
  const { row, patient } = chart;
  const revision = patient.revisions.find((entry) => entry.revisionNumber === revisionNumber);
  if (!revision) throw new ClinicalError(404, 'not_found');
  const reference = (item: { master?: { code: string; releaseDate: string } }) => item.master
    ? `（マスター ${item.master.code}／${item.master.releaseDate}版）` : '';
  const diagnoses = revision.diseases?.map((item) => `${item.name}${item.icd10Code ? `（${item.icd10Code}）` : ''}${reference(item)}`);
  const prescriptions = revision.prescriptions.map((item) =>
    `${item.drugName} · ${item.dosagePerDay} · ${item.usage} · ${item.days}日分${reference(item)}`);
  const orders = revision.labOrders.map((item) => `${item.name}（${item.code}）${reference(item)}`);
  const soapSections = [
    ['S 主観的情報', revision.soap.subjective], ['O 客観的情報', revision.soap.objective],
    ['A 評価', revision.soap.assessment], ['P 計画', revision.soap.plan],
  ];
  const metadata = [
    ['医療機関', CLINIC_INFO.name], ['患者番号', patient.id], ['患者氏名', `${patient.kanjiName}（${patient.kanaName}）`],
    ['生年月日', patient.birthDate], ['受診日', row.reception_date], ['受診番号', row.encounter_id],
    ['確定日時（日本時間）', revision.timestamp], ['確定者', `${revision.authorName}（${revision.authorId}）`],
    ...(revision.enteredByName ? [['最終入力', `${revision.enteredByName} · ${revision.enteredAt ?? ''}`]] : []),
    ...(revision.reasonForRevision ? [['訂正理由', revision.reasonForRevision]] : []),
  ];
  const title = `診療録 第${revisionNumber}版`;
  const html = `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'">
<title>${escape(title)}</title>
<style>
  @page { size: A4; margin: 15mm; }
  * { box-sizing: border-box; }
  body { max-width: 52rem; margin: 1.5rem auto; padding: 0 1rem; color: #111827; font: 1rem/1.65 system-ui, sans-serif; overflow-wrap: anywhere; }
  h1 { margin: 0; font-size: 1.6rem; }
  h2 { font-size: 1.1rem; border-bottom: 1px solid #777; break-after: avoid; }
  dl { display: grid; grid-template-columns: max-content 1fr; gap: .25rem 1rem; }
  dt { font-weight: bold; }
  dd { margin: 0; white-space: pre-wrap; }
  .note { white-space: pre-wrap; }
  footer { border-top: 1px solid #777; margin-top: 2rem; padding-top: .5rem; font-size: .8rem; }
  @media print { body { margin: 0; padding: 0; font-size: 10pt; } p, li { orphans: 3; widows: 3; } }
</style>
</head>
<body>
<main>
  <h1>${escape(title)}</h1>
  <p>確定済み · DENCAL試作環境</p>
  <dl>${metadata.map(([label, value]) => `<dt>${escape(label)}</dt><dd>${escape(value)}</dd>`).join('')}</dl>
  ${soapSections.map(([heading, value]) => `<section><h2>${escape(heading)}</h2><p class="note">${escape(value || '記載なし')}</p></section>`).join('\n')}
  <section><h2>傷病名</h2>${diagnoses ? list(diagnoses) : '<p>この版の記録なし</p>'}</section>
  <section><h2>処方</h2>${list(prescriptions)}</section>
  <section><h2>検査オーダ</h2>${list(orders)}</section>
</main>
<footer>
  <p>確定版 SHA-256 <code>${escape(revision.sha256Hash)}</code></p>
  ${revision.previousHash ? `<p>前版 SHA-256 <code>${escape(revision.previousHash)}</code></p>` : ''}
</footer>
</body>
</html>
`;
  return { filename: `dencal-record-${row.encounter_id}-v${revisionNumber}.html`, html };
}
