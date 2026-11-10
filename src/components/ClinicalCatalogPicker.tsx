import { useEffect, useId, useState } from 'react';
import { catalogKinds, type CatalogEntry, type CatalogKind } from '../types/catalog';

export function ClinicalCatalogPicker({ kind, value, onSelect }: {
  kind: CatalogKind;
  value: CatalogEntry | undefined;
  onSelect: (entry: CatalogEntry | undefined) => void;
}) {
  const id = useId();
  const [query, setQuery] = useState('');
  const [entries, setEntries] = useState<CatalogEntry[]>([]);
  const [notice, setNotice] = useState('');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const controller = new AbortController();
    const timer = window.setTimeout(async () => {
      try {
        const params = new URLSearchParams({ kind, q: query });
        const response = await fetch(`/api/catalog/search?${params}`, { signal: controller.signal });
        if (!response.ok) throw new Error();
        const result = await response.json() as { ready: boolean; entries: CatalogEntry[] };
        if (controller.signal.aborted) return;
        setEntries(result.entries);
        setNotice(!result.ready ? '管理者が利用可能な公式マスターを取り込むと検索できます。'
          : result.entries.length ? '' : '該当する候補がありません。');
      } catch {
        if (!controller.signal.aborted) {
          setEntries([]);
          setNotice('マスターの検索に失敗しました。ログイン状態を確認してください。');
        }
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    }, 200);
    return () => { window.clearTimeout(timer); controller.abort(); };
  }, [kind, query]);

  return (
    <div className="space-y-1.5 text-xs">
      <label htmlFor={id} className="block font-semibold text-slate-700">公式{catalogKinds[kind]}マスターを検索</label>
      <input id={id} type="search" maxLength={120} value={query} placeholder="名称・カナ・コード"
        className="w-full rounded border border-slate-300 bg-white px-2 py-1.5"
        onChange={(event) => {
          const text = event.target.value;
          if (text === query) return;
          setEntries([]);
          setLoading(true);
          setQuery(text);
          onSelect(undefined);
        }} />
      <select aria-label={`${catalogKinds[kind]}の候補`} value={value?.id ?? ''} disabled={loading || !entries.length}
        onChange={(event) => onSelect(entries.find((entry) => String(entry.id) === event.target.value))}
        className="w-full rounded border border-slate-300 bg-white px-2 py-1.5 disabled:opacity-60">
        <option value="">候補を選択（最大40件）</option>
        {entries.map((entry) => (
          <option key={entry.id} value={entry.id}>
            {entry.name}（{entry.code}{entry.icd10 ? ` · ${entry.icd10}` : ''}{entry.unit ? ` · ${entry.unit}` : ''}）
          </option>
        ))}
      </select>
      {(loading || notice) && <p role="status" className="text-slate-600">{loading ? '検索中…' : notice}</p>}
    </div>
  );
}
