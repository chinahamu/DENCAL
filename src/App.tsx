import React, { useEffect, useState } from 'react';
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
} from './data/seedData';
import { computePayloadChecksum, computeRecordHash } from './utils/emrLogic';
import { ClinicalWorkbench } from './components/ClinicalWorkbench';
import { ReceptionBillingView } from './components/ReceptionBillingView';
import { BackupPreservationView } from './components/BackupPreservationView';
import { SecurityComplianceView } from './components/SecurityComplianceView';
import { NewPatientModal } from './components/NewPatientModal';
import { StaffLogin } from './components/StaffLogin';
import { canPerformAction, type EmrAction } from './utils/permissions';

type MainNavView = 'workbench' | 'reception_billing' | 'backup_dr' | 'security_audit';

export default function App() {
  const [staff, setStaff] = useState<StaffMember | null>(null);
  const [loading, setLoading] = useState(true);
  const [ending, setEnding] = useState(false);
  const [sessionError, setSessionError] = useState('');

  useEffect(() => {
    if (ending) return;
    let active = true;
    let checking = false;
    async function checkSession() {
      if (checking) return;
      checking = true;
      try {
        const response = await fetch('/api/session');
        const next = response.ok ? (await response.json()).staff as StaffMember : null;
        if (!active) return;
        setStaff(next);
        setSessionError(response.ok || response.status === 401 ? '' : 'DBの初期化と起動状態を確認してください。');
      } catch {
        if (!active) return;
        setStaff(null);
        setSessionError('認証サーバーに接続できません。');
      } finally {
        checking = false;
        if (active) setLoading(false);
      }
    }
    void checkSession();
    const timer = window.setInterval(checkSession, 30_000);
    window.addEventListener('focus', checkSession);
    return () => {
      active = false;
      window.clearInterval(timer);
      window.removeEventListener('focus', checkSession);
    };
  }, [ending, staff?.id]);

  async function logout() {
    setEnding(true);
    setStaff(null);
    setSessionError('');
    try {
      const response = await fetch('/api/logout', { method: 'POST' });
      if (!response.ok) throw new Error('Logout failed');
      setEnding(false);
    } catch {
      setSessionError('ログアウトを確認できません。通信状態を確認して再試行してください。');
    }
  }

  async function authorize(action: EmrAction) {
    try {
      const response = await fetch('/api/access/' + action);
      if (response.status === 401) setStaff(null);
      return response.ok;
    } catch {
      return false;
    }
  }

  if (ending) return (
    <main className="p-6">
      <p role="status">{sessionError || 'セッションを終了しています…'}</p>
      {sessionError && <button className="mt-3 underline" onClick={logout}>ログアウトを再試行</button>}
    </main>
  );
  if (loading) return <p role="status" className="p-6">ログイン状態を確認しています…</p>;
  if (!staff) return <StaffLogin onLogin={setStaff} sessionError={sessionError} />;
  return <Workspace key={staff.id + ':' + staff.role} currentStaff={staff} onLogout={logout} authorize={authorize} />;
}

interface WorkspaceProps {
  currentStaff: StaffMember;
  onLogout: () => void;
  authorize: (action: EmrAction) => Promise<boolean>;
}

