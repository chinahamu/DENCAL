import { useEffect, useState } from 'react';
import type { DrugSafetyResult } from '../types/drugSafety';

const SECTIONS = [
  { key: 'contraindications', title: '禁忌（2）' },
  { key: 'combination_ban', title: '併用禁忌（10.1）' },
  { key: 'combination_caution', title: '併用注意（10.2）' },
  { key: 'serious_adverse', title: '重大な副作用（11.1）' },
  { key: 'other_adverse', title: 'その他の副作用（11.2）' },
  { key: 'patient_cautions', title: '特定の背景を有する患者に関する注意（9）' },
  { key: 'important_cautions', title: '重要な基本的注意（8）' },
  { key: 'dosage_cautions', title: '用法用量に関連する注意（7）' },
] as const;

export function DrugSafetyPanel({ yjCode, drugName }: { yjCode?: string; drugName: string }) {
  const [result, setResult] = useState<DrugSafetyResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    setResult(null);
    setError('');
    if (!yjCode) {
      setLoading(false);
      return;
    }
    const controller = new AbortController();
    setLoading(true);
    fetch('/api/drug-safety?' + new URLSearchParams({ yj: yjCode }), { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error('薬剤安全性情報を取得できませんでした。再ログインと接続状態を確認してください。');
        return response.json() as Promise<DrugSafetyResult>;
      })
      .then((value) => { if (!controller.signal.aborted) setResult(value); })
      .catch((cause) => {
        if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : '取得に失敗しました。');
      })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [yjCode]);

  return (
    <section aria-label={drugName + ' の医薬品安全性情報'} className="space-y-2 rounded-md border border-blue-200 bg-blue-50/40 p-3 text-xs">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h4 className="font-bold text-slate-900">医薬品安全性情報（電子添文からの参照表示）</h4>
        <a className="text-blue-800 underline" href="https://www.pmda.go.jp/PmdaSearch/iyakuSearch/" target="_blank" rel="noreferrer">
          PMDAで最新の電子添文を確認
        </a>
      </div>
      <p className="text-slate-700">{drugName} {yjCode ? `（YJ: ${yjCode}）` : ''}</p>
      <p className="text-amber-900">機械抽出した参考情報です。処方の可否・相互作用を自動判定していません。原文の表・脚注・参照関係と最新の電子添文を確認してください。</p>
      {!yjCode && <p role="status" className="text-slate-600">薬価基準収載医薬品コードがないため照合できません（安全性未確認）。</p>}
      {loading && <p role="status">読み込み中…</p>}
      {error && <p role="alert" className="text-red-800">{error}</p>}
      {!loading && result?.status === 'not_imported' && <p role="status" className="text-amber-900">安全性データが未取込です。管理者がPMDA XMLからローカルDBを生成してください。</p>}
      {!loading && result?.status === 'unavailable' && <p role="alert" className="text-red-800">安全性データを読み込めません。DB形式や破損を確認してください。安全性は未確認です。</p>}
      {!loading && result?.status === 'not_found' && <p role="status" className="text-amber-900">このYJコードに対応する電子添文は取り込み済みデータに見つかりません。禁忌がないことを意味しません。</p>}
      {!loading && result?.status === 'no_code' && <p role="status" className="text-amber-900">有効なYJコードではないため照合できません。</p>}
      {result?.status === 'matched' && result.documents.map((doc) => (
        <article key={doc.documentId} className="space-y-2 rounded border border-slate-200 bg-white p-3">
          <div className="space-y-1">
            <h5 className="font-bold text-slate-900">{doc.productName}</h5>
            <p className="text-slate-600">添文ID: {doc.documentId} · 改訂: {doc.revision} · 取込: {new Date(doc.importedAt).toLocaleDateString('ja-JP')}</p>
            <p className="break-all text-slate-500">元ファイル: {doc.sourceFile} · SHA-256: {doc.sha256.slice(0, 16)}…</p>
          </div>
          {SECTIONS.map(({ key, title }) => {
            const section = doc.sections.find((item) => item.section === key);
            return (
              <details key={key} className="rounded border border-slate-200 bg-slate-50" open={key === 'contraindications' || key === 'combination_ban'}>
                <summary className="cursor-pointer select-none p-2 font-semibold text-slate-900">
                  {title} {!section && <span className="font-normal text-slate-500">・抽出データなし</span>}
                </summary>
                <div className="border-t border-slate-200 p-2 text-slate-800">
                  {section
                    ? <p className="whitespace-pre-wrap break-words leading-relaxed">{section.body}</p>
                    : <p className="text-amber-900">XML内に該当する抽出対象データがありません。禁忌・副作用が存在しないという意味ではありません。</p>}
                </div>
              </details>
            );
          })}
        </article>
      ))}
    </section>
  );
}
