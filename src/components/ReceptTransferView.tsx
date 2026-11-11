import { useEffect, useRef, useState, type FormEvent } from 'react';
import type { CatalogEntry } from '../types/catalog';
import type { ReceptOutboxItem, ReceptWorkspace } from '../types/recept';
import { ClinicalCatalogPicker } from './ClinicalCatalogPicker';

type Props = {
  patientId: string;
  request: <T>(path: string, signal: AbortSignal, body?: unknown) => Promise<T>;
  canRecord: boolean;
  canSend: boolean;
};

const inputClass = 'rounded border border-slate-300 bg-white px-2 py-1.5 text-sm';
const buttonClass = 'rounded border border-teal-700 px-3 py-1.5 text-sm font-semibold text-teal-800 disabled:opacity-50';
const receiptStatus = {
  received: '受信済み', confirmation_required: '確認待ち', applied: '請求下書きに反映済み', rejected: '受信側で却下',
} as const;
const eventLabels = { initial: '初回', correction: '訂正', cancel: '受診取消' } as const;

function sendStatus(item: ReceptOutboxItem) {
  if (item.receipt) return receiptStatus[item.receipt.status];
  if (item.sending) return '送信中';
  if (item.lastError) return '送信失敗・再送待ち';
  return '送信待ち';
}

