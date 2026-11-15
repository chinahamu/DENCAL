import importlib.util
from pathlib import Path
from tempfile import TemporaryDirectory
import sqlite3
import unittest

spec = importlib.util.spec_from_file_location('import_pmda', Path(__file__).with_name('import_pmda.py'))
p = importlib.util.module_from_spec(spec)
spec.loader.exec_module(p)

def example(brand, yj, values=''):
    return f'''<?xml version="1.0" encoding="utf-8"?>
<PackIns xmlns="http://info.pmda.go.jp/namespace/prescription_drugs/package_insert/1.0">
<PackageInsertNo>{yj}_1_01</PackageInsertNo>
<DateOfPreparationOrRevision><PreparationOrRevision><YearMonth>2026-11</YearMonth></PreparationOrRevision></DateOfPreparationOrRevision>
<ApprovalEtc><DetailBrandName><ApprovalBrandName><Lang xml:lang="ja">{brand}</Lang></ApprovalBrandName><BrandCode><YJCode>{yj}</YJCode></BrandCode></DetailBrandName></ApprovalEtc>
{values}</PackIns>'''.encode()

class PmdaTests(unittest.TestCase):
    def test_extraction_and_absent_section(self):
        xml = example('テスト錠', '1234567A9012', '<ContraIndications><OrderedList><Item><Detail><Lang xml:lang="ja">禁忌事項</Lang></Detail></Item></OrderedList></ContraIndications>')
        doc = p.parse_xml(xml, 'x.xml')
        self.assertEqual(doc['products'], {'1234567A9012': 'テスト錠'})
        self.assertEqual(doc['sections']['contraindications'], '禁忌事項')
        self.assertNotIn('combination_ban', doc['sections'])

    def test_malformed_and_external_entities(self):
        with self.assertRaises(ValueError):
            p.parse_xml(b'<!DOCTYPE r [<!ENTITY x SYSTEM "file:///etc/passwd">]><r/>', 'bad.xml')

    def test_atomic_rebuild(self):
        with TemporaryDirectory() as folder:
            source, output = Path(folder) / 'docs', Path(folder) / 'data.sqlite3'
            source.mkdir()
            (source / 'a.xml').write_bytes(example('一錠', '1234567A9012'))
            report = p.build(source, output)
            self.assertEqual(report['products'], 1)
            with sqlite3.connect(output) as db:
                self.assertEqual(db.execute('select count(*) from document_products').fetchone()[0], 1)
            (source / 'a.xml').write_bytes(b'broken')
            with self.assertRaises(ValueError):
                p.build(source, output)
            with sqlite3.connect(output) as db:
                self.assertEqual(db.execute('select count(*) from document_products').fetchone()[0], 1)

if __name__ == '__main__':
    unittest.main()
