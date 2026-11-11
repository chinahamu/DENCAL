import { useEffect, useRef, useState, type FormEvent } from 'react';
import type { FinalizedRecordDocument, FinalizedRecordPage, FinalizedRecordResult } from '../types/records';

interface Props {
  request: <T>(path: string, signal: AbortSignal, body?: unknown) => Promise<T>;
  canExport: boolean;
  download: (filename: string, content: string, type: string) => void;
}

const fieldClass = 'w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm';
const buttonClass = 'rounded-md border border-slate-300 px-3 py-2 text-sm font-semibold text-teal-800 disabled:opacity-45';
const htmlType = 'text/html; charset=utf-8';

function recordPath(record: FinalizedRecordResult) {
  return `records/${record.encounterId}/${record.revision}`;
}

export function FinalizedRecordsView({ request, canExport, download }: Props) {
  const [result, setResult] = useState<FinalizedRecordPage | null>(null);
  const [page, setPage] = useState(1);
  const [filters, setFilters] = useState('');
  const [selected, setSelected] = useState<FinalizedRecordResult | null>(null);
  const [preview, setPreview] = useState<FinalizedRecordDocument | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const activeRequest = useRef<AbortController | null>(null);

  useEffect(() => () => activeRequest.current?.abort(), []);

  async function run(task: (signal: AbortSignal) => Promise<void>) {
    activeRequest.current?.abort();
    const controller = new AbortController();
    activeRequest.current = controller;
    setBusy(true);
    setMessage('');
    try {
      await task(controller.signal);
    } catch (error) {
      if (!controller.signal.aborted) setMessage(error instanceof Error ? error.message : '診療録を取得できませんでした。');
    } finally {
      if (!controller.signal.aborted) setBusy(false);
    }
  }

  function search(query: string, pageNumber: number) {
    void run(async (signal) => {
      const params = new URLSearchParams(query);
      params.set('page', String(pageNumber));
      const next = await request<FinalizedRecordPage>(`records?${params}`, signal);
      if (signal.aborted) return;
      setFilters(query);
      setPage(pageNumber);
      setResult(next);
      setSelected(null);
      setPreview(null);
    });
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const params = new URLSearchParams();
    for (const field of ['q', 'from', 'to']) {
      const value = String(form.get(field) ?? '').trim();
      if (value) params.set(field, value);
    }
    search(params.toString(), 1);
  }

  function openRecord(record: FinalizedRecordResult) {
    setSelected(record);
    setPreview(null);
    void run(async (signal) => {
      const document = await request<FinalizedRecordDocument>(recordPath(record), signal);
      if (!signal.aborted) setPreview(document);
    });
  }

  function exportRecord(record: FinalizedRecordResult, openForPrint: boolean) {
    const tab = openForPrint ? window.open('about:blank', '_blank') : null;
    if (openForPrint && !tab) {
      setMessage('印刷用タブを開けませんでした。HTMLを保存し、ブラウザーで開いて印刷してください。');
      return;
    }
    if (tab) tab.opener = null;
    void run(async (signal) => {
      let opened = false;
      try {
        const { filename, html } = await request<FinalizedRecordDocument>(recordPath(record) + '/export', signal, {});
        if (signal.aborted) return;
        if (tab) {
          if (tab.closed) return;
          const url = URL.createObjectURL(new Blob([html], { type: htmlType }));
          tab.location.replace(url);
          window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
          opened = true;
        } else {
          download(filename, html, htmlType);
        }
      } finally {
        if (tab && !opened) tab.close();
      }
    });
  }

  return (
    <section className="space-y-5" aria-labelledby="finalized-records-title">
      <div className="rounded-lg border border-slate-200 bg-white p-5">
        <h1 id="finalized-records-title" className="text-lg font-bold text-slate-900">確定診療録の検索</h1>
        <form onSubmit={submit} className="mt-4 grid items-end gap-3 sm:grid-cols-[2fr_1fr_1fr_auto]">
          <label className="text-xs font-semibold text-slate-700">
            患者番号・氏名・フリガナ
            <input type="search" name="q" className={fieldClass} maxLength={100} />
          </label>
          <label className="text-xs font-semibold text-slate-700">
            受診日（開始）
            <input type="date" name="from" className={fieldClass} />
          </label>
          <label className="text-xs font-semibold text-slate-700">
            受診日（終了）
            <input type="date" name="to" className={fieldClass} />
          </label>
          <button type="submit" disabled={busy} className="rounded-md bg-teal-800 px-4 py-2 text-sm font-semibold text-white disabled:opacity-45">
            検索
          </button>
        </form>
      </div>
      {busy && <p role="status" className="text-sm text-slate-600">処理しています…</p>}
      {message && <p role="alert" className="text-sm text-red-700">{message}</p>}
      {result && (
        <div className="overflow-x-auto rounded-lg border border-slate-200 bg-white p-5">
          {result.records.length ? (
            <table className="w-full text-left text-sm">
              <thead className="border-b border-slate-200 text-slate-700">
                <tr><th scope="col" className="p-2">患者</th><th scope="col" className="p-2">受診日</th>
                  <th scope="col" className="p-2">確定日時</th><th scope="col" className="p-2">確定版</th></tr>
              </thead>
              <tbody>
                {result.records.map((record) => (
                  <tr key={recordPath(record)} className="border-b border-slate-100">
                    <td className="p-2">{record.patientName} <span className="text-slate-600">({record.patientId})</span></td>
                    <td className="p-2">{record.visitDate}</td>
                    <td className="p-2">{record.finalizedAt}</td>
                    <td className="p-2">
                      <button type="button" disabled={busy} onClick={() => openRecord(record)} className={buttonClass}
                        aria-label={`${record.patientName} ${record.visitDate} 第${record.revision}版を表示`}>
                        第{record.revision}版
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : <p role="status" className="text-sm text-slate-600">該当する確定診療録はありません。</p>}
          {(page > 1 || result.hasNext) && (
            <div className="mt-3 flex items-center gap-3 text-sm">
              <button type="button" className={buttonClass} disabled={busy || page === 1} onClick={() => search(filters, page - 1)}>前へ</button>
              <span>{page} ページ</span>
              <button type="button" className={buttonClass} disabled={busy || !result.hasNext} onClick={() => search(filters, page + 1)}>次へ</button>
            </div>
          )}
        </div>
      )}
      {selected && preview && (
        <section className="space-y-3 rounded-lg border border-slate-200 bg-white p-5" aria-labelledby="record-preview-title">
          <h2 id="record-preview-title" className="font-bold text-slate-900">
            {selected.patientName} · {selected.visitDate} · 第{selected.revision}版
          </h2>
          {canExport && (
            <div className="flex flex-wrap items-center gap-2">
              <button type="button" className={buttonClass} disabled={busy} onClick={() => exportRecord(selected, false)}>HTMLを保存</button>
              <button type="button" className={buttonClass} disabled={busy} onClick={() => exportRecord(selected, true)}>印刷用に開く</button>
              <span className="text-xs text-slate-600">印刷用のタブでブラウザーの印刷またはPDF保存を選べます。</span>
            </div>
          )}
          <iframe className="h-[34rem] w-full rounded-md border border-slate-200" sandbox="" srcDoc={preview.html} title="確定診療録のプレビュー" />
        </section>
      )}
    </section>
  );
}
