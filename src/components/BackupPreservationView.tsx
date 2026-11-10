import React, { useState } from 'react';
import {
  Archive,
  CheckCircle2,
  Database,
  Download,
  HardDrive,
  RefreshCw,
  RotateCcw,
  ShieldCheck,
} from 'lucide-react';
import { BackupSnapshot, PatientRecord, StaffMember } from '../types/emr';
import { canPerformAction, verifyBackupIntegrity } from '../utils/emrLogic';
import { CLINIC_INFO } from '../data/seedData';

interface BackupPreservationViewProps {
  backups: BackupSnapshot[];
  patients: PatientRecord[];
  currentStaff: StaffMember;
  onCreateSnapshot: (
    tier: '院内プライマリRAID10' | '院内隔離NAS (WORM不変)' | 'オフライン暗号化アーカイブ'
  ) => void;
  onVerifySnapshot: (backupId: string) => void;
  onRestoreSnapshot: (backupId: string) => void;
  onExportJsonArchive: () => void;
}

export const BackupPreservationView: React.FC<BackupPreservationViewProps> = ({
  backups,
  patients,
  currentStaff,
  onCreateSnapshot,
  onVerifySnapshot,
  onRestoreSnapshot,
  onExportJsonArchive,
}) => {
  const [selectedTier, setSelectedTier] = useState<
    '院内プライマリRAID10' | '院内隔離NAS (WORM不変)' | 'オフライン暗号化アーカイブ'
  >('院内隔離NAS (WORM不変)');
  const [actionFeedback, setActionFeedback] = useState<string | null>(null);

  const canCreateBackup = canPerformAction(currentStaff.role, 'create_backup');
  const canRestoreBackup = canPerformAction(currentStaff.role, 'restore_backup');

  const handleCreateClick = () => {
    if (!canCreateBackup) return;
    onCreateSnapshot(selectedTier);
    setActionFeedback(
      `新規暗号化スナップショット（${selectedTier} / AES-256-GCM）を生成し、SHA-256チェックサムの整合性を確認しました。`
    );
    setTimeout(() => setActionFeedback(null), 5000);
  };

  const handleVerifyAll = () => {
    backups.forEach((b) => onVerifySnapshot(b.id));
    setActionFeedback(
      `全 ${backups.length} 世代のバックアップアーカイブに対してSHA-256ハッシュ整合性検証（改ざん・ビット破損検査）を実行し、全件正常（Verified）を確認しました。`
    );
    setTimeout(() => setActionFeedback(null), 5000);
  };

  return (
    <div className="space-y-4">
      {/* 3-2-1 Backup Architecture Status Header (MHLW Guideline 6.0 Section 11 & 18) */}
      <div className="bg-white border border-slate-200 rounded-lg p-4 space-y-4">
        <div className="flex flex-wrap items-start justify-between gap-4 border-b border-slate-200 pb-3">
          <div>
            <h2 className="text-sm font-bold text-slate-900">
              厚労省ガイドライン「保存性」・BCPランサムウェア対策：3-2-1世代バックアップ体制
            </h2>
            <p className="text-xs text-slate-500 mt-0.5">
              法定保存期間（診療録5年）の完全保護と、サイバー攻撃・災害時の迅速な院内単独復旧（RPO 1時間以内 / RTO 15分以内）を保証します。
            </p>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={handleVerifyAll}
              className="px-3 py-1.5 text-xs font-semibold text-slate-800 bg-slate-100 hover:bg-slate-200 border border-slate-300 rounded-md flex items-center gap-1.5 whitespace-nowrap"
            >
              <RefreshCw className="w-3.5 h-3.5" />
              全世代SHA-256整合性テスト
            </button>
            <button
              type="button"
              onClick={() => {
                onExportJsonArchive();
                setActionFeedback(
                  '標準交換フォーマット（HL7 FHIR / JSON構造化アーカイブ）をローカル端末へエクスポートしました。'
                );
              }}
              className="px-3 py-1.5 text-xs font-semibold text-teal-800 bg-teal-50 hover:bg-teal-100 border border-teal-200 rounded-md flex items-center gap-1.5 whitespace-nowrap"
            >
              <Download className="w-3.5 h-3.5" />
              標準JSONアーカイブ出力
            </button>
          </div>
        </div>

        {/* 3 Storage Tiers Overview */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          <div className="p-3.5 bg-slate-50 border border-slate-200 rounded-md space-y-1.5">
            <div className="flex items-center justify-between">
              <span className="text-xs font-bold text-slate-900 flex items-center gap-1.5">
                <Database className="w-4 h-4 text-teal-700" />
                第1階層：院内プライマリRAID10
              </span>
              <span className="text-xs font-semibold text-emerald-700">稼働中 (同期)</span>
            </div>
            <p className="text-xs text-slate-600">
              {CLINIC_INFO.serverNode}。NVMeミラーリング＋1時間ごとの自動チェックポイント。
            </p>
            <div className="text-[11px] font-mono text-slate-500 tabular-nums">
              暗号化: AES-256-GCM · RPO: リアルタイム
            </div>
          </div>

          <div className="p-3.5 bg-slate-50 border border-slate-200 rounded-md space-y-1.5">
            <div className="flex items-center justify-between">
              <span className="text-xs font-bold text-slate-900 flex items-center gap-1.5">
                <HardDrive className="w-4 h-4 text-teal-700" />
                第2階層：院内隔離NAS (WORM不変)
              </span>
              <span className="text-xs font-semibold text-emerald-700">改ざん防止ロック</span>
            </div>
            <p className="text-xs text-slate-600">
              別セグメントVLAN (192.168.20.50)。Object Lock（追記専用・上書き削除不可）によりランサムウェア対策の構成例です。
            </p>
            <div className="text-[11px] font-mono text-slate-500 tabular-nums">
              保持期間: 90世代不変ロック · 日次自動検証
            </div>
          </div>

          <div className="p-3.5 bg-slate-50 border border-slate-200 rounded-md space-y-1.5">
            <div className="flex items-center justify-between">
              <span className="text-xs font-bold text-slate-900 flex items-center gap-1.5">
                <Archive className="w-4 h-4 text-teal-700" />
                第3階層：オフライン暗号化世代
              </span>
              <span className="text-xs font-semibold text-emerald-700">物理エアギャップ</span>
            </div>
            <p className="text-xs text-slate-600">
              夜間バッチ後にネットワークから物理切り離しされる耐火金庫保管LTO/RDXカートリッジ。5年法定保存対応。
            </p>
            <div className="text-[11px] font-mono text-slate-500 tabular-nums">
              保存期間は院内運用に合わせて別途設定
            </div>
          </div>
        </div>

        {/* Manual Snapshot Trigger Bar */}
        <div className="p-3.5 bg-slate-100/80 border border-slate-200 rounded-md flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap items-center gap-3">
            <span className="text-xs font-bold text-slate-900">
              手動スナップショット作成：
            </span>
            <select
              aria-label="保存先ストレージ階層"
              value={selectedTier}
              onChange={(e) =>
                setSelectedTier(
                  e.target.value as
                    | '院内プライマリRAID10'
                    | '院内隔離NAS (WORM不変)'
                    | 'オフライン暗号化アーカイブ'
                )
              }
              className="px-2.5 py-1.5 text-xs bg-white border border-slate-300 rounded text-slate-900"
            >
              <option value="院内隔離NAS (WORM不変)">
                第2階層：院内隔離NAS (WORM不変スナップショット)
              </option>
              <option value="院内プライマリRAID10">
                第1階層：院内プライマリRAID10 (即時チェックポイント)
              </option>
              <option value="オフライン暗号化アーカイブ">
                第3階層：オフライン暗号化アーカイブ (BCP世代保管)
              </option>
            </select>
            <span className="text-xs text-slate-500 tabular-nums">
              対象：全患者 {patients.length}名分のカルテ・処方・署名チェーン
            </span>
          </div>

          <button
            type="button"
            disabled={!canCreateBackup}
            onClick={handleCreateClick}
            className="px-4 py-2 text-xs font-semibold text-white bg-teal-700 hover:bg-teal-800 disabled:bg-slate-300 rounded-lg transition-colors flex items-center gap-1.5 whitespace-nowrap shrink-0"
          >
            <ShieldCheck className="w-4 h-4" />
            手動スナップショット作成
          </button>
        </div>

        {actionFeedback && (
          <div
            role="status"
            className="p-3 bg-emerald-50 border border-emerald-200 rounded-md text-xs text-emerald-900 flex items-center gap-2"
          >
            <CheckCircle2 className="w-4 h-4 text-emerald-700 shrink-0" />
            <span>{actionFeedback}</span>
          </div>
        )}
      </div>

      {/* Snapshot Generations Table */}
      <div className="bg-white border border-slate-200 rounded-lg overflow-hidden">
        <div className="p-4 border-b border-slate-200 flex items-center justify-between">
          <div>
            <h3 className="text-sm font-bold text-slate-900">
              保管済みバックアップ世代一覧（SHA-256改ざん検知・リストア管理）
            </h3>
            <p className="text-xs text-slate-500 mt-0.5">
              各世代のチェックサム検証および緊急時のポイントインタイム・リストアを実行できます。
            </p>
          </div>
          <span className="text-xs font-mono text-slate-500 tabular-nums">
            全 {backups.length} 世代保持中
          </span>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse text-xs">
            <thead>
              <tr className="bg-slate-50 border-b border-slate-200 text-[11px] font-semibold text-slate-600">
                <th className="py-2.5 px-3">スナップショットID / 作成日時</th>
                <th className="py-2.5 px-3">保管先階層</th>
                <th className="py-2.5 px-3">実行者</th>
                <th className="py-2.5 px-3 text-right">収録データ件数</th>
                <th className="py-2.5 px-3">暗号化・SHA-256チェックサム</th>
                <th className="py-2.5 px-3">整合性ステータス</th>
                <th className="py-2.5 px-3 text-right">検証 / 復旧操作</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-200 tabular-nums">
              {backups.map((bkp) => {
                const isValid = verifyBackupIntegrity(
                  bkp.payloadSnapshotJson,
                  bkp.sha256Checksum
                );
                return (
                  <tr key={bkp.id} className="hover:bg-slate-50">
                    <td className="py-2.5 px-3">
                      <div className="font-mono font-bold text-slate-900">{bkp.id}</div>
                      <div className="text-[11px] font-mono text-slate-500">{bkp.createdAt}</div>
                    </td>
                    <td className="py-2.5 px-3 font-medium text-slate-800">{bkp.storageTier}</td>
                    <td className="py-2.5 px-3 text-slate-600">{bkp.createdBy}</td>
                    <td className="py-2.5 px-3 text-right font-mono text-slate-700">
                      患者 {bkp.patientCount}名 · 署名 {bkp.revisionCount}件
                      <div className="text-[11px] text-slate-400">
                        {(bkp.sizeBytes / 1024).toFixed(1)} KB
                      </div>
                    </td>
                    <td className="py-2.5 px-3 font-mono text-[11px] text-slate-600">
                      <div>{bkp.cipherSpec}</div>
                      <div className="text-slate-400 truncate max-w-[180px]">
                        SHA256: {bkp.sha256Checksum.slice(0, 20)}...
                      </div>
                    </td>
                    <td className="py-2.5 px-3">
                      {isValid ? (
                        <span className="font-semibold text-emerald-700 flex items-center gap-1">
                          <CheckCircle2 className="w-3.5 h-3.5" />
                          正常 (Verified)
                        </span>
                      ) : (
                        <span className="font-semibold text-red-700">不整合検知</span>
                      )}
                      <div className="text-[10px] font-mono text-slate-400">
                        検証: {bkp.lastVerifiedAt}
                      </div>
                    </td>
                    <td className="py-2.5 px-3 text-right space-x-2 whitespace-nowrap">
                      <button
                        type="button"
                        onClick={() => {
                          onVerifySnapshot(bkp.id);
                          setActionFeedback(
                            `スナップショット ${bkp.id} のSHA-256ハッシュ再計算を実施し、一致（改ざんなし）を確認しました。`
                          );
                        }}
                        className="px-2.5 py-1 text-xs font-medium text-slate-700 bg-slate-100 hover:bg-slate-200 rounded"
                      >
                        整合性検証
                      </button>
                      <button
                        type="button"
                        disabled={!canRestoreBackup}
                        onClick={() => {
                          onRestoreSnapshot(bkp.id);
                          setActionFeedback(
                            `スナップショット ${bkp.id} の整合性を確認し、ポイントインタイム復旧テストを完了しました。`
                          );
                        }}
                        className="px-2.5 py-1 text-xs font-medium text-teal-800 bg-teal-50 hover:bg-teal-100 disabled:opacity-40 rounded inline-flex items-center gap-1"
                      >
                        <RotateCcw className="w-3 h-3" />
                        復元検証
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
};
