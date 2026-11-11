import React, { useMemo, useState } from 'react';
import {
  CheckCircle2,
  Download,
  KeyRound,
  Lock,
  Search,
  ShieldCheck,
} from 'lucide-react';
import {
  AuditLogEntry,
  MhlwComplianceItem,
  StaffMember,
  UserRole,
} from '../types/emr';
import { CLINIC_INFO, MHLW_COMPLIANCE_ITEMS } from '../data/seedData';
import { canPerformAction, EmrAction } from '../utils/emrLogic';

interface SecurityComplianceViewProps {
  currentStaff: StaffMember;
  auditLogs: AuditLogEntry[];
  onTriggerLockScreen: () => void;
}

const PERMISSION_ROWS: { action: EmrAction; label: string }[] = [
  { action: 'view_chart', label: '診療録（カルテ）・検査結果の閲覧（見読性）' },
  { action: 'edit_soap', label: 'SOAP第2号用紙の作成・追記編集' },
  { action: 'sign_soap', label: '診療録の確定・訂正版の確定' },
  { action: 'add_prescription', label: '処方オーダ・検体検査オーダの発行' },
  { action: 'record_performance', label: '診療行為の実施登録・取消' },
  { action: 'send_recept', label: 'RECEPT送信待ちの作成・送信' },
  { action: 'record_vitals', label: 'バイタルサイン・トリアージ測定値の登録' },
  { action: 'register_patient', label: '新規患者登録・オンライン資格確認受付' },
  { action: 'settle_billing', label: '診療報酬算定確定・領収書/明細書発行' },
  { action: 'create_backup', label: '暗号化バックアップ作成・整合性検証（保存性）' },
  { action: 'restore_backup', label: 'バックアップ世代からのシステム復元操作' },
  { action: 'export_referral', label: '紹介状の出力' },
  { action: 'export_record', label: '確定診療録のHTML出力・印刷' },
  { action: 'export_archive', label: '全カルテのデモJSON出力' },
  { action: 'view_audit', label: '安全管理画面・監査証跡の閲覧' },
];

