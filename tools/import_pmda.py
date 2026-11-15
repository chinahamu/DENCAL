#!/usr/bin/env python3
"""Create a local-only PMDA electronic package-insert reference database from extracted XML."""
import argparse
from datetime import datetime, timezone
from hashlib import sha256
import json
import os
from pathlib import Path
import re
import sqlite3
import tempfile
import xml.etree.ElementTree as ET

NS = '{http://info.pmda.go.jp/namespace/prescription_drugs/package_insert/1.0}'
XML_LANG = '{http://www.w3.org/XML/1998/namespace}lang'
SECTIONS = {
    'contraindications': 'ContraIndications',
    'combination_ban': 'ContraIndicatedCombinations',
    'combination_caution': 'PrecautionsForCombinations',
    'serious_adverse': 'SeriousAdverseEvents',
    'other_adverse': 'OtherAdverseEvents',
    'patient_cautions': 'UseInSpecificPopulations',
    'important_cautions': 'ImportantPrecautions',
    'dosage_cautions': 'InfoPrecautionsDosage',
}
SCHEMA = """
PRAGMA foreign_keys = ON;
PRAGMA user_version = 1;
CREATE TABLE source_documents (
 document_id TEXT PRIMARY KEY, source_file TEXT NOT NULL, title TEXT NOT NULL,
 company_id TEXT, revision TEXT NOT NULL, sha256 TEXT NOT NULL, imported_at TEXT NOT NULL
);
CREATE TABLE document_products (
 document_id TEXT NOT NULL REFERENCES source_documents(document_id),
 yj_code TEXT NOT NULL, name TEXT NOT NULL, PRIMARY KEY(document_id,yj_code)
);
CREATE INDEX document_products_yj ON document_products(yj_code);
CREATE TABLE safety_sections (
 document_id TEXT NOT NULL REFERENCES source_documents(document_id),
 section TEXT NOT NULL, body TEXT NOT NULL, PRIMARY KEY(document_id,section)
);
"""

def text_of(node):
    return re.sub(r'\s+', ' ', ''.join(node.itertext())).strip() if node is not None else ''

def localized(node):
    if node is None:
        return ''
    parts = [text_of(el) for el in node.iter(NS + 'Lang') if el.attrib.get(XML_LANG, 'ja') == 'ja']
    return ' / '.join(p for p in parts if p)

def generic_lines(node):
    # Maintain original list/table cell boundaries instead of joining unrelated statements.
    return '\n'.join(text_of(el) for el in node.iter(NS + 'Lang')
                     if el.attrib.get(XML_LANG, 'ja') == 'ja' and text_of(el))

def interaction_lines(node):
    parts = []
    for combination in node.iter():
        if combination.tag not in {NS + 'ContraIndicatedCombination', NS + 'PrecautionsForCombination'}:
            continue
        for drug in combination.iter(NS + 'Drug'):
            entry = []
            for tag, label in [('DrugName', '相手薬剤・薬剤群'), ('ClinSymptomsAndMeasures', '症状・措置'),
                               ('MechanismAndRiskFactors', '機序・危険因子')]:
                field = drug.find(NS + tag)
                value = generic_lines(field) if field is not None else ''
                if value:
                    entry.append(label + ': ' + value.replace('\n', ' / '))
            if entry:
                parts.append('\n'.join(entry))
    return '\n\n'.join(parts) if parts else generic_lines(node)

def adverse_lines(node):
    # Resolve frequencyRef and categoryRef; never display an unpaired frequency.
    rows = []
    for other in node.iter(NS + 'OtherAdverse'):
        labels = {}
        for parent in ('CategoryDefinition', 'FrequencyDefinition'):
            definition = other.find(NS + parent)
            if definition is not None:
                for item in definition:
                    if item.get('id'):
                        labels[item.get('id')] = localized(item) or text_of(item)
        for item in other.iter(NS + 'AdverseReactionDescription'):
            value = localized(item) or text_of(item)
            if not value:
                continue
            category = labels.get(item.get('categoryRef'), '区分未特定')
            frequency = labels.get(item.get('frequencyRef'), '頻度未特定')
            rows.append(f'{category} / {frequency}: {value}')
    if rows:
        notes = []
        for el in node.iter(NS + 'ExplanatoryNotesForOtherAdverse'):
            value = localized(el) or text_of(el)
            if value:
                notes.append('注記: ' + value)
        return '\n'.join(rows + notes)
    return generic_lines(node)