export function ReceptTransferView({ patientId, request, canRecord, canSend }: Props) {
  const [data, setData] = useState<ReceptWorkspace | null>(null);
  const [performedOn, setPerformedOn] = useState('');
  const [master, setMaster] = useState<CatalogEntry>();
  const [quantity, setQuantity] = useState('1');
  const [cancellingId, setCancellingId] = useState('');
  const [cancellationReason, setCancellationReason] = useState('');
  const [transferReason, setTransferReason] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(true);
  const active = useRef<AbortController | null>(null);
  const registration = useRef<{ values: string; id: string } | null>(null);
  const path = `patients/${patientId}/`;
  const unit = master ? master.unit.trim() || '回' : '';
  const last = data?.outbox.at(-1);
  const nextToSend = data?.outbox.find((item) => !item.receipt);

  useEffect(() => {
    const controller = new AbortController();
    active.current = controller;
    request<ReceptWorkspace>(path + 'recept', controller.signal).then((value) => {
      if (controller.signal.aborted) return;
      setData(value);
      setPerformedOn(value.visitDate);
    }).catch((failure) => {
      if (!controller.signal.aborted) setError(failure instanceof Error ? failure.message : '実施記録を取得できませんでした。');
    }).finally(() => {
      if (!controller.signal.aborted) setBusy(false);
    });
    return () => active.current?.abort();
  }, [path, request]);

  async function run(operation: string, input?: unknown) {
    if (busy) return false;
    const controller = new AbortController();
    active.current = controller;
    setBusy(true);
    setError('');
    try {
      const next = await request<ReceptWorkspace>(path + operation, controller.signal, input);
      if (controller.signal.aborted) return false;
      setData(next);
      setPerformedOn((previous) => previous || next.visitDate);
      return true;
    } catch (failure) {
      if (!controller.signal.aborted) setError(failure instanceof Error ? failure.message : '処理できませんでした。');
      return false;
    } finally {
      if (!controller.signal.aborted) setBusy(false);
    }
  }

  async function register(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!master || !performedOn) return;
    const input = { masterItemId: master.id, performedOn, quantity: Number(quantity), unit };
    const values = JSON.stringify(input);
    if (registration.current?.values !== values) registration.current = { values, id: crypto.randomUUID() };
    if (await run('performance_add', { ...input, id: registration.current.id })) {
      registration.current = null;
      setMaster(undefined);
      setQuantity('1');
    }
  }

  async function cancel(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (await run('performance_cancel', { id: cancellingId, reason: cancellationReason.trim() })) {
      setCancellingId('');
      setCancellationReason('');
    }
  }

  async function queue(event: 'upsert' | 'cancel') {
    if (await run('recept_queue', {
      event, expectedChartRevision: data?.chartRevision, expectedPerformanceVersion: data?.performanceVersion, reason: transferReason.trim(),
    })) {
      setTransferReason('');
    }
  }

  return (
    <div className="space-y-4">
      {error && <p role="alert" className="text-sm text-red-700">{error}</p>}
      {busy && <p role="status" className="text-sm text-slate-600">処理しています…</p>}
      <section className="space-y-3 rounded-lg border border-slate-200 bg-white p-4" aria-labelledby="performance-title">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 id="performance-title" className="font-semibold text-slate-900">診療行為の実施記録</h2>
          <button type="button" className={buttonClass} disabled={busy}
            onClick={() => void run('recept')}>
            再読込
          </button>
        </div>
        {data?.performances.length === 0 && <p className="text-sm text-slate-600">実施記録はありません。</p>}
        {data?.performances.map((item) => (
          <div key={item.id} className="flex flex-wrap items-center justify-between gap-2 rounded border border-slate-200 p-2 text-sm">
            <div>
              <p className="font-semibold">{item.name}（{item.code}）</p>
              <p>{item.performedOn ?? '実施日未登録'} · {item.quantity} {item.unit ?? '単位未登録'}</p>
              {item.cancelledAt && <p className="text-slate-600">取消済み · {item.cancellationReason}</p>}
            </div>
            {canRecord && !item.cancelledAt && (
              <button type="button" className={buttonClass} disabled={busy}
                onClick={() => { setCancellingId(item.id); setCancellationReason(''); }}>
                実施を取り消す
              </button>
            )}
            {cancellingId === item.id && !item.cancelledAt && (
              <form className="flex w-full flex-wrap items-end gap-2" onSubmit={cancel}>
                <label className="flex flex-col text-xs">
                  取消理由
                  <input className={inputClass} required maxLength={512} value={cancellationReason}
                    onChange={(e) => setCancellationReason(e.target.value)} />
                </label>
                <button type="submit" className={buttonClass} disabled={busy || !cancellationReason.trim()}>取消を記録</button>
                <button type="button" className={buttonClass} disabled={busy} onClick={() => setCancellingId('')}>戻る</button>
              </form>
            )}
          </div>
        ))}
        {data && canRecord && (
          <form className="space-y-3 border-t border-slate-200 pt-3" onSubmit={register}>
            <div className="flex flex-wrap items-end gap-3">
              <label className="flex flex-col text-xs">
                実施日
                <input type="date" className={inputClass} min={data.visitDate} max={data.today} value={performedOn} required
                  onChange={(e) => { setPerformedOn(e.target.value); setMaster(undefined); }} />
              </label>
              <label className="flex flex-col text-xs">
                数量
                <input type="number" className={inputClass} min="0" max="1000000" step="any" required value={quantity}
                  onChange={(e) => setQuantity(e.target.value)} />
              </label>
              <label className="flex flex-col text-xs">
                単位
                <input className={inputClass} value={unit} readOnly />
              </label>
            </div>
            {performedOn && <ClinicalCatalogPicker key={performedOn} kind="procedure" performedOn={performedOn} value={master} onSelect={setMaster} />}
            <button type="submit" className={buttonClass} disabled={busy || !master || Number(quantity) <= 0}>実施を登録</button>
          </form>
        )}
      </section>

      {data && (
        <section className="space-y-3 rounded-lg border border-slate-200 bg-white p-4" aria-labelledby="recept-outbox-title">
          <h2 id="recept-outbox-title" className="font-semibold text-slate-900">RECEPT送信待ち・履歴</h2>
          <p className="break-all text-xs text-slate-600">施設 {data.facilityId} · 送信元 {data.senderId}</p>
          {!data.transportConfigured && <p className="text-sm text-slate-600">送信先が未設定です。送信待ちデータは作成できます。</p>}
          {!data.outbox.length && <p className="text-sm text-slate-600">送信待ちデータはありません。</p>}
          {data.outbox.map((item) => (
            <div key={item.id} className="flex flex-wrap items-center justify-between gap-2 rounded border border-slate-200 p-2 text-sm">
              <div>
                <p className="font-semibold">連携第{item.transferRevision}版 · {eventLabels[item.event]} · {sendStatus(item)}</p>
                <p className="break-all text-xs text-slate-600">カルテ第{item.chartRevision}版 · {item.id} · 送信 {item.attempts} 回</p>
                <details className="mt-1 text-xs">
                  <summary className="cursor-pointer">送信内容を確認</summary>
                  <p>作成日時 {item.queuedAt}</p>
                  {item.event === 'cancel' && <p>この連携版は受診全体の取消です。</p>}
                  {item.diagnosisCodes.length > 0 && <p>傷病名コード {item.diagnosisCodes.join('、')}</p>}
                  {item.performedItems.map((execution) => (
                    <p key={execution.id}>{execution.performedOn} · {execution.code} · {execution.quantity} {execution.unit}
                      {execution.status === 'cancelled' && ' · 取消'}</p>
                  ))}
                </details>
                {item.lastError && <p className="text-xs text-red-700">送信結果 {item.lastError}</p>}
                {item.receipt?.issues.map(({ code, path: issuePath }) => <p key={code + issuePath} className="text-xs">{code} {issuePath}</p>)}
              </div>
              {canSend && item.id === nextToSend?.id && (
                <button type="button" className={buttonClass} disabled={busy || item.sending || !data.transportConfigured}
                  onClick={() => void run('recept_send', { id: item.id })}>
                  {item.attempts ? '同じ内容を再送' : 'RECEPTへ送信'}
                </button>
              )}
            </div>
          ))}
          {canSend && last?.event !== 'cancel' && (
            <div className="space-y-2 border-t border-slate-200 pt-3">
              {!data.finalized && <p className="text-xs text-slate-600">送信待ちデータを作る前にカルテを確定してください。</p>}
              {last && (
                <label className="flex max-w-lg flex-col text-xs">
                  訂正・受診取消理由
                  <input className={inputClass} maxLength={512} value={transferReason} onChange={(e) => setTransferReason(e.target.value)} />
                </label>
              )}
              <div className="flex flex-wrap gap-2">
                <button type="button" className={buttonClass}
                  disabled={busy || !data.finalized || Boolean(last && !transferReason.trim()) ||
                    (!last && !data.performances.some((item) => !item.cancelledAt && item.performedOn && item.unit))}
                  onClick={() => void queue('upsert')}>
                  {last ? '訂正版を送信待ちに追加' : '送信待ちデータを作成'}
                </button>
                {last && (
                  <button type="button" className={buttonClass} disabled={busy || !transferReason.trim()} onClick={() => void queue('cancel')}>
                    受診取消を送信待ちに追加
                  </button>
                )}
              </div>
            </div>
          )}
        </section>
      )}
    </div>
  );
}
