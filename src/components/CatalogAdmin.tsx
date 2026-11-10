import { useEffect, useState, type FormEvent } from 'react';
import { catalogKinds, masterUploadLimit, type CatalogRelease } from '../types/catalog';

export function CatalogAdmin() {
  const [releases, setReleases] = useState<CatalogRelease[]>([]);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    const controller = new AbortController();
    fetch('/api/catalog', { signal: controller.signal }).then(async (response) => {
      if (!response.ok) throw new Error();
      const items = await response.json() as CatalogRelease[];
      if (!controller.signal.aborted) setReleases(items);
    }).catch(() => {
      if (!controller.signal.aborted) setError('取り込み履歴を取得できませんでした。');
    });
    return () => controller.abort();
  }, []);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const file = new FormData(form).get('master');
    setError('');
    setMessage('');
    if (!(file instanceof File) || !file.size || file.size > masterUploadLimit) {
      setError('20 MiB以下のCSVまたはTXTを選んでください。');
      return;
    }

    setBusy(true);
    try {
      const params = new URLSearchParams({ filename: file.name });
      const response = await fetch(`/api/catalog?${params}`, {
        method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: file,
      });
      const result = await response.json();
      if (!response.ok) throw new Error(response.status === 400 || response.status === 413 ? result.error : '取り込めませんでした。管理者でのログインと接続状態を確認してください。');
      setMessage(result.duplicate ? '同じファイルは取り込み済みです。' : `${result.count.toLocaleString()}件を取り込みました。`);
      form.reset();
      const latest = await fetch('/api/catalog');
      if (!latest.ok) throw new Error('取り込み履歴を更新できませんでした。');
      setReleases(await latest.json());
    } catch (err) {
      setError(err instanceof Error ? err.message : '取り込みに失敗しました。');
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="space-y-4 rounded-md border border-slate-200 bg-white p-5">
      <h1 className="text-base font-bold">公式マスター管理</h1>
      <p className="text-sm text-slate-600">公式サイトから全件版をダウンロードし、解凍したファイルを元の名前で取り込みます。</p>
      <ul className="flex flex-wrap gap-4 text-sm text-teal-800">
        <li><a className="underline" href="https://shinryohoshu.mhlw.go.jp/shinryohoshu/standardMenu/doStandardMasterBz/" target="_blank" rel="noreferrer">厚労省 傷病名</a></li>
        <li><a className="underline" href="https://shinryohoshu.mhlw.go.jp/shinryohoshu/downloadMenu/" target="_blank" rel="noreferrer">厚労省 医薬品・医科診療行為</a></li>
      </ul>
      <form onSubmit={submit} className="flex flex-wrap items-end gap-3">
        <label className="grid gap-1 text-sm">
          全件マスター（CSV・TXT）
          <input name="master" type="file" accept=".csv,.txt" required disabled={busy} />
        </label>
        <button type="submit" disabled={busy} className="rounded bg-teal-800 px-3 py-2 text-xs text-white disabled:opacity-50">
          {busy ? '取り込み中…' : '取り込む'}
        </button>
      </form>
      {message && <p role="status" className="text-sm text-teal-800">{message}</p>}
      {error && <p role="alert" className="text-sm text-red-800">{error}</p>}
      <h2 className="text-sm font-bold">取り込み履歴</h2>
      <ul className="divide-y divide-slate-200 text-sm">
        {releases.map((release) => (
          <li className="py-2" key={release.kind + release.releaseDate + release.sha256}>
            {catalogKinds[release.kind]} · {release.releaseDate}版 · {release.count.toLocaleString()}件
            <span className="ml-2 text-slate-500">取込 {new Date(release.importedAt).toLocaleString('ja-JP')}</span>
          </li>
        ))}
        {!releases.length && <li className="text-slate-600">取り込み済みのマスターはありません。</li>}
      </ul>
    </section>
  );
}
