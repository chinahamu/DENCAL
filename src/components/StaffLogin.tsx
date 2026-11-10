import { useState, type FormEvent } from 'react';
import type { StaffMember } from '../types/emr';

interface StaffLoginProps {
  onLogin: (staff: StaffMember) => void;
  sessionError: string;
}

export function StaffLogin({ onLogin, sessionError }: StaffLoginProps) {
  const [message, setMessage] = useState('');
  const [pending, setPending] = useState(false);

  async function login(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    const form = event.currentTarget;
    const { staffId, password } = Object.fromEntries(new FormData(form));
    setPending(true);
    setMessage('');
    try {
      const response = await fetch('/api/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ staffId, password }),
      });
      if (response.ok) {
        const { staff } = await response.json();
        form.reset();
        onLogin(staff);
      } else if (response.status === 429) {
        setMessage('試行回数の上限に達しました。少し待ってからお試しください。');
      } else if (response.status === 400 || response.status === 401) {
        setMessage('職員IDまたはパスワードを確認してください。');
      } else {
        setMessage('認証サーバーに接続できません。DBの初期化と起動状態を確認してください。');
      }
    } catch {
      setMessage('認証サーバーに接続できません。');
    } finally {
      setPending(false);
    }
  }

  return (
    <main className="min-h-screen bg-slate-50 grid place-items-center p-4">
      <section className="w-full max-w-md rounded-lg border border-slate-200 bg-white p-6 shadow-sm">
        <p className="font-bold text-teal-800">DENCAL</p>
        <h1 className="mt-2 text-xl font-bold">職員ログイン</h1>
        <p className="mt-2 text-sm text-slate-600">架空データ専用の試作環境です。</p>
        <form onSubmit={login} className="mt-6 grid gap-4">
          <label className="grid gap-1 text-sm font-medium">職員ID
            <input name="staffId" required autoComplete="username" maxLength={64}
              className="rounded border border-slate-300 px-3 py-2" />
          </label>
          <label className="grid gap-1 text-sm font-medium">パスワード
            <input name="password" type="password" required autoComplete="current-password" maxLength={256}
              className="rounded border border-slate-300 px-3 py-2" />
          </label>
          {(message || sessionError) && <p role="alert" className="text-sm text-red-700">{message || sessionError}</p>}
          <button disabled={pending} className="rounded bg-teal-800 px-4 py-2 text-white disabled:opacity-60">
            {pending ? '確認中…' : 'ログイン'}
          </button>
        </form>
      </section>
    </main>
  );
}
