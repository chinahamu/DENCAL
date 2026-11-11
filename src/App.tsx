import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  AuditLogEntry,
  BackupSnapshot,
  PatientRecord,
  PatientRegistration,
  SoapContent,
  StaffMember,
} from './types/emr';
import { CLINIC_INFO } from './data/seedData';
import { computePayloadChecksum } from './utils/emrLogic';
import { CatalogAdmin } from './components/CatalogAdmin';
import { ClinicalWorkbench } from './components/ClinicalWorkbench';
import { ReceptionBillingView } from './components/ReceptionBillingView';
import { BackupPreservationView } from './components/BackupPreservationView';
import { SecurityComplianceView } from './components/SecurityComplianceView';
import { NewPatientModal } from './components/NewPatientModal';
import { StaffLogin } from './components/StaffLogin';
import { canPerformAction, type EmrAction } from './utils/permissions';

type MainNavView = 'workbench' | 'reception_billing' | 'backup_dr' | 'security_audit' | 'catalog';

type ClinicalRequest = <T>(path: string, signal: AbortSignal, body?: unknown) => Promise<T>;

function downloadFile(filename: string, content: string, type: string) {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

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

  const clinicalRequest: ClinicalRequest = useCallback(async <T,>(path: string, signal: AbortSignal, body?: unknown) => {
    const response = await fetch('/api/clinical/' + path, body === undefined ? { signal } : {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal,
    });
    if (response.status === 401 && !signal.aborted) setStaff(null);
    if (!response.ok) {
      if (response.status === 403 || response.status === 404) throw new Error('対象の操作または患者へのアクセスが許可されていません。');
      if (response.status === 400) throw new Error('入力内容を確認してください。');
      if (response.status === 409) {
        const { error } = await response.json();
        if (error === 'stale_draft') throw new Error('別の操作で診療録が更新されました。入力内容を控え、診療録を再読込してから編集してください。');
        if (error === 'record_integrity_error') throw new Error('確定版の整合性を確認できないため、診療録を開けません。');
        throw new Error('すでに処理されたか、現在の状態では実行できません。');
      }
      throw new Error('診療データの処理に失敗しました。接続状態を確認してください。');
    }
    return await response.json() as T;
  }, []);

  if (ending) return (
    <main className="p-6">
      <p role="status">{sessionError || 'セッションを終了しています…'}</p>
      {sessionError && <button className="mt-3 underline" onClick={logout}>ログアウトを再試行</button>}
    </main>
  );
  if (loading) return <p role="status" className="p-6">ログイン状態を確認しています…</p>;
  if (!staff) return <StaffLogin onLogin={setStaff} sessionError={sessionError} />;
  return <Workspace key={[staff.id, staff.role, staff.departmentCode].join(':')} currentStaff={staff} onLogout={logout} authorize={authorize} clinicalRequest={clinicalRequest} />;
}

interface WorkspaceProps {
  currentStaff: StaffMember;
  onLogout: () => void;
  authorize: (action: EmrAction) => Promise<boolean>;
  clinicalRequest: ClinicalRequest;
}