export const SecurityComplianceView: React.FC<SecurityComplianceViewProps> = ({
  currentStaff,
  auditLogs,
  onTriggerLockScreen,
}) => {
  const [auditSearch, setAuditSearch] = useState('');
  const [selectedRoleFilter, setSelectedRoleFilter] = useState<'all' | UserRole>('all');
  const [exportMessage, setExportMessage] = useState<string | null>(null);

  const filteredLogs = useMemo(() => {
    return auditLogs.filter((log) => {
      const matchesRole = selectedRoleFilter === 'all' || log.actorRole === selectedRoleFilter;
      const q = auditSearch.trim().toLowerCase();
      const matchesText =
        !q ||
        log.summary.toLowerCase().includes(q) ||
        log.actorName.toLowerCase().includes(q) ||
        (log.targetPatientName && log.targetPatientName.toLowerCase().includes(q)) ||
        (log.targetPatientId && log.targetPatientId.toLowerCase().includes(q));
      return matchesRole && matchesText;
    });
  }, [auditLogs, auditSearch, selectedRoleFilter]);

  const handleExportAuditCsv = () => {
    const headers = [
      '監査ID',
      '日時',
      '操作職員ID',
      '操作職員名',
      '職種ロール',
      '操作種別',
      '対象患者ID',
      '操作内容詳細',
      '端末IPアドレス',
      '証跡ハッシュ',
    ];
    const rows = filteredLogs.map((l) => [
      l.id,
      l.timestamp,
      l.actorId,
      l.actorName,
      l.actorRole,
      l.actionType,
      l.targetPatientId || '-',
      `"${l.summary.replace(/"/g, '""')}"`,
      l.ipAddress,
      l.integrityHash,
    ]);
    const csvContent = [headers.join(','), ...rows.map((r) => r.join(','))].join('\n');
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `dencal_audit_logs_20261109.csv`;
    a.click();
    URL.revokeObjectURL(url);
    setExportMessage(`監査証跡ログ ${filteredLogs.length} 件をCSV形式で出力しました。`);
    setTimeout(() => setExportMessage(null), 4000);
  };

  return (
    <div className="space-y-4">
      {/* Top Security Posture & Session Governance Bar */}
      <div className="bg-white border border-slate-200 rounded-lg p-4 space-y-4">
        <div className="flex flex-wrap items-start justify-between gap-4 border-b border-slate-200 pb-3">
          <div>
            <h2 className="text-sm font-bold text-slate-900">
              {CLINIC_INFO.guidelineVersion} セキュリティ統制・アクセス管理
            </h2>
            <p className="text-xs text-slate-500 mt-0.5 tabular-nums">
              運用形態：院内閉域オンプレミス完結 ({CLINIC_INFO.serverNode}) · 外部クラウドへの患者個人データ送信ゼロ
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <p className="text-xs text-slate-700">セッションの有効期間はログインから30分です。</p>
            <button
              type="button"
              onClick={onTriggerLockScreen}
              className="px-3 py-1.5 text-xs font-semibold text-slate-800 bg-slate-100 hover:bg-slate-200 border border-slate-300 rounded-md flex items-center gap-1.5 whitespace-nowrap"
            >
              <Lock className="w-3.5 h-3.5" />
              ログアウトして離席する
            </button>
          </div>
        </div>

        <p className="text-xs text-slate-700">ログイン中　{currentStaff.name}（{currentStaff.roleLabel}）</p>
      </div>

      {/* MHLW Guideline v6.0 3 Principles + Security Measures Checklist & RBAC Matrix */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-4 items-start">
        {/* Left 7 cols: MHLW Compliance Checklist */}
        <div className="lg:col-span-7 bg-white border border-slate-200 rounded-lg p-4 space-y-3">
          <div className="border-b border-slate-200 pb-2.5">
            <h3 className="text-sm font-bold text-slate-900">
              電子保存の要件と画面の対応プレビュー
            </h3>
            <p className="text-xs text-slate-500 mt-0.5">
              小規模診療所・クリニックにおける院内完結運用で求められる技術的・運用的対策の実装一覧
            </p>
          </div>

          <div className="divide-y divide-slate-200">
            {MHLW_COMPLIANCE_ITEMS.map((item: MhlwComplianceItem) => (
              <div key={item.id} className="py-3 space-y-1">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex items-center gap-2 text-xs">
                    <span className="font-bold text-teal-800">{item.pillar}</span>
                    <span className="text-slate-400">·</span>
                    <span className="font-semibold text-slate-900">{item.title}</span>
                  </div>
                  <span className="text-xs font-semibold text-emerald-700 flex items-center gap-1 shrink-0">
                    <CheckCircle2 className="w-3.5 h-3.5" />
                    デモ表示
                  </span>
                </div>
                <p className="text-xs text-slate-600 leading-relaxed">{item.requirement}</p>
                <p className="text-xs text-slate-800 bg-slate-50 p-2 rounded border border-slate-200">
                  <span className="font-semibold">本システム実装：</span>
                  {item.implementationDetail}
                </p>
              </div>
            ))}
          </div>
        </div>

        {/* Right 5 cols: RBAC Permission Matrix */}
        <div className="lg:col-span-5 bg-white border border-slate-200 rounded-lg p-4 space-y-3">
          <div className="border-b border-slate-200 pb-2.5">
            <h3 className="text-sm font-bold text-slate-900 flex items-center gap-1.5">
              <KeyRound className="w-4 h-4 text-teal-700" />
              職種別アクセス権限マトリクス（最小権限原則）
            </h3>
            <p className="text-xs text-slate-500 mt-0.5">
              現在選択中の職種（{currentStaff.roleLabel}）の列がハイライトされています。
            </p>
          </div>

          <div className="overflow-x-auto border border-slate-200 rounded-md">
            <table className="w-full text-left border-collapse text-xs">
              <thead>
                <tr className="bg-slate-50 border-b border-slate-200 text-[11px] font-semibold text-slate-600">
                  <th className="py-2 px-2.5">操作権限項目</th>
                  <th
                    className={`py-2 px-2 text-center ${
                      currentStaff.role === 'doctor' ? 'bg-teal-50 text-teal-900 font-bold' : ''
                    }`}
                  >
                    医師
                  </th>
                  <th
                    className={`py-2 px-2 text-center ${
                      currentStaff.role === 'nurse' ? 'bg-teal-50 text-teal-900 font-bold' : ''
                    }`}
                  >
                    看護師
                  </th>
                  <th
                    className={`py-2 px-2 text-center ${
                      currentStaff.role === 'clerk' ? 'bg-teal-50 text-teal-900 font-bold' : ''
                    }`}
                  >
                    医療事務
                  </th>
                  <th
                    className={`py-2 px-2 text-center ${
                      currentStaff.role === 'admin' ? 'bg-teal-50 text-teal-900 font-bold' : ''
                    }`}
                  >
                    管理者
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-200">
                {PERMISSION_ROWS.map((row) => (
                  <tr key={row.action}>
                    <td className="py-2 px-2.5 text-slate-800">{row.label}</td>
                    {(['doctor', 'nurse', 'clerk', 'admin'] as const).map((r) => {
                      const allowed = canPerformAction(r, row.action);
                      return (
                        <td
                          key={r}
                          className={`py-2 px-2 text-center font-mono ${
                            currentStaff.role === r ? 'bg-teal-50/50' : ''
                          }`}
                        >
                          {allowed ? (
                            <span className="font-bold text-emerald-700">許可</span>
                          ) : (
                            <span className="text-slate-400">不可</span>
                          )}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      {/* Immutable Audit Trail Table (監査証跡ログ) */}
      <div className="bg-white border border-slate-200 rounded-lg overflow-hidden">
        <div className="p-4 border-b border-slate-200 flex flex-wrap items-center justify-between gap-3">
          <div>
            <h3 className="text-sm font-bold text-slate-900 flex items-center gap-1.5">
              <ShieldCheck className="w-4 h-4 text-teal-700" />
              監査証跡ログ（デモ）
            </h3>
            <p className="text-xs text-slate-500 mt-0.5">
              架空の操作履歴を表示します。実運用の監査記録や改ざん防止機能とは連携していません。
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <div className="relative">
              <Search className="w-3.5 h-3.5 text-slate-400 absolute left-2.5 top-1/2 -translate-y-1/2" />
              <input
                type="search"
                aria-label="監査ログ検索"
                value={auditSearch}
                onChange={(e) => setAuditSearch(e.target.value)}
                placeholder="職員名・患者名・操作で検索..."
                className="pl-8 pr-3 py-1.5 text-xs bg-slate-50 border border-slate-200 rounded-md"
              />
            </div>

            <select
              aria-label="職種フィルタ"
              value={selectedRoleFilter}
              onChange={(e) => setSelectedRoleFilter(e.target.value as 'all' | UserRole)}
              className="px-2.5 py-1.5 text-xs bg-slate-50 border border-slate-200 rounded-md"
            >
              <option value="all">全職種表示</option>
              <option value="doctor">医師</option>
              <option value="nurse">看護師</option>
              <option value="clerk">医療事務</option>
              <option value="admin">システム管理者</option>
            </select>

            <button
              type="button"
              onClick={handleExportAuditCsv}
              className="px-3 py-1.5 text-xs font-semibold text-teal-800 bg-teal-50 hover:bg-teal-100 border border-teal-200 rounded-md flex items-center gap-1.5 whitespace-nowrap"
            >
              <Download className="w-3.5 h-3.5" />
              監査CSV出力
            </button>
          </div>
        </div>

        {exportMessage && (
          <div className="p-2.5 bg-emerald-50 border-b border-emerald-200 text-xs text-emerald-900">
            {exportMessage}
          </div>
        )}

        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse text-xs">
            <thead>
              <tr className="bg-slate-50 border-b border-slate-200 text-[11px] font-semibold text-slate-600">
                <th className="py-2.5 px-3">監査ID / タイムスタンプ</th>
                <th className="py-2.5 px-3">操作職員 (ロール)</th>
                <th className="py-2.5 px-3">イベント種別</th>
                <th className="py-2.5 px-3">対象患者</th>
                <th className="py-2.5 px-3">監査記録内容</th>
                <th className="py-2.5 px-3">院内端末IP / 証跡ハッシュ</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-200 tabular-nums">
              {filteredLogs.map((log) => (
                <tr key={log.id} className="hover:bg-slate-50">
                  <td className="py-2.5 px-3 font-mono whitespace-nowrap">
                    <div className="font-semibold text-slate-900">{log.id}</div>
                    <div className="text-[11px] text-slate-500">{log.timestamp}</div>
                  </td>
                  <td className="py-2.5 px-3 whitespace-nowrap">
                    <div className="font-semibold text-slate-900">{log.actorName}</div>
                    <div className="text-[11px] text-slate-500 font-mono">{log.actorId}</div>
                  </td>
                  <td className="py-2.5 px-3 font-mono font-semibold text-teal-800 whitespace-nowrap">
                    {log.actionType}
                  </td>
                  <td className="py-2.5 px-3 whitespace-nowrap">
                    {log.targetPatientName ? (
                      <div>
                        <span className="font-medium text-slate-900">{log.targetPatientName}</span>
                        <div className="text-[11px] font-mono text-slate-500">
                          {log.targetPatientId}
                        </div>
                      </div>
                    ) : (
                      <span className="text-slate-400">システム全体</span>
                    )}
                  </td>
                  <td className="py-2.5 px-3 text-slate-700">{log.summary}</td>
                  <td className="py-2.5 px-3 font-mono text-[11px] text-slate-500 whitespace-nowrap">
                    <div>{log.ipAddress}</div>
                    <div className="text-slate-400">Hash: {log.integrityHash.slice(0, 16)}...</div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
};
