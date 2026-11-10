import React, { useEffect, useState } from 'react';
import { Lock, ShieldCheck } from 'lucide-react';
import {
  AllergyItem,
  AuditLogEntry,
  BackupSnapshot,
  LabOrderItem,
  PatientRecord,
  PrescriptionItem,
  SoapContent,
  SoapRevision,
  StaffMember,
  VitalRecord,
} from './types/emr';
import {
  CLINIC_INFO,
  INITIAL_AUDIT_LOGS,
  INITIAL_BACKUPS,
  INITIAL_PATIENTS,
  STAFF_MEMBERS,
} from './data/seedData';
import { computePayloadChecksum, computeRecordHash } from './utils/emrLogic';
import { ClinicalWorkbench } from './components/ClinicalWorkbench';
import { ReceptionBillingView } from './components/ReceptionBillingView';
import { BackupPreservationView } from './components/BackupPreservationView';
import { SecurityComplianceView } from './components/SecurityComplianceView';
import { NewPatientModal } from './components/NewPatientModal';

type MainNavView = 'workbench' | 'reception_billing' | 'backup_dr' | 'security_audit';

export default function App() {
  const [activeView, setActiveView] = useState<MainNavView>('workbench');
  const [patients, setPatients] = useState<PatientRecord[]>(INITIAL_PATIENTS);
  const [backups, setBackups] = useState<BackupSnapshot[]>(INITIAL_BACKUPS);
  const [auditLogs, setAuditLogs] = useState<AuditLogEntry[]>(INITIAL_AUDIT_LOGS);

  const [selectedPatientId, setSelectedPatientId] = useState<string>(INITIAL_PATIENTS[0].id);
  const [currentStaff, setCurrentStaff] = useState<StaffMember>(STAFF_MEMBERS[0]);
  const [isNewPatientModalOpen, setIsNewPatientModalOpen] = useState<boolean>(false);
  const [isScreenLocked, setIsScreenLocked] = useState<boolean>(false);
  const [autoLockMinutes, setAutoLockMinutes] = useState<number>(5);
  const [unlockPin, setUnlockPin] = useState('');

  const appendAuditLog = (
    actionType: AuditLogEntry['actionType'],
    summary: string,
    targetPatient?: { id: string; name: string },
    overrideActor?: StaffMember
  ) => {
    const actor = overrideActor || currentStaff;
    const now = new Date();
    const ts = `2026-11-09 ${now.toTimeString().slice(0, 8)}`;
    const integrityHash = computePayloadChecksum(
      `${ts}:${actor.id}:${actionType}:${summary}`
    );
    const newEntry: AuditLogEntry = {
      id: `AUD-${9000 + auditLogs.length + 1}`,
      timestamp: ts,
      actorId: actor.id,
      actorName: actor.name,
      actorRole: actor.role,
      actionType,
      targetPatientId: targetPatient?.id,
      targetPatientName: targetPatient?.name,
      summary,
      integrityHash,
      ipAddress:
        actor.role === 'doctor'
          ? '192.168.10.11 (第1診察室端末)'
          : actor.role === 'nurse'
          ? '192.168.10.24 (処置室端末-02)'
          : actor.role === 'clerk'
          ? '192.168.10.31 (医事受付端末-01)'
          : '192.168.10.10 (INHOUSE-SRV-01)',
    };
    setAuditLogs((prev) => [newEntry, ...prev]);
  };

  const handleSelectPatient = (patientId: string) => {
    setSelectedPatientId(patientId);
    const pt = patients.find((p) => p.id === patientId);
    if (pt) {
      appendAuditLog(
        'RECORD_VIEW',
        `患者カルテ（第1号・第2号用紙）および処方・検査歴を閲覧`,
        { id: pt.id, name: pt.kanjiName }
      );
    }
  };

  const handleUpdateSoap = (patientId: string, soap: SoapContent) => {
    setPatients((prev) =>
      prev.map((p) =>
        p.id === patientId
          ? {
              ...p,
              currentSoap: soap,
              isSigned: false,
            }
          : p
      )
    );
  };

  const handleAddPrescription = (patientId: string, item: PrescriptionItem) => {
    const pt = patients.find((p) => p.id === patientId);
    setPatients((prev) =>
      prev.map((p) =>
        p.id === patientId
          ? {
              ...p,
              currentPrescriptions: [...p.currentPrescriptions, item],
              isSigned: false,
            }
          : p
      )
    );
    if (pt) {
      appendAuditLog(
        'PRESCRIPTION_ADD',
        `処方オーダ追加：${item.drugName} (${item.dosagePerDay} / ${item.days}日分)`,
        { id: pt.id, name: pt.kanjiName }
      );
    }
  };

  const handleRemovePrescription = (patientId: string, prescriptionId: string) => {
    setPatients((prev) =>
      prev.map((p) =>
        p.id === patientId
          ? {
              ...p,
              currentPrescriptions: p.currentPrescriptions.filter(
                (rx) => rx.id !== prescriptionId
              ),
              isSigned: false,
            }
          : p
      )
    );
  };

  const handleToggleLabOrder = (patientId: string, labOrder: LabOrderItem) => {
    setPatients((prev) =>
      prev.map((p) => {
        if (p.id !== patientId) return p;
        const exists = p.currentLabOrders.some((l) => l.id === labOrder.id);
        const updatedLabs = exists
          ? p.currentLabOrders.filter((l) => l.id !== labOrder.id)
          : [...p.currentLabOrders, labOrder];
        return {
          ...p,
          currentLabOrders: updatedLabs,
          isSigned: false,
        };
      })
    );
  };

  const handleSignAndFinalizeChart = (patientId: string, revisionReason: string) => {
    const now = new Date();
    const ts = `2026-11-09 ${now.toTimeString().slice(0, 8)}`;
    const hpkiId = currentStaff.hpkiCertId || 'HPKI-JP-MED-2026-884102';

    setPatients((prev) =>
      prev.map((p) => {
        if (p.id !== patientId) return p;
        const prevHash =
          p.revisions.length > 0
            ? p.revisions[0].sha256Hash
            : 'GENESIS_00000000000000000000000000000000';
        const newHash = computeRecordHash(
          p.id,
          p.currentSoap,
          p.currentPrescriptions,
          p.currentLabOrders,
          hpkiId,
          ts,
          prevHash
        );
        const newRev: SoapRevision = {
          revisionNumber: p.revisions.length + 1,
          timestamp: ts,
          authorId: currentStaff.id,
          authorName: currentStaff.name,
          authorRole: currentStaff.role,
          hpkiSignatureId: hpkiId,
          reasonForRevision: revisionReason,
          soap: { ...p.currentSoap },
          prescriptions: [...p.currentPrescriptions],
          labOrders: [...p.currentLabOrders],
          sha256Hash: newHash,
          previousHash: prevHash,
        };
        return {
          ...p,
          visitStatus: p.billingCompleted ? 'completed' : 'billing',
          isSigned: true,
          signedAt: ts,
          signedBy: currentStaff.name,
          hpkiCertId: hpkiId,
          currentHash: newHash,
          revisions: [newRev, ...p.revisions],
        };
      })
    );

    const pt = patients.find((p) => p.id === patientId);
    if (pt) {
      appendAuditLog(
        pt.revisions.length > 0 ? 'SOAP_REVISION' : 'SOAP_SIGN',
        `SOAP診療録 第${pt.revisions.length + 1}版 HPKI電子署名確定 (${hpkiId}) · 理由: ${revisionReason}`,
        { id: pt.id, name: pt.kanjiName }
      );
    }
  };

  const handleAddVitalSign = (patientId: string, vital: VitalRecord) => {
    setPatients((prev) =>
      prev.map((p) =>
        p.id === patientId
          ? {
              ...p,
              vitalsHistory: [vital, ...p.vitalsHistory],
            }
          : p
      )
    );
  };

  const handleAddAllergy = (patientId: string, allergy: AllergyItem) => {
    setPatients((prev) =>
      prev.map((p) =>
        p.id === patientId
          ? {
              ...p,
              allergies: [...p.allergies, allergy],
            }
          : p
      )
    );
  };

  const handleRegisterNewPatient = (newPatient: PatientRecord) => {
    setPatients((prev) => [newPatient, ...prev]);
    setSelectedPatientId(newPatient.id);
    appendAuditLog(
      'PATIENT_REGISTER',
      `新規来院受付・第1号カルテ開設 (受付番号 ${newPatient.receptionNumber} / ${newPatient.insuranceType})`,
      { id: newPatient.id, name: newPatient.kanjiName }
    );
  };

  const handleCompleteBilling = (patientId: string) => {
    const now = new Date();
    const ts = `2026-11-09 ${now.toTimeString().slice(0, 8)}`;
    setPatients((prev) =>
      prev.map((p) =>
        p.id === patientId
          ? {
              ...p,
              visitStatus: 'completed',
              billingCompleted: true,
              receiptIssuedAt: ts,
            }
          : p
      )
    );
    const pt = patients.find((p) => p.id === patientId);
    if (pt) {
      appendAuditLog(
        'BILLING_SETTLE',
        `外来会計精算完了・領収証および診療明細書を発行`,
        { id: pt.id, name: pt.kanjiName }
      );
    }
  };

  const handleCreateSnapshot = (
    tier: '院内プライマリRAID10' | '院内隔離NAS (WORM不変)' | 'オフライン暗号化アーカイブ'
  ) => {
    const now = new Date();
    const ts = `2026-11-09 ${now.toTimeString().slice(0, 8)}`;
    const payload = JSON.stringify({
      facility: CLINIC_INFO.facilityCode,
      snapshotAt: ts,
      patientIds: patients.map((p) => p.id),
      tier,
    });
    const checksum = computePayloadChecksum(payload);
    const totalRevs = patients.reduce((acc, p) => acc + p.revisions.length, 0);

    const newBkp: BackupSnapshot = {
      id: `BKP-20261109-${String(backups.length + 10).padStart(4, '0')}`,
      createdAt: ts,
      createdBy: `${currentStaff.name} (${currentStaff.roleLabel})`,
      type: 'manual_checkpoint',
      storageTier: tier,
      patientCount: patients.length,
      revisionCount: totalRevs,
      auditLogCount: auditLogs.length + 1,
      sizeBytes: 184000 + patients.length * 4120,
      cipherSpec: 'AES-256-GCM / TLS 1.3',
      sha256Checksum: checksum,
      verifiedStatus: 'verified',
      lastVerifiedAt: ts,
      payloadSnapshotJson: payload,
    };

    setBackups((prev) => [newBkp, ...prev]);
    appendAuditLog(
      'BACKUP_CREATE',
      `手動暗号化スナップショット ${newBkp.id} (${tier}) を作成・SHA-256検証完了`
    );
  };

  const handleVerifySnapshot = (backupId: string) => {
    const now = new Date();
    const ts = `2026-11-09 ${now.toTimeString().slice(0, 8)}`;
    setBackups((prev) =>
      prev.map((b) =>
        b.id === backupId
          ? {
              ...b,
              lastVerifiedAt: ts,
              verifiedStatus: 'verified',
            }
          : b
      )
    );
    appendAuditLog(
      'BACKUP_VERIFY',
      `バックアップ世代 ${backupId} のSHA-256チェックサム整合性検証を実施（異常なし）`
    );
  };

  const handleRestoreSnapshot = (backupId: string) => {
    appendAuditLog(
      'BACKUP_RESTORE',
      `バックアップ世代 ${backupId} からのポイントインタイム・リストア検証を実行`
    );
  };

  const handleExportJsonArchive = () => {
    const exportPayload = {
      exportedAt: new Date().toISOString(),
      clinic: CLINIC_INFO,
      patients,
      backupsCount: backups.length,
    };
    const blob = new Blob([JSON.stringify(exportPayload, null, 2)], {
      type: 'application/json',
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `dencal_fhir_archive_20261109.json`;
    a.click();
    URL.revokeObjectURL(url);
    appendAuditLog(
      'DOCUMENT_EXPORT',
      `院内全カルテデータの標準JSONアーカイブ出力を実行`
    );
  };

  const handleSwitchStaff = (staff: StaffMember) => {
    setCurrentStaff(staff);
    appendAuditLog(
      'ROLE_SWITCH',
      `操作セッション職種切替：${staff.name} (${staff.roleLabel}) として認証完了`,
      undefined,
      staff
    );
  };

  return (
    <div className="min-h-screen flex flex-col bg-[#F8FAFC] text-[#0F172A]">
      {/* Strict 3-Zone Top Bar Contract */}
      <header className="bg-white border-b border-slate-200 px-6 py-3.5 flex items-center justify-between gap-8 sticky top-0 z-30">
        {/* Zone 1: Single text element wordmark */}
        <a
          href="#top"
          onClick={(e) => {
            e.preventDefault();
            setActiveView('workbench');
          }}
          className="text-lg font-bold tracking-tight text-slate-900 whitespace-nowrap shrink-0"
        >
          DENCAL
        </a>

        {/* Zone 2: 4 concise single-line text navigation links */}
        <nav
          aria-label="メインナビゲーション"
          className="flex items-center gap-6 text-sm font-medium text-slate-600 overflow-x-auto"
        >
          <a
            href="#workbench"
            onClick={(e) => {
              e.preventDefault();
              setActiveView('workbench');
            }}
            className={`py-1 transition-colors whitespace-nowrap shrink-0 ${
              activeView === 'workbench'
                ? 'text-teal-800 font-bold underline underline-offset-8 decoration-2 decoration-teal-700'
                : 'hover:text-slate-900'
            }`}
          >
            外来カルテ診療
          </a>
          <a
            href="#reception_billing"
            onClick={(e) => {
              e.preventDefault();
              setActiveView('reception_billing');
            }}
            className={`py-1 transition-colors whitespace-nowrap shrink-0 ${
              activeView === 'reception_billing'
                ? 'text-teal-800 font-bold underline underline-offset-8 decoration-2 decoration-teal-700'
                : 'hover:text-slate-900'
            }`}
          >
            受付・会計算定
          </a>
          <a
            href="#backup_dr"
            onClick={(e) => {
              e.preventDefault();
              setActiveView('backup_dr');
            }}
            className={`py-1 transition-colors whitespace-nowrap shrink-0 ${
              activeView === 'backup_dr'
                ? 'text-teal-800 font-bold underline underline-offset-8 decoration-2 decoration-teal-700'
                : 'hover:text-slate-900'
            }`}
          >
            バックアップ・保存性
          </a>
          <a
            href="#security_audit"
            onClick={(e) => {
              e.preventDefault();
              setActiveView('security_audit');
            }}
            className={`py-1 transition-colors whitespace-nowrap shrink-0 ${
              activeView === 'security_audit'
                ? 'text-teal-800 font-bold underline underline-offset-8 decoration-2 decoration-teal-700'
                : 'hover:text-slate-900'
            }`}
          >
            安全管理・監査証跡
          </a>
        </nav>

        {/* Zone 3: 1 primary action */}
        <div className="flex items-center gap-3 shrink-0">
          <button
            type="button"
            onClick={() => setIsScreenLocked(true)}
            className="px-4 py-2 text-xs font-semibold text-white bg-slate-900 rounded-lg hover:bg-slate-800 transition-colors whitespace-nowrap shrink-0"
          >
            離席ロック ({currentStaff.name})
          </button>
        </div>
      </header>

      {/* Sub-header Clinic Context & Role Switcher Strip */}
      <div className="bg-slate-100/90 border-b border-slate-200 px-6 py-2 flex flex-wrap items-center justify-between gap-3 text-xs text-slate-600">
        <div className="flex flex-wrap items-center gap-2 tabular-nums">
          <span className="font-semibold text-slate-800">{CLINIC_INFO.name}</span>
          <span aria-hidden="true">·</span>
          <span className="font-mono">医療機関コード {CLINIC_INFO.facilityCode}</span>
          <span aria-hidden="true">·</span>
          <span>院内オンプレミス閉域網運用</span>
          <span aria-hidden="true">·</span>
          <span className="text-teal-800 font-medium">
            操作デモ · 架空データ専用 · 実務利用不可
          </span>
        </div>

        <div className="flex items-center gap-2">
          <label htmlFor="quick-role-select" className="text-slate-600 font-medium">
            デモ職種切替：
          </label>
          <select
            id="quick-role-select"
            value={currentStaff.id}
            onChange={(e) => {
              const found = STAFF_MEMBERS.find((s) => s.id === e.target.value);
              if (found) handleSwitchStaff(found);
            }}
            className="px-2.5 py-1 text-xs bg-white border border-slate-300 rounded font-medium text-slate-900"
          >
            {STAFF_MEMBERS.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name} — {s.roleLabel}
              </option>
            ))}
          </select>
        </div>
      </div>

      {/* Main Content Workspace */}
      <main className="flex-1 max-w-[1440px] w-full mx-auto px-4 sm:px-6 py-5">
        {activeView === 'workbench' && (
          <ClinicalWorkbench
            patients={patients}
            selectedPatientId={selectedPatientId}
            currentStaff={currentStaff}
            onSelectPatient={handleSelectPatient}
            onUpdateSoap={handleUpdateSoap}
            onAddPrescription={handleAddPrescription}
            onRemovePrescription={handleRemovePrescription}
            onToggleLabOrder={handleToggleLabOrder}
            onSignAndFinalizeChart={handleSignAndFinalizeChart}
            onAddVitalSign={handleAddVitalSign}
            onAddAllergy={handleAddAllergy}
            onOpenNewPatientModal={() => setIsNewPatientModalOpen(true)}
            onNavigateToBilling={(ptId) => {
              setSelectedPatientId(ptId);
              setActiveView('reception_billing');
            }}
            onRecordDocumentExport={(ptId, docTitle) => {
              const pt = patients.find((p) => p.id === ptId);
              appendAuditLog('DOCUMENT_EXPORT', docTitle, pt ? { id: pt.id, name: pt.kanjiName } : undefined);
            }}
          />
        )}

        {activeView === 'reception_billing' && (
          <ReceptionBillingView
            patients={patients}
            selectedPatientId={selectedPatientId}
            currentStaff={currentStaff}
            onSelectPatient={handleSelectPatient}
            onOpenNewPatientModal={() => setIsNewPatientModalOpen(true)}
            onCompleteBilling={handleCompleteBilling}
            onNavigateToChart={(ptId) => {
              setSelectedPatientId(ptId);
              setActiveView('workbench');
            }}
          />
        )}

        {activeView === 'backup_dr' && (
          <BackupPreservationView
            backups={backups}
            patients={patients}
            currentStaff={currentStaff}
            onCreateSnapshot={handleCreateSnapshot}
            onVerifySnapshot={handleVerifySnapshot}
            onRestoreSnapshot={handleRestoreSnapshot}
            onExportJsonArchive={handleExportJsonArchive}
          />
        )}

        {activeView === 'security_audit' && (
          <SecurityComplianceView
            currentStaff={currentStaff}
            auditLogs={auditLogs}
            autoLockMinutes={autoLockMinutes}
            onSwitchStaff={handleSwitchStaff}
            onChangeAutoLockMinutes={setAutoLockMinutes}
            onTriggerLockScreen={() => setIsScreenLocked(true)}
          />
        )}
      </main>

      {/* Quiet Footer */}
      <footer className="bg-white border-t border-slate-200 px-6 py-3 text-xs text-slate-500 flex flex-wrap items-center justify-between gap-2">
        <div>
          {CLINIC_INFO.name} · {CLINIC_INFO.address} · {CLINIC_INFO.director}
        </div>
        <div className="tabular-nums">
          院内向け試作 · 画面の変更はこのタブ内だけに保持されます
        </div>
      </footer>

      {/* New Patient Registration Modal */}
      <NewPatientModal
        isOpen={isNewPatientModalOpen}
        existingCount={patients.length}
        onClose={() => setIsNewPatientModalOpen(false)}
        onRegisterPatient={handleRegisterNewPatient}
      />

      {/* Clear-Screen Session Lock Modal (物理的・技術的安全管理措置) */}
      {isScreenLocked && (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="lock-screen-title"
          className="fixed inset-0 z-50 bg-slate-900/95 backdrop-blur-xs flex items-center justify-center p-4"
        >
          <div className="bg-white border border-slate-200 rounded-lg max-w-md w-full p-6 space-y-4 text-center">
            <div className="w-10 h-10 rounded-full bg-teal-50 border border-teal-200 text-teal-800 flex items-center justify-center mx-auto">
              <Lock className="w-5 h-5" />
            </div>
            <div>
              <h2 id="lock-screen-title" className="text-base font-bold text-slate-900">
                離席時クリアスクリーン保護（画面ロック中）
              </h2>
              <p className="text-xs text-slate-500 mt-1">
                離席時の画面遷移を確認するデモです。職員認証とは連携していません。
              </p>
            </div>

            <div className="p-3 bg-slate-50 border border-slate-200 rounded text-xs text-left space-y-1">
              <div>
                <span className="text-slate-500">ロック中職員：</span>
                <span className="font-semibold text-slate-900">
                  {currentStaff.name} ({currentStaff.roleLabel})
                </span>
              </div>
              <div className="font-mono text-[11px] text-slate-500">
                画面操作確認用のデモPIN　2026
              </div>
            </div>

            <form
              onSubmit={(e) => {
                e.preventDefault();
                if (unlockPin === '2026') {
                  setUnlockPin('');
                  setIsScreenLocked(false);
                }
              }}
              className="space-y-3"
            >
              <input
                type="password"
                aria-label="ロック解除PINコード"
                value={unlockPin}
                onChange={(e) => setUnlockPin(e.target.value)}
                placeholder="PINコードを入力..."
                className="w-full px-3 py-2 text-center font-mono text-sm bg-white border border-slate-300 rounded-md"
              />
              <button
                type="submit"
                className="w-full py-2.5 px-4 text-xs font-semibold text-white bg-teal-700 hover:bg-teal-800 rounded-lg flex items-center justify-center gap-1.5"
              >
                <ShieldCheck className="w-4 h-4" />
                デモ画面のロック解除
              </button>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