def parse_xml(raw, label):
    if len(raw) > 8 * 1024 * 1024 or b'<!doctype' in raw.lower() or b'<!entity' in raw.lower():
        raise ValueError('XML size or DTD is not supported')
    root = ET.fromstring(raw)
    if root.tag != NS + 'PackIns':
        raise ValueError('not a PMDA prescription-drug XML document')
    document_id = root.findtext(NS + 'PackageInsertNo', default='').strip()
    if not re.fullmatch(r'[\w-]{5,100}', document_id, flags=re.ASCII):
        raise ValueError('missing or invalid document identifier')
    approval = root.find(NS + 'ApprovalEtc')
    if approval is None:
        raise ValueError('no approval metadata')
    products = {}
    for brand in approval.findall(NS + 'DetailBrandName'):
        yj = brand.findtext(NS + 'BrandCode/' + NS + 'YJCode', default='').strip().upper()
        title = localized(brand.find(NS + 'ApprovalBrandName'))
        if re.fullmatch(r'[A-Z0-9]{12}', yj) and title:
            products[yj] = title
    if not products:
        raise ValueError('no explicit YJ code and drug name pair')
    revisions = [x.text.strip() for x in root.findall(NS + 'DateOfPreparationOrRevision/' + NS + 'PreparationOrRevision/' + NS + 'YearMonth') if x.text]
    revision = max((v for v in revisions if re.fullmatch(r'\d{4}-\d{2}', v)), default='不明')
    sections = {}
    for key, tag in SECTIONS.items():
        elements = list(root.iter(NS + tag))
        if not elements:
            continue
        blocks = []
        for el in elements:
            body = (interaction_lines(el) if key in ('combination_ban', 'combination_caution')
                    else adverse_lines(el) if key == 'other_adverse' else generic_lines(el))
            if body:
                blocks.append(body)
        if blocks:
            sections[key] = '\n\n'.join(blocks)
    return {
        'id': document_id, 'title': next(iter(products.values())),
        'company': root.findtext(NS + 'CompanyIdentifier', default=''),
        'revision': revision, 'products': products, 'sections': sections,
        'sha256': sha256(raw).hexdigest(), 'source_file': label,
    }

def build(source, output):
    if not source.is_dir():
        raise ValueError('source directory does not exist')
    files = sorted(p for p in source.rglob('*') if p.is_file() and not p.is_symlink() and p.suffix.lower() == '.xml')
    if not files:
        raise ValueError('no XML files found: extract SGML_XML to a local directory first')
    output.parent.mkdir(parents=True, exist_ok=True)
    fd, temp = tempfile.mkstemp(prefix='.pmda-', suffix='.sqlite3', dir=output.parent)
    os.close(fd)
    report = {'xml_files': len(files), 'imported_documents': 0, 'products': 0, 'sections': 0, 'errors': []}
    seen = set()
    try:
        con = sqlite3.connect(temp)
        try:
            con.executescript(SCHEMA)
            stamp = datetime.now(timezone.utc).isoformat()
            with con:
                for file in files:
                    name = file.relative_to(source).as_posix()
                    try:
                        record = parse_xml(file.read_bytes(), name)
                        if record['id'] in seen:
                            raise ValueError('duplicate document ID')
                        seen.add(record['id'])
                        con.execute('INSERT INTO source_documents VALUES (?,?,?,?,?,?,?)',
                                    (record['id'], name, record['title'], record['company'], record['revision'], record['sha256'], stamp))
                        for yj, brand in record['products'].items():
                            con.execute('INSERT INTO document_products VALUES (?,?,?)', (record['id'], yj, brand))
                        for key, body in record['sections'].items():
                            con.execute('INSERT INTO safety_sections VALUES (?,?,?)', (record['id'], key, body))
                        report['imported_documents'] += 1
                        report['products'] += len(record['products'])
                        report['sections'] += len(record['sections'])
                    except (ET.ParseError, ValueError, OSError, sqlite3.Error) as error:
                        report['errors'].append({'file': name, 'reason': str(error)[:200]})
            if not report['imported_documents']:
                raise ValueError('no valid XML documents; existing DB remains unchanged')
            if con.execute('PRAGMA integrity_check').fetchone()[0] != 'ok':
                raise ValueError('generated database failed integrity check')
        finally:
            con.close()
        os.chmod(temp, 0o600)
        os.replace(temp, output)
    finally:
        if os.path.exists(temp):
            os.unlink(temp)
    return report

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('source', type=Path, help='unpacked PMDA SGML_XML folder (local path)')
    parser.add_argument('--output', type=Path, default=Path('data/pmda-safety.sqlite3'))
    args = parser.parse_args()
    if args.output.suffix != '.sqlite3':
        parser.error('--output must end with .sqlite3')
    try:
        result = build(args.source, args.output)
    except (OSError, ValueError) as exc:
        parser.exit(1, f'取り込み失敗: {exc}\n')
    print(json.dumps(result, ensure_ascii=False, indent=2))
    print('出力:', args.output)

if __name__ == '__main__':
    main()