function Workspace({ currentStaff, onLogout, authorize, clinicalRequest }: WorkspaceProps) {
  const [activeView, setActiveView] = useState<MainNavView>('workbench');
  const [records, setRecords] = useState<PatientRecord[]>([]);
  const [soapDrafts, setSoapDrafts] = useState<Record<string, { version: number; patch: Partial<SoapContent> }>>({});
  const versions = useRef(new Map<string, number>());
  const versionedOperations = ['diagnosis', 'prescription', 'remove_prescription', 'lab_order', 'start_correction', 'finalize'];
  const queue = useRef<Promise<unknown>>(Promise.resolve());
  const requests = useRef(new AbortController());
  const [backups, setBackups] = useState<BackupSnapshot[]>([]);
  const [auditLogs, setAuditLogs] = useState<AuditLogEntry[]>([]);
  const [demoAdminLoaded, setDemoAdminLoaded] = useState(false);
  const [loadingPatients, setLoadingPatients] = useState(true);
  const [selectedPatientId, setSelectedPatientId] = useState('');
  const [isNewPatientModalOpen, setIsNewPatientModalOpen] = useState(false);
  const [accessMessage, setAccessMessage] = useState('');
  const can = (action: EmrAction) => canPerformAction(currentStaff.role, action);
  const patients = records.map((patient) => soapDrafts[patient.id]
    ? { ...patient, currentSoap: { ...patient.currentSoap, ...soapDrafts[patient.id].patch } }
    : patient);

  useEffect(() => {
    const controller = new AbortController();
    requests.current = controller;
    const { signal } = controller;
    clinicalRequest<{ patients: PatientRecord[] }>('patients', signal).then(({ patients }) => {
      if (!signal.aborted) {
        versions.current = new Map(patients.map((patient) => [patient.id, patient.draftVersion]));
        setRecords(patients);
      }
    }).catch(() => {
      if (!signal.aborted) setAccessMessage('患者一覧を取得できませんでした。');
    }).finally(() => {
      if (!signal.aborted) setLoadingPatients(false);
    });
    return () => controller.abort();
  }, [clinicalRequest]);

  async function openAdminView(view: 'backup_dr' | 'security_audit' | 'catalog', action: EmrAction) {
    const { signal } = requests.current;
    setAccessMessage('');
    try {
      if (!await authorize(action)) throw new Error();
      if (signal.aborted) return;
      if (view !== 'catalog') {
        const data = await clinicalRequest<{ backups: BackupSnapshot[]; auditLogs: AuditLogEntry[] }>('admin-demo', signal);
        if (signal.aborted) return;
        if (!demoAdminLoaded) {
          setBackups(data.backups);
          setDemoAdminLoaded(true);
        }
        setAuditLogs((previous) => [...previous.filter((entry) => entry.id.startsWith('AUD-LOCAL-')), ...data.auditLogs]);
      }
      setActiveView(view);
    } catch {
      if (!signal.aborted) setAccessMessage('この画面を開けません。職種の権限と接続状態を確認してください。');
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
      id: `AUD-LOCAL-${crypto.randomUUID()}`,
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

  function enqueue<T>(request: (signal: AbortSignal) => Promise<T>): Promise<T | null> {
    const { signal } = requests.current;
    const task = queue.current.then(async () => {
      if (signal.aborted) return null;
      try {
        return await request(signal);
      } catch (error) {
        if (!signal.aborted) {
          setAccessMessage(error instanceof Error ? error.message : '診療データの処理に失敗しました。');
        }
        return null;
      }
    });
    queue.current = task;
    return task;
  }

  function savePatient(patient: PatientRecord) {
    versions.current.set(patient.id, patient.draftVersion);
    setRecords((previous) => previous.some((entry) => entry.id === patient.id)
      ? previous.map((entry) => entry.id === patient.id ? patient : entry)
      : [patient, ...previous]);
  }

  function removeLocalDraft(previous: typeof soapDrafts, patientId: string) {
    const next = { ...previous };
    delete next[patientId];
    return next;
  }

  async function reloadPatient(patientId: string, discardDraft = false) {
    return Boolean(await enqueue(async (signal) => {
      const { patient } = await clinicalRequest<{ patient: PatientRecord }>('patients/' + patientId, signal);
      savePatient(patient);
      if (discardDraft) setSoapDrafts((previous) => removeLocalDraft(previous, patientId));
      setAccessMessage('');
      return true;
    }));
  }

  function handleSelectPatient(patientId: string) {
    setSelectedPatientId(patientId);
    if (!soapDrafts[patientId]) void reloadPatient(patientId);
  }

  async function changePatient(patientId: string, operation: string, body: unknown): Promise<boolean> {
    const expectedVersion = versions.current.get(patientId);
    return Boolean(await enqueue(async (signal) => {
      const versioned = versionedOperations.includes(operation);
      const input = versioned ? { expectedVersion, data: body } : body;
      const { patient } = await clinicalRequest<{ patient: PatientRecord }>(`patients/${patientId}/${operation}`, signal, input);
      savePatient(patient);
      if (versioned) {
        setSoapDrafts((previous) => previous[patientId]?.version === expectedVersion
          ? { ...previous, [patientId]: { ...previous[patientId], version: patient.draftVersion } }
          : previous);
      }
      setAccessMessage('');
      return true;
    }));
  }

  function handleUpdateSoap(patientId: string, patch: Partial<SoapContent>) {
    const version = versions.current.get(patientId);
    if (version === undefined) return;
    setSoapDrafts((previous) => ({
      ...previous, [patientId]: { version: previous[patientId]?.version ?? version, patch: { ...previous[patientId]?.patch, ...patch } },
    }));
  }

  async function handleSaveSoap(patientId: string) {
    const draft = soapDrafts[patientId];
    if (!draft) return false;
    return Boolean(await enqueue(async (signal) => {
      const { patient } = await clinicalRequest<{ patient: PatientRecord }>(`patients/${patientId}/soap`, signal, {
        expectedVersion: draft.version, data: draft.patch,
      });
      savePatient(patient);
      setSoapDrafts((previous) => previous[patientId] === draft
        ? removeLocalDraft(previous, patientId)
        : previous);
      setAccessMessage('');
      return true;
    }));
  }

  async function handleRegisterNewPatient(input: PatientRegistration): Promise<boolean> {
    return Boolean(await enqueue(async (signal) => {
      const { patient } = await clinicalRequest<{ patient: PatientRecord }>('patients', signal, input);
      savePatient(patient);
      setSelectedPatientId(patient.id);
      return true;
    }));
  }

  async function handleReferralExport(patientId: string, hospital: string, purpose: string): Promise<boolean> {
    return Boolean(await enqueue(async (signal) => {
      const { filename, content } = await clinicalRequest<{ filename: string; content: string }>(
        `patients/${patientId}/referral`, signal, { hospital, purpose },
      );
      if (signal.aborted) return false;
      downloadFile(filename, content, 'text/plain; charset=utf-8');
      return true;
    }));
  }

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

  function handleExportJsonArchive() {
    void enqueue(async (signal) => {
      const payload = await clinicalRequest<Record<string, unknown>>('archive', signal);
      if (!signal.aborted) {
        downloadFile('dencal-demo-archive.json', JSON.stringify({ ...payload, backupsCount: backups.length }, null, 2), 'application/json');
      }
    });
  }

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
          {can('manage_catalog') && (
            <button type="button" onClick={() => void openAdminView('catalog', 'manage_catalog')}
              className={`py-1 whitespace-nowrap shrink-0 ${activeView === 'catalog' ? 'font-bold text-teal-800' : 'hover:text-slate-900'}`}>
              マスター管理
            </button>
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
        {loadingPatients && <p role="status">患者一覧を取得しています…</p>}
        {!loadingPatients && patients.length === 0 && ['workbench', 'reception_billing'].includes(activeView) && (
          <div className="space-y-3">
            <p>閲覧できる患者がいません。</p>
            {(currentStaff.departmentCode || currentStaff.role === 'admin') && (
              <button type="button" className="underline" onClick={() => setIsNewPatientModalOpen(true)}>新規患者登録</button>
            )}
          </div>
        )}
        {activeView === 'workbench' && (
          <ClinicalWorkbench
            patients={patients}
            selectedPatientId={selectedPatientId}
            currentStaff={currentStaff}
            onSelectPatient={handleSelectPatient}
            onUpdateSoap={handleUpdateSoap}
            onSaveSoap={handleSaveSoap}
            hasUnsavedSoap={(id) => Boolean(soapDrafts[id])}
            onReloadPatient={(id) => reloadPatient(id, true)}
            onStartCorrection={(id, reason) => changePatient(id, 'start_correction', { reason })}
            onToggleDiagnosis={(id, item) => changePatient(id, 'diagnosis', item)}
            onAddPrescription={(id, item) => changePatient(id, 'prescription', item)}
            onRemovePrescription={(id, prescriptionId) => changePatient(id, 'remove_prescription', { id: prescriptionId })}
            onToggleLabOrder={(id, item) => changePatient(id, 'lab_order', item)}
            onSignAndFinalizeChart={(id) => changePatient(id, 'finalize', {})}
            onAddVitalSign={(id, item) => changePatient(id, 'vitals', item)}
            onAddAllergy={(id, item) => changePatient(id, 'allergy', item)}
            onOpenNewPatientModal={() => setIsNewPatientModalOpen(true)}
            onNavigateToBilling={(ptId) => {
              setSelectedPatientId(ptId);
              setActiveView('reception_billing');
            }}
            onExportReferral={handleReferralExport}
          />
        )}

        {activeView === 'reception_billing' && (
          <ReceptionBillingView
            patients={patients}
            selectedPatientId={selectedPatientId}
            currentStaff={currentStaff}
            onSelectPatient={handleSelectPatient}
            onOpenNewPatientModal={() => setIsNewPatientModalOpen(true)}
            onCompleteBilling={(id) => changePatient(id, 'settle', {})}
            onNavigateToChart={(ptId) => {
              setSelectedPatientId(ptId);
              setActiveView('workbench');
            }}
          />
        )}

        {activeView === 'catalog' && can('manage_catalog') && <CatalogAdmin />}

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
          院内向け試作 · 保存・確定済みの診療録はSQLiteに保存されます
        </div>
      </footer>

      {/* New Patient Registration Modal */}
      <NewPatientModal
        isOpen={isNewPatientModalOpen}
        onClose={() => setIsNewPatientModalOpen(false)}
        onRegisterPatient={handleRegisterNewPatient}
      />

    </div>
  );
}