function Workspace({ currentStaff, onLogout, authorize }: WorkspaceProps) {
  const [activeView, setActiveView] = useState<MainNavView>('workbench');
  const [patients, setPatients] = useState<PatientRecord[]>(INITIAL_PATIENTS);
  const [backups, setBackups] = useState<BackupSnapshot[]>(INITIAL_BACKUPS);
  const [auditLogs, setAuditLogs] = useState<AuditLogEntry[]>(INITIAL_AUDIT_LOGS);

  const [selectedPatientId, setSelectedPatientId] = useState<string>(INITIAL_PATIENTS[0].id);
  const [isNewPatientModalOpen, setIsNewPatientModalOpen] = useState(false);
  const [accessMessage, setAccessMessage] = useState('');
  const can = (action: EmrAction) => canPerformAction(currentStaff.role, action);

  async function openAdminView(view: 'backup_dr' | 'security_audit', action: EmrAction) {
    setAccessMessage('');
    if (await authorize(action)) {
      setActiveView(view);
    } else {
      setAccessMessage('この画面を開けません。職種の権限と接続状態を確認してください。');
    }
  }

  const appendAuditLog = (
    actionType: AuditLogEntry['actionType'],
    summary: string,
    targetPatient?: { id: string; name: string }
  ) => {
    const actor = currentStaff;
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
    if (!can('edit_soap')) return;
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
    if (!can('add_prescription')) return;
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
    if (!can('add_prescription')) return;
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
    if (!can('add_prescription')) return;
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
    if (!can('sign_soap')) return;
    const now = new Date();
    const ts = `2026-11-09 ${now.toTimeString().slice(0, 8)}`;
    const hpkiId = currentStaff.hpkiCertId || 'DEMO-SIGNATURE';

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
    if (!can('record_vitals')) return;
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
    if (!can('record_vitals')) return;
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
    if (!can('register_patient')) return;
    setPatients((prev) => [newPatient, ...prev]);
    setSelectedPatientId(newPatient.id);
    appendAuditLog(
      'PATIENT_REGISTER',
      `新規来院受付・第1号カルテ開設 (受付番号 ${newPatient.receptionNumber} / ${newPatient.insuranceType})`,
      { id: newPatient.id, name: newPatient.kanjiName }
    );
  };

  const handleCompleteBilling = (patientId: string) => {
    if (!can('settle_billing')) return;
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
    if (!can('create_backup')) return;
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
    if (!can('create_backup')) return;
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
    if (!can('restore_backup')) return;
    appendAuditLog(
      'BACKUP_RESTORE',
      `バックアップ世代 ${backupId} からのポイントインタイム・リストア検証を実行`
    );
  };

  const handleExportJsonArchive = () => {
    if (!can('create_backup')) return;
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
          {can('create_backup') && (
            <a
              href="#backup_dr"
              onClick={(e) => {
                e.preventDefault();
                void openAdminView('backup_dr', 'create_backup');
              }}
              className={`py-1 transition-colors whitespace-nowrap shrink-0 ${
                activeView === 'backup_dr'
                  ? 'text-teal-800 font-bold underline underline-offset-8 decoration-2 decoration-teal-700'
                  : 'hover:text-slate-900'
              }`}
            >
              バックアップ・保存性
            </a>
          )}
          {can('view_audit') && (
            <a
              href="#security_audit"
              onClick={(e) => {
                e.preventDefault();
                void openAdminView('security_audit', 'view_audit');
              }}
              className={`py-1 transition-colors whitespace-nowrap shrink-0 ${
                activeView === 'security_audit'
                  ? 'text-teal-800 font-bold underline underline-offset-8 decoration-2 decoration-teal-700'
                  : 'hover:text-slate-900'
              }`}
            >
              安全管理・監査証跡
            </a>
          )}
        </nav>

        {/* Zone 3: 1 primary action */}
        <div className="flex items-center gap-3 shrink-0">
          <button
            type="button"
            onClick={onLogout}
            className="px-4 py-2 text-xs font-semibold text-white bg-slate-900 rounded-lg hover:bg-slate-800 transition-colors whitespace-nowrap shrink-0"
          >
            ログアウト・離席 ({currentStaff.name})
          </button>
        </div>
      </header>

      {/* Sub-header Clinic Context & Staff */}
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

        <p>ログイン中　{currentStaff.name}（{currentStaff.roleLabel}）</p>
      </div>

      {/* Main Content Workspace */}
      <main className="flex-1 max-w-[1440px] w-full mx-auto px-4 sm:px-6 py-5">
        {accessMessage && <p role="alert" className="mb-4 text-sm text-red-700">{accessMessage}</p>}
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

        {activeView === 'backup_dr' && can('create_backup') && (
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

        {activeView === 'security_audit' && can('view_audit') && (
          <SecurityComplianceView
            currentStaff={currentStaff}
            auditLogs={auditLogs}
            onTriggerLockScreen={onLogout}
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

    </div>
  );
}
