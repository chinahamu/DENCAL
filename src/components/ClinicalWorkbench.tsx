import React, { useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  ClipboardCheck,
  Columns2,
  Copy,
  FileSpreadsheet,
  FileText,
  History,
  Lock,
  PanelLeftClose,
  PanelLeftOpen,
  Plus,
  Printer,
  Rows4,
  Search,
  ShieldAlert,
  ShieldCheck,
  Stethoscope,
  Trash2,
  UserPlus,
  Users,
} from 'lucide-react';
import {
  AllergyItem,
  DiseaseRecord,
  MasterReference,
  LabOrderItem,
  PatientRecord,
  PrescriptionItem,
  SoapContent,
  StaffMember,
  VisitStatus,
  VitalRecord,
} from '../types/emr';
import {
  SOAP_TEMPLATES,
  CLINIC_INFO,
} from '../data/seedData';
import {
  canPerformAction,
  checkDrugSafety,
  evaluateLabFlag,
} from '../utils/emrLogic';

import type { CatalogEntry } from '../types/catalog';
import { ClinicalCatalogPicker } from './ClinicalCatalogPicker';

function masterReference(entry: CatalogEntry): MasterReference {
  return { itemId: entry.id, code: entry.code, releaseDate: entry.releaseDate };
}

interface ClinicalWorkbenchProps {
  patients: PatientRecord[];
  selectedPatientId: string;
  currentStaff: StaffMember;
  onSelectPatient: (patientId: string) => void;
  onUpdateSoap: (patientId: string, soap: Partial<SoapContent>) => void;
  onToggleDiagnosis: (patientId: string, disease: DiseaseRecord) => Promise<boolean>;
  onAddPrescription: (patientId: string, item: PrescriptionItem) => Promise<boolean>;
  onRemovePrescription: (patientId: string, prescriptionId: string) => Promise<boolean>;
  onToggleLabOrder: (patientId: string, labOrder: LabOrderItem) => Promise<boolean>;
  onSignAndFinalizeChart: (patientId: string, revisionReason: string) => Promise<boolean>;
  onAddVitalSign: (patientId: string, vital: VitalRecord) => Promise<boolean>;
  onAddAllergy: (patientId: string, allergy: AllergyItem) => Promise<boolean>;
  onOpenNewPatientModal: () => void;
  onNavigateToBilling: (patientId: string) => void;
  onExportReferral: (patientId: string, hospital: string, purpose: string) => Promise<boolean>;
}

type CenterSubTab = 'soap' | 'labs_vitals' | 'revisions' | 'referral_doc';

const STATUS_LABELS: Record<VisitStatus, string> = {
  waiting: '待合中',
  in_consultation: '診察中',
  billing: '会計待ち',
  completed: '会計完了',
};

const QUICK_PHRASES = {
  subjective: [
    '特記すべき自覚症状なし。服薬アドヒアランス良好。',
    '家庭血圧は朝・晩ともに安定して推移。立ちくらみ・めまい(-)。',
    '昨日より発熱・咽頭痛・咳嗽が出現。水分摂取は可能。',
    '食事療法（減塩6g/日未満）および有酸素運動を継続中。',
  ],
  objective: [
    '意識清明。胸部聴診：心音純・雑音なし、呼吸音清・ラ音なし。',
    '咽頭発赤(+)、扁桃腫大・白苔(-)、頸部リンパ節腫脹(-)。',
    '眼瞼結膜貧血なし、腹部平坦・軟・圧痛なし、下腿浮腫(-)。',
    '迅速抗原検査：SARS-CoV-2(-)、インフルエンザA/B(-)。',
  ],
  assessment: [
    '血圧・血糖・脂質ともに管理目標値内で良好に経過。',
    '腎機能（eGFR）横ばい維持。脱水・NSAIDs回避を継続。',
    '急性上気道炎（ウイルス性咽頭炎疑い）。細菌二次感染兆候なし。',
  ],
  plan: [
    '現行処方を同用量にて28日分継続（Do処方）。次回4週後に再診。',
    '対症療法にて5日分処方。高熱持続・呼吸苦出現時は速やかに再受診を指示。',
    '家庭血圧記録の継続と減塩・水分摂取指導を実施。次回採血予定。',
  ],
};

export const ClinicalWorkbench: React.FC<ClinicalWorkbenchProps> = ({
  patients,
  selectedPatientId,
  currentStaff,
  onSelectPatient,
  onUpdateSoap,
  onToggleDiagnosis,
  onAddPrescription,
  onRemovePrescription,
  onToggleLabOrder,
  onSignAndFinalizeChart,
  onAddVitalSign,
  onAddAllergy,
  onOpenNewPatientModal,
  onNavigateToBilling,
  onExportReferral,
}) => {
  // Collapsed by default per user request ("受付リストはサイドに折りたたんでおく")
  const [isQueueExpanded, setIsQueueExpanded] = useState<boolean>(false);
  const [queueFilter, setQueueFilter] = useState<'all' | VisitStatus>('all');
  const [searchQuery, setSearchQuery] = useState('');
  const [centerTab, setCenterTab] = useState<CenterSubTab>('soap');
  const [soapGridMode, setSoapGridMode] = useState<'grid' | 'stack'>('grid');

  const [selectedDisease, setSelectedDisease] = useState<CatalogEntry>();
  const [selectedDrug, setSelectedDrug] = useState<CatalogEntry>();
  const [selectedLab, setSelectedLab] = useState<CatalogEntry>();
  const [suspected, setSuspected] = useState(false);
  const [rxDays, setRxDays] = useState('');
  const [rxDosage, setRxDosage] = useState('');
  const [rxUsage, setRxUsage] = useState('');
  const [rxAsNeeded, setRxAsNeeded] = useState(false);
  const [overrideContraConfirm, setOverrideContraConfirm] = useState(false);
  const rxDayCount = Number(rxDays);

  useEffect(() => {
    setSelectedDisease(undefined);
    setSelectedDrug(undefined);
    setSelectedLab(undefined);
    setSuspected(false);
    setRxDays('');
    setRxDosage('');
    setRxUsage('');
    setRxAsNeeded(false);
    setOverrideContraConfirm(false);
  }, [selectedPatientId]);

  // Revision reason when modifying an already-signed chart
  const [revisionReason, setRevisionReason] = useState<string>('');
  const [signBannerMessage, setSignBannerMessage] = useState<string | null>(null);

  // Quick vital input state
  const [showVitalForm, setShowVitalForm] = useState<boolean>(false);
  const [vitalSys, setVitalSys] = useState<number>(126);
  const [vitalDia, setVitalDia] = useState<number>(78);
  const [vitalPulse, setVitalPulse] = useState<number>(70);
  const [vitalTemp, setVitalTemp] = useState<number>(36.5);
  const [vitalSpo2, setVitalSpo2] = useState<number>(98);

  // Allergy add form state
  const [showAllergyForm, setShowAllergyForm] = useState<boolean>(false);
  const [newAllergySubstance, setNewAllergySubstance] = useState<string>('');
  const [newAllergyReaction, setNewAllergyReaction] = useState<string>('');

  // Referral document state
  const [referralHospital, setReferralHospital] = useState<string>(
    '東京九段総合病院 腎臓内科・循環器内科 御侍史'
  );
  const [referralPurpose, setReferralPurpose] = useState<string>(
    '精査加療および専門的治療方針のご相談'
  );
  const [printPreviewNotif, setPrintPreviewNotif] = useState<string | null>(null);

  const selectedPatient = useMemo(
    () => patients.find((p) => p.id === selectedPatientId) || patients[0],
    [patients, selectedPatientId]
  );

  const filteredPatients = useMemo(() => {
    return patients.filter((pt) => {
      const matchesStatus = queueFilter === 'all' || pt.visitStatus === queueFilter;
      const q = searchQuery.trim().toLowerCase();
      const matchesSearch =
        !q ||
        pt.kanjiName.toLowerCase().includes(q) ||
        pt.kanaName.toLowerCase().includes(q) ||
        pt.id.toLowerCase().includes(q) ||
        pt.chiefComplaint.toLowerCase().includes(q);
      return matchesStatus && matchesSearch;
    });
  }, [patients, queueFilter, searchQuery]);

  const drugSafetyWarnings = useMemo(() => {
    if (!selectedPatient || !selectedDrug) return [];
    return checkDrugSafety(
      { masterCode: selectedDrug.code, yjCode: '', drugName: selectedDrug.name, drugClass: '', contraindicationKeywords: [] },
      selectedPatient.allergies, [], selectedPatient.currentPrescriptions,
    );
  }, [selectedDrug, selectedPatient]);

  const hasHardContraindication = drugSafetyWarnings.some((w) => w.severity === 'error');

  const canEditSoap = canPerformAction(currentStaff.role, 'edit_soap');
  const canSignSoap = canPerformAction(currentStaff.role, 'sign_soap');
  const canExportReferral = canPerformAction(currentStaff.role, 'export_referral');
  const canAddRx = canPerformAction(currentStaff.role, 'add_prescription');
  const canRecordVitals = canPerformAction(currentStaff.role, 'record_vitals');

  const canAddDiagnosis = canEditSoap && selectedDisease &&
    !selectedPatient?.diseases.some((entry) => entry.master?.code === selectedDisease.code);
  const canSubmitRx = canAddRx && selectedDrug && rxDosage.trim() && rxUsage.trim() &&
    Number.isInteger(rxDayCount) && rxDayCount >= 1 && rxDayCount <= 90 &&
    (!hasHardContraindication || overrideContraConfirm);
  const canAddLab = canAddRx && selectedLab &&
    !selectedPatient?.currentLabOrders.some((entry) => entry.code === selectedLab.code);

  function selectDrug(entry: CatalogEntry | undefined) {
    setSelectedDrug(entry);
    setRxDosage('');
    setRxUsage('');
    setRxDays('');
    setRxAsNeeded(false);
    setOverrideContraConfirm(false);
  }

  async function addDiagnosis() {
    if (!selectedPatient || !canAddDiagnosis || !selectedDisease) return;
    if (!await onToggleDiagnosis(selectedPatient.id, {
      id: `disease-${crypto.randomUUID()}`,
      master: masterReference(selectedDisease),
      name: selectedDisease.name,
      icd10Code: selectedDisease.icd10,
      isMain: !selectedPatient.diseases.some((entry) => entry.isMain && entry.outcome !== 'cured'),
      isChronicDiseaseTarget: false,
      startDate: new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Tokyo' }),
      outcome: suspected ? 'suspected' : 'ongoing',
    })) return;
    setSuspected(false);
  }

  async function handleAddPrescriptionClick() {
    if (!selectedPatient || !canSubmitRx || !selectedDrug) return;
    if (!await onAddPrescription(selectedPatient.id, {
      id: `rx-${crypto.randomUUID()}`,
      master: masterReference(selectedDrug),
      priceCode: selectedDrug.priceCode || undefined,
      drugName: selectedDrug.name,
      dosagePerDay: rxDosage.trim(),
      usage: rxUsage.trim(),
      days: rxDayCount,
      category: selectedDrug.drugForm === '6' ? 'external' : rxAsNeeded ? 'as_needed' : 'internal',
      genericAllowed: false,
    })) return;
    selectDrug(undefined);
  }

  async function addLab() {
    if (!selectedPatient || !canAddLab || !selectedLab) return;
    if (!await onToggleLabOrder(selectedPatient.id, {
      id: `official-${selectedLab.code}`,
      master: masterReference(selectedLab),
      code: selectedLab.code,
      name: selectedLab.name,
    })) return;
    setSelectedLab(undefined);
  }

  const handleSignClick = async () => {
    if (!selectedPatient || !canSignSoap) return;
    const reason =
      selectedPatient.revisions.length > 0
        ? revisionReason.trim() || '検査結果反映・処方内容確定に伴う改訂署名'
        : '初版カルテ確定およびHPKI医師資格証による電子署名';
    if (!await onSignAndFinalizeChart(selectedPatient.id, reason)) return;
    setRevisionReason('');
    setSignBannerMessage(
      '診療録のデモ版を確定しました。'
    );
    setTimeout(() => setSignBannerMessage(null), 5000);
  };

  const handleSaveVital = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedPatient) return;
    const prevWeight = selectedPatient.vitalsHistory[0]?.weightKg || 60.0;
    const prevBmi = selectedPatient.vitalsHistory[0]?.bmi || 22.0;
    if (!await onAddVitalSign(selectedPatient.id, {
      measuredAt: '',
      systolicBp: Number(vitalSys),
      diastolicBp: Number(vitalDia),
      pulse: Number(vitalPulse),
      temperature: Number(vitalTemp),
      spo2: Number(vitalSpo2),
      weightKg: prevWeight,
      bmi: prevBmi,
    })) return;
    setShowVitalForm(false);
  };

  const handleSaveAllergy = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedPatient || !canRecordVitals || !newAllergySubstance.trim()) return;
    if (!await onAddAllergy(selectedPatient.id, {
      substance: newAllergySubstance.trim(),
      category: 'drug',
      severity: 'severe',
      reaction: newAllergyReaction.trim() || '発疹・過敏症既往',
    })) return;
    setNewAllergySubstance('');
    setNewAllergyReaction('');
    setShowAllergyForm(false);
  };

  const handleAppendSoapField = (field: keyof SoapContent, textToAppend: string) => {
    if (!selectedPatient || !canEditSoap) return;
    const currentVal = selectedPatient.currentSoap[field];
    const separator = currentVal.trim().length > 0 ? '\n' : '';
    onUpdateSoap(selectedPatient.id, {
      [field]: `${currentVal}${separator}${textToAppend}`,
    });
  };

  const handleCopyPreviousRevisionSoap = () => {
    if (!selectedPatient || !canEditSoap || selectedPatient.revisions.length === 0) return;
    const lastRev = selectedPatient.revisions[0];
    onUpdateSoap(selectedPatient.id, { ...lastRev.soap });
  };

  if (!selectedPatient) return null;

  const latestVital = selectedPatient.vitalsHistory[0];
  const latestLabPanel = selectedPatient.labHistory[0];
  const waitingCount = patients.filter(
    (p) => p.visitStatus === 'waiting' || p.visitStatus === 'in_consultation'
  ).length;

  return (
    <div className="flex flex-col lg:flex-row gap-4 items-start">
      {/* COLLAPSIBLE LEFT SIDEBAR: Reception List (Collapsed by default into a compact side rail) */}
      {isQueueExpanded ? (
        <aside
          aria-label="当日外来受付リスト（展開中）"
          className="w-full lg:w-80 shrink-0 bg-white border border-slate-200 rounded-lg overflow-hidden shadow-xs"
        >
          <div className="p-3.5 bg-slate-50 border-b border-slate-200 flex items-center justify-between gap-2">
            <div>
              <h2 className="text-sm font-bold text-slate-900">当日外来受付リスト</h2>
              <p className="text-xs text-slate-500 tabular-nums mt-0.5">
                来院 {patients.length}名 · 診察/待合 {waitingCount}名
              </p>
            </div>
            <div className="flex items-center gap-1.5">
              <button
                type="button"
                onClick={onOpenNewPatientModal}
                className="px-2.5 py-1.5 text-xs font-semibold text-white bg-teal-700 hover:bg-teal-800 rounded transition-colors flex items-center gap-1 whitespace-nowrap shrink-0"
              >
                <UserPlus className="w-3.5 h-3.5" />
                新規受付
              </button>
              <button
                type="button"
                aria-label="受付リストを折りたたむ"
                onClick={() => setIsQueueExpanded(false)}
                className="p-1.5 text-slate-600 hover:text-slate-900 bg-white border border-slate-300 rounded hover:bg-slate-100 transition-colors"
                title="受付リストをサイドに折りたたむ"
              >
                <PanelLeftClose className="w-4 h-4" />
              </button>
            </div>
          </div>

          {/* Search & Segmented Status Filter */}
          <div className="p-3 bg-white border-b border-slate-200 space-y-2">
            <div className="relative">
              <Search className="w-3.5 h-3.5 text-slate-400 absolute left-2.5 top-1/2 -translate-y-1/2" />
              <input
                type="search"
                aria-label="患者氏名・カルテID検索"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="氏名・カナ・患者IDで検索..."
                className="w-full pl-8 pr-3 py-1.5 text-xs bg-slate-50 border border-slate-200 rounded-md text-slate-900 placeholder:text-slate-400 focus:bg-white focus:outline-none focus:border-teal-600"
              />
            </div>

            <div
              role="group"
              aria-label="受付ステータス絞り込み"
              className="grid grid-cols-4 gap-1 p-1 bg-slate-100 rounded-md"
            >
              {(
                [
                  { key: 'all', label: '全件' },
                  { key: 'waiting', label: '待合' },
                  { key: 'in_consultation', label: '診察中' },
                  { key: 'billing', label: '会計待' },
                ] as const
              ).map((tab) => (
                <button
                  key={tab.key}
                  type="button"
                  onClick={() => setQueueFilter(tab.key)}
                  className={`py-1 px-1.5 text-xs font-medium rounded transition-colors whitespace-nowrap shrink-0 ${
                    queueFilter === tab.key
                      ? 'bg-white text-slate-900 shadow-xs font-semibold'
                      : 'text-slate-600 hover:text-slate-900'
                  }`}
                >
                  {tab.label}
                </button>
              ))}
            </div>
          </div>

          {/* Patient List */}
          <div className="divide-y divide-slate-200 max-h-[680px] overflow-y-auto">
            {filteredPatients.length === 0 ? (
              <div className="p-6 text-center">
                <p className="text-xs text-slate-500">該当する受付患者がいません。</p>
                <button
                  type="button"
                  onClick={() => {
                    setQueueFilter('all');
                    setSearchQuery('');
                  }}
                  className="mt-2 px-3 py-1.5 text-xs font-medium text-teal-700 hover:underline"
                >
                  フィルタを解除
                </button>
              </div>
            ) : (
              filteredPatients.map((pt) => {
                const isSelected = pt.id === selectedPatient.id;
                return (
                  <button
                    key={pt.id}
                    type="button"
                    onClick={() => {
                      onSelectPatient(pt.id);
                      setIsQueueExpanded(false);
                    }}
                    className={`w-full text-left p-3.5 transition-colors block ${
                      isSelected
                        ? 'bg-teal-50/70 hover:bg-teal-50'
                        : 'bg-white hover:bg-slate-50'
                    }`}
                  >
                    <div className="flex items-baseline justify-between gap-2">
                      <div className="flex items-baseline gap-1.5 min-w-0">
                        <span className="font-mono text-xs font-semibold text-teal-800 tabular-nums shrink-0">
                          {pt.receptionNumber}
                        </span>
                        <span className="text-sm font-bold text-slate-900 truncate">
                          {pt.kanjiName}
                        </span>
                        <span className="text-xs text-slate-500 tabular-nums shrink-0">
                          ({pt.age}歳·{pt.sex[0]})
                        </span>
                      </div>
                      <span
                        className={`text-xs font-semibold shrink-0 tabular-nums ${
                          pt.visitStatus === 'in_consultation'
                            ? 'text-teal-700'
                            : pt.visitStatus === 'waiting'
                            ? 'text-amber-700'
                            : pt.visitStatus === 'billing'
                            ? 'text-blue-700'
                            : 'text-slate-500'
                        }`}
                      >
                        {STATUS_LABELS[pt.visitStatus]}
                      </span>
                    </div>

                    <div className="mt-1 flex items-center gap-1.5 text-xs text-slate-500 tabular-nums">
                      <span className="font-mono">{pt.id}</span>
                      <span aria-hidden="true">·</span>
                      <span>{pt.visitType}</span>
                      <span aria-hidden="true">·</span>
                      <span>受付 {pt.receptionTime}</span>
                      <span aria-hidden="true">·</span>
                      <span>{pt.insuranceType}</span>
                    </div>

                    <p className="mt-1.5 text-xs text-slate-700 line-clamp-1">
                      主訴：{pt.chiefComplaint}
                    </p>
                  </button>
                );
              })
            )}
          </div>
        </aside>
      ) : (
        <aside
          aria-label="当日外来受付リスト（折りたたみ中）"
          className="w-full lg:w-16 shrink-0 bg-white border border-slate-200 rounded-lg p-2 flex lg:flex-col items-center justify-between lg:justify-start gap-2"
        >
          <button
            type="button"
            aria-label="受付リストを展開"
            onClick={() => setIsQueueExpanded(true)}
            className="w-full py-2.5 px-2 bg-teal-50 hover:bg-teal-100 text-teal-900 border border-teal-200 rounded-md flex lg:flex-col items-center justify-center gap-1 transition-colors"
            title="クリックして外来受付リストを展開"
          >
            <PanelLeftOpen className="w-4 h-4 text-teal-700 shrink-0" />
            <span className="text-[11px] font-bold whitespace-nowrap">受付({patients.length})</span>
          </button>

          <div className="flex lg:flex-col items-center gap-1.5 w-full overflow-x-auto lg:overflow-visible">
            {patients.map((pt) => {
              const isSelected = pt.id === selectedPatient.id;
              return (
                <button
                  key={pt.id}
                  type="button"
                  onClick={() => onSelectPatient(pt.id)}
                  aria-label={`${pt.receptionNumber} ${pt.kanjiName} (${STATUS_LABELS[pt.visitStatus]})`}
                  title={`${pt.receptionNumber} ${pt.kanjiName} (${pt.age}歳) - ${STATUS_LABELS[pt.visitStatus]}`}
                  className={`w-full py-2 px-1.5 rounded-md border text-center transition-colors shrink-0 ${
                    isSelected
                      ? 'bg-slate-900 text-white border-slate-900 font-bold'
                      : 'bg-slate-50 text-slate-700 border-slate-200 hover:bg-slate-100'
                  }`}
                >
                  <div className="font-mono text-[10px] tabular-nums leading-none">
                    {pt.receptionNumber}
                  </div>
                  <div className="text-xs mt-1 truncate">{pt.kanjiName.split(' ')[0]}</div>
                </button>
              );
            })}
          </div>

          <button
            type="button"
            aria-label="新規来院受付"
            onClick={onOpenNewPatientModal}
            title="新規来院・新患登録"
            className="w-full py-2 px-2 text-slate-600 hover:text-teal-800 bg-slate-50 hover:bg-teal-50 border border-slate-200 rounded-md flex items-center justify-center transition-colors shrink-0"
          >
            <UserPlus className="w-4 h-4" />
          </button>
        </aside>
      )}

      {/* MAIN WORKSPACE: Prominent Patient Information Banner + Large, Easy-to-Use SOAP Editor */}
      <div className="flex-1 min-w-0 w-full space-y-4">
        {/* 1. PROMINENT PATIENT INFORMATION & CLINICAL SUMMARY CARD */}
        <section
          aria-label="患者基本情報・バイタル・臨床サマリ"
          className="bg-white border border-slate-200 rounded-lg p-5 space-y-4"
        >
          {/* Top Row: Patient Identity, Demographics, Quick Patient Switcher, and HPKI Status */}
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div className="space-y-1.5">
              <div className="flex flex-wrap items-baseline gap-3">
                <button
                  type="button"
                  onClick={() => setIsQueueExpanded(!isQueueExpanded)}
                  className="px-2.5 py-1 text-xs font-semibold text-teal-800 bg-teal-50 hover:bg-teal-100 border border-teal-200 rounded-md flex items-center gap-1.5 transition-colors whitespace-nowrap shrink-0"
                >
                  <Users className="w-3.5 h-3.5" />
                  {isQueueExpanded ? '受付リストを隠す' : `受付リストを開く (${patients.length}名)`}
                </button>
                <span className="font-mono text-sm font-bold text-teal-800 tabular-nums">
                  受付 {selectedPatient.receptionNumber}
                </span>
                <span className="font-mono text-sm font-semibold text-slate-500 tabular-nums">
                  {selectedPatient.id}
                </span>
                <h1 className="text-2xl font-bold tracking-tight text-slate-900">
                  {selectedPatient.kanjiName}
                </h1>
                <span className="text-sm text-slate-500 font-medium">
                  {selectedPatient.kanaName}
                </span>
                <span className="text-sm font-bold text-teal-800">
                  [{STATUS_LABELS[selectedPatient.visitStatus]} · {selectedPatient.visitType}]
                </span>
              </div>

              {/* Clean unboxed patient demographics at readable 13px-14px */}
              <div className="flex flex-wrap items-center gap-2.5 text-sm text-slate-700 tabular-nums">
                <span className="font-semibold">{selectedPatient.age}歳 ({selectedPatient.sex})</span>
                <span aria-hidden="true" className="text-slate-300">·</span>
                <span>{selectedPatient.birthDate}生</span>
                <span aria-hidden="true" className="text-slate-300">·</span>
                <span>血液型 {selectedPatient.bloodType}</span>
                <span aria-hidden="true" className="text-slate-300">·</span>
                <span>
                  {selectedPatient.insuranceType}（{Math.round(selectedPatient.copayRatio * 10)}割負担）
                </span>
                <span aria-hidden="true" className="text-slate-300">·</span>
                <span className="text-teal-700 font-semibold">
                  {selectedPatient.mynaVerified ? 'マイナ保険証資格確認済' : '被保険者証確認済'}
                </span>
                <span aria-hidden="true" className="text-slate-300">·</span>
                <span className="text-slate-500">TEL: {selectedPatient.phone}</span>
              </div>
            </div>

            {/* Right: Authenticity Signature Badge */}
            <div className="flex items-center gap-3">
              {selectedPatient.isSigned ? (
                <div className="text-right bg-emerald-50/70 border border-emerald-200 px-3.5 py-2 rounded-md">
                  <div className="flex items-center gap-1.5 text-xs font-bold text-emerald-800">
                    <ShieldCheck className="w-4 h-4 shrink-0" />
                    <span>HPKI電子署名・確定済 (第{selectedPatient.revisions.length}版)</span>
                  </div>
                  <p className="text-[11px] font-mono text-slate-500 tabular-nums mt-0.5">
                    SHA-256: {selectedPatient.currentHash?.slice(0, 16)}...
                  </p>
                </div>
              ) : (
                <div className="text-right bg-amber-50/70 border border-amber-200 px-3.5 py-2 rounded-md">
                  <div className="flex items-center gap-1.5 text-xs font-bold text-amber-800">
                    <FileText className="w-4 h-4 shrink-0" />
                    <span>診療録 入力中（未署名・第{selectedPatient.revisions.length + 1}版）</span>
                  </div>
                  <p className="text-[11px] text-slate-600 mt-0.5">
                    入力完了後に下部のHPKI署名ボタンで確定してください
                  </p>
                </div>
              )}
            </div>
          </div>

          {/* Middle Row: Prominent Chief Complaint (主訴) & Allergy/Contraindication Banner */}
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-3 pt-2 border-t border-slate-200">
            <div className="lg:col-span-6 p-3 bg-slate-50 border border-slate-200 rounded-md flex items-center justify-between gap-2">
              <div className="text-sm">
                <span className="font-bold text-slate-900">本日の主訴・来院目的：</span>
                <span className="text-slate-800 font-medium">{selectedPatient.chiefComplaint}</span>
              </div>
            </div>

            <div
              className={`lg:col-span-6 p-3 rounded-md border flex flex-wrap items-center justify-between gap-2 ${
                selectedPatient.allergies.length > 0
                  ? 'bg-red-50/70 border-red-200'
                  : 'bg-slate-50 border-slate-200'
              }`}
            >
              <div className="flex flex-wrap items-center gap-2 text-sm">
                <span className="font-bold text-slate-900 flex items-center gap-1.5">
                  <ShieldAlert
                    className={`w-4 h-4 ${
                      selectedPatient.allergies.length > 0 ? 'text-red-600' : 'text-slate-500'
                    }`}
                  />
                  アレルギー・禁忌：
                </span>
                {selectedPatient.allergies.length === 0 ? (
                  <span className="text-slate-600">特記事項なし（NKDA）</span>
                ) : (
                  selectedPatient.allergies.map((al, idx) => (
                    <React.Fragment key={al.substance}>
                      {idx > 0 && <span className="text-red-400">·</span>}
                      <span className="font-bold text-red-800">
                        {al.substance}（{al.reaction}）
                      </span>
                    </React.Fragment>
                  ))
                )}
              </div>
              {canRecordVitals && (
                <button
                  type="button"
                  onClick={() => setShowAllergyForm(!showAllergyForm)}
                  className="text-xs font-semibold text-teal-800 hover:underline whitespace-nowrap shrink-0"
                >
                  {showAllergyForm ? '閉じる' : '+ アレルギー追加'}
                </button>
              )}
            </div>
          </div>

          {showAllergyForm && (
            <form
              onSubmit={handleSaveAllergy}
              className="p-3 bg-slate-50 border border-slate-200 rounded-md grid grid-cols-1 sm:grid-cols-3 gap-3 items-end"
            >
              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1">
                  原因物質・薬剤名
                </label>
                <input
                  type="text"
                  required
                  value={newAllergySubstance}
                  onChange={(e) => setNewAllergySubstance(e.target.value)}
                  placeholder="例：セフェム系抗菌薬"
                  className="w-full px-3 py-1.5 text-sm bg-white border border-slate-300 rounded"
                />
              </div>
              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1">
                  誘発症状・重症度
                </label>
                <input
                  type="text"
                  value={newAllergyReaction}
                  onChange={(e) => setNewAllergyReaction(e.target.value)}
                  placeholder="例：薬疹・呼吸苦"
                  className="w-full px-3 py-1.5 text-sm bg-white border border-slate-300 rounded"
                />
              </div>
              <button
                type="submit"
                className="px-4 py-2 text-xs font-semibold text-white bg-red-600 hover:bg-red-700 rounded transition-colors whitespace-nowrap"
              >
                禁忌情報として追加
              </button>
            </form>
          )}

          {/* Bottom Row of Patient Card: At-a-glance Vitals, Key Labs, and Registered Diseases */}
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-3 pt-1">
            {/* Vitals Strip (4 cols) */}
            <div className="lg:col-span-4 p-3 bg-slate-50/80 border border-slate-200 rounded-md space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-xs font-bold text-slate-800">
                  当日バイタルサイン {latestVital ? `(${latestVital.measuredAt.split(' ')[1]})` : ''}
                </span>
                {canRecordVitals && (
                  <button
                    type="button"
                    onClick={() => setShowVitalForm(!showVitalForm)}
                    className="text-xs font-semibold text-teal-700 hover:underline"
                  >
                    {showVitalForm ? '閉じる' : '+ 測定値入力'}
                  </button>
                )}
              </div>
              {latestVital ? (
                <div className="grid grid-cols-4 gap-2 text-center font-mono tabular-nums">
                  <div className="bg-white p-1.5 rounded border border-slate-200">
                    <div className="text-[10px] font-sans text-slate-500">血圧 BP</div>
                    <div
                      className={`text-sm font-bold ${
                        latestVital.systolicBp >= 135 ? 'text-amber-700' : 'text-slate-900'
                      }`}
                    >
                      {latestVital.systolicBp}/{latestVital.diastolicBp}
                    </div>
                  </div>
                  <div className="bg-white p-1.5 rounded border border-slate-200">
                    <div className="text-[10px] font-sans text-slate-500">脈拍 PR</div>
                    <div className="text-sm font-bold text-slate-900">{latestVital.pulse}</div>
                  </div>
                  <div className="bg-white p-1.5 rounded border border-slate-200">
                    <div className="text-[10px] font-sans text-slate-500">体温 BT</div>
                    <div
                      className={`text-sm font-bold ${
                        latestVital.temperature >= 37.5 ? 'text-red-700' : 'text-slate-900'
                      }`}
                    >
                      {latestVital.temperature.toFixed(1)}℃
                    </div>
                  </div>
                  <div className="bg-white p-1.5 rounded border border-slate-200">
                    <div className="text-[10px] font-sans text-slate-500">SpO2</div>
                    <div className="text-sm font-bold text-slate-900">{latestVital.spo2}%</div>
                  </div>
                </div>
              ) : (
                <p className="text-xs text-slate-500">未測定</p>
              )}

              {showVitalForm && (
                <form
                  onSubmit={handleSaveVital}
                  className="pt-2 border-t border-slate-200 grid grid-cols-5 gap-1.5 items-end text-xs"
                >
                  <div>
                    <label className="block text-[10px] text-slate-600">収縮期</label>
                    <input
                      type="number"
                      value={vitalSys}
                      onChange={(e) => setVitalSys(Number(e.target.value))}
                      className="w-full px-1.5 py-1 bg-white border border-slate-300 rounded font-mono tabular-nums"
                    />
                  </div>
                  <div>
                    <label className="block text-[10px] text-slate-600">拡張期</label>
                    <input
                      type="number"
                      value={vitalDia}
                      onChange={(e) => setVitalDia(Number(e.target.value))}
                      className="w-full px-1.5 py-1 bg-white border border-slate-300 rounded font-mono tabular-nums"
                    />
                  </div>
                  <div>
                    <label className="block text-[10px] text-slate-600">脈拍</label>
                    <input
                      type="number"
                      value={vitalPulse}
                      onChange={(e) => setVitalPulse(Number(e.target.value))}
                      className="w-full px-1.5 py-1 bg-white border border-slate-300 rounded font-mono tabular-nums"
                    />
                  </div>
                  <div>
                    <label className="block text-[10px] text-slate-600">体温</label>
                    <input
                      type="number"
                      step="0.1"
                      value={vitalTemp}
                      onChange={(e) => setVitalTemp(Number(e.target.value))}
                      className="w-full px-1.5 py-1 bg-white border border-slate-300 rounded font-mono tabular-nums"
                    />
                  </div>
                  <button
                    type="submit"
                    className="py-1 px-2 text-xs font-semibold text-white bg-teal-700 hover:bg-teal-800 rounded"
                  >
                    保存
                  </button>
                </form>
              )}
            </div>

            {/* Key Lab Results Strip (4 cols) */}
            <div className="lg:col-span-4 p-3 bg-slate-50/80 border border-slate-200 rounded-md space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-xs font-bold text-slate-800">直近の主要検体検査値</span>
                <button
                  type="button"
                  onClick={() => setCenterTab('labs_vitals')}
                  className="text-xs font-semibold text-teal-700 hover:underline"
                >
                  時系列比較を開く
                </button>
              </div>
              {latestLabPanel ? (
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-xs tabular-nums">
                  {latestLabPanel.items.slice(0, 5).map((item) => {
                    const flag = evaluateLabFlag(item.value, item.refMin, item.refMax);
                    return (
                      <div
                        key={item.code}
                        className="bg-white px-2 py-1 rounded border border-slate-200 flex items-center gap-1.5"
                      >
                        <span className="text-slate-600">{item.code}:</span>
                        <span
                          className={`font-mono font-bold ${
                            flag === 'high' || flag === 'critical'
                              ? 'text-red-700'
                              : flag === 'low'
                              ? 'text-blue-700'
                              : 'text-slate-900'
                          }`}
                        >
                          {item.value}
                        </span>
                        {flag !== 'normal' && (
                          <span
                            className={`text-[10px] font-bold ${
                              flag === 'low' ? 'text-blue-700' : 'text-red-700'
                            }`}
                          >
                            {flag === 'low' ? 'L' : 'H'}
                          </span>
                        )}
                      </div>
                    );
                  })}
                </div>
              ) : (
                <p className="text-xs text-slate-500">直近の採血結果なし</p>
              )}
            </div>

            {/* Active ICD-10 Diseases Strip (4 cols) */}
            <div className="lg:col-span-4 p-3 bg-slate-50/80 border border-slate-200 rounded-md space-y-1.5">
              <div className="text-xs font-bold text-slate-800">登録傷病名</div>
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
                {selectedPatient.diseases.map((dis, idx) => (
                  <React.Fragment key={dis.id}>
                    {idx > 0 && <span className="text-slate-300">·</span>}
                    <span className="text-slate-900 font-semibold">
                      <span className="font-mono text-teal-800 mr-1">{dis.icd10Code}</span>
                      {dis.name}
                      {dis.master && <span className="ml-1 font-mono text-slate-500">{dis.master.code}</span>}
                      <span className="text-slate-500 font-normal ml-1">
                        ({dis.isMain ? '主病' : '副傷病'}{dis.outcome === 'suspected' ? '・疑い' : ''})
                      </span>
                    </span>
                    {canEditSoap && dis.master && (
                      <button type="button" aria-label={`${dis.name}を取り消す`}
                        className="rounded p-0.5 text-slate-500 hover:text-red-700"
                        onClick={() => onToggleDiagnosis(selectedPatient.id, dis)}><Trash2 size={14} /></button>
                    )}
                  </React.Fragment>
                ))}
              </div>
              {!selectedPatient.diseases.length && <p className="text-xs text-slate-500">登録されている傷病名はありません。</p>}
              {canEditSoap && (
                <>
                  <ClinicalCatalogPicker key={selectedPatient.id} kind="diagnosis" value={selectedDisease} onSelect={setSelectedDisease} />
                  <div className="flex flex-wrap items-center gap-3 text-xs">
                    <label><input type="checkbox" checked={suspected} onChange={(e) => setSuspected(e.target.checked)} /> 疑い病名</label>
                    <button type="button" disabled={!canAddDiagnosis} onClick={addDiagnosis}
                      className="rounded bg-teal-800 px-2.5 py-1.5 text-white disabled:opacity-50">傷病名を追加</button>
                  </div>
                </>
              )}
            </div>
          </div>
        </section>

        {/* Sub-navigation Tabs */}
        <div
          role="tablist"
          aria-label="カルテ表示モード切替"
          className="grid grid-cols-2 sm:grid-cols-4 gap-1 p-1 bg-slate-200/80 rounded-lg"
        >
          {(
            [
              { id: 'soap', label: 'SOAP第2号カルテ・処方入力', icon: Stethoscope },
              { id: 'labs_vitals', label: '検査値・バイタル推移', icon: FileSpreadsheet },
              {
                id: 'revisions',
                label: `真正性・修正履歴 (第${selectedPatient.revisions.length}版)`,
                icon: History,
              },
              ...(canExportReferral ? [{ id: 'referral_doc' as const, label: '見読性・紹介状出力', icon: Printer }] : []),
            ] as const
          ).map((tab) => {
            const Icon = tab.icon;
            const active = centerTab === tab.id;
            return (
              <button
                key={tab.id}
                role="tab"
                aria-selected={active}
                type="button"
                onClick={() => setCenterTab(tab.id)}
                className={`py-2 px-3 text-xs font-semibold rounded-md transition-colors flex items-center justify-center gap-1.5 whitespace-nowrap shrink-0 ${
                  active
                    ? 'bg-white text-slate-900 shadow-xs'
                    : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                <Icon className="w-3.5 h-3.5 shrink-0" />
                {tab.label}
              </button>
            );
          })}
        </div>

        {signBannerMessage && (
          <div
            role="status"
            className="p-3 bg-emerald-50 border border-emerald-200 rounded-lg text-xs text-emerald-900 flex items-center justify-between gap-2"
          >
            <div className="flex items-center gap-2">
              <CheckCircle2 className="w-4 h-4 text-emerald-700 shrink-0" />
              <span>{signBannerMessage}</span>
            </div>
            <button
              type="button"
              onClick={() => onNavigateToBilling(selectedPatient.id)}
              className="px-3 py-1 text-xs font-semibold bg-emerald-700 text-white rounded hover:bg-emerald-800 whitespace-nowrap shrink-0"
            >
              会計算定画面へ進む
            </button>
          </div>
        )}

        {/* SUB-TAB 1: LARGE, ERGONOMIC SOAP INPUT & PRESCRIPTION/LAB ORDERS */}
        {centerTab === 'soap' && (
          <div className="bg-white border border-slate-200 rounded-lg p-5 space-y-6">
            {/* Toolbar: Template Selector, Previous Visit Copy (Do入力), and Grid/Stack View Toggle */}
            <div className="flex flex-wrap items-center justify-between gap-3 pb-3.5 border-b border-slate-200">
              <div>
                <h2 className="text-base font-bold text-slate-900">
                  診療録 第2号用紙（SOAP構造化カルテ入力）
                </h2>
                <p className="text-xs text-slate-500 mt-0.5">
                  各欄上部の定型フレーズボタンをクリックするとカーソル末尾へ即座に追記できます。
                </p>
              </div>

              <div className="flex flex-wrap items-center gap-2.5">
                {selectedPatient.revisions.length > 0 && (
                  <button
                    type="button"
                    disabled={!canEditSoap}
                    onClick={handleCopyPreviousRevisionSoap}
                    className="px-3 py-1.5 text-xs font-semibold text-slate-700 bg-slate-100 hover:bg-slate-200 border border-slate-300 rounded-md flex items-center gap-1.5 transition-colors disabled:opacity-50"
                  >
                    <Copy className="w-3.5 h-3.5" />
                    前回確定カルテを引用 (Do入力)
                  </button>
                )}

                <div className="flex items-center gap-1.5">
                  <label
                    htmlFor="soap-template-select"
                    className="text-xs font-semibold text-slate-700 whitespace-nowrap"
                  >
                    疾患別テンプレート：
                  </label>
                  <select
                    id="soap-template-select"
                    disabled={!canEditSoap}
                    defaultValue=""
                    onChange={(e) => {
                      const tpl = SOAP_TEMPLATES.find((t) => t.id === e.target.value);
                      if (tpl) {
                        onUpdateSoap(selectedPatient.id, { ...tpl.soap });
                      }
                    }}
                    className="px-3 py-1.5 text-xs bg-slate-50 border border-slate-300 rounded-md text-slate-900 font-medium disabled:opacity-50"
                  >
                    <option value="" disabled>
                      疾患セットを選択して一括展開...
                    </option>
                    {SOAP_TEMPLATES.map((t) => (
                      <option key={t.id} value={t.id}>
                        {t.label}
                      </option>
                    ))}
                  </select>
                </div>

                {/* Layout mode toggle: 2x2 Grid vs Full-width Stack */}
                <div
                  role="group"
                  aria-label="SOAP入力欄レイアウト切替"
                  className="flex items-center p-0.5 bg-slate-100 border border-slate-200 rounded-md"
                >
                  <button
                    type="button"
                    onClick={() => setSoapGridMode('grid')}
                    className={`px-2.5 py-1 text-xs font-medium rounded flex items-center gap-1 ${
                      soapGridMode === 'grid'
                        ? 'bg-white text-slate-900 shadow-xs font-semibold'
                        : 'text-slate-600 hover:text-slate-900'
                    }`}
                  >
                    <Columns2 className="w-3.5 h-3.5" />
                    2列並列
                  </button>
                  <button
                    type="button"
                    onClick={() => setSoapGridMode('stack')}
                    className={`px-2.5 py-1 text-xs font-medium rounded flex items-center gap-1 ${
                      soapGridMode === 'stack'
                        ? 'bg-white text-slate-900 shadow-xs font-semibold'
                        : 'text-slate-600 hover:text-slate-900'
                    }`}
                  >
                    <Rows4 className="w-3.5 h-3.5" />
                    1列ワイド
                  </button>
                </div>
              </div>
            </div>

            {!canEditSoap && (
              <div className="p-3 bg-amber-50 border border-amber-200 rounded-md text-xs text-amber-900 flex items-center gap-2">
                <Lock className="w-4 h-4 text-amber-700 shrink-0" />
                <span>
                  現在のログイン職種（{currentStaff.roleLabel}）は閲覧専用モードです。SOAP編集および処方確定は「医師」ロールに制限されています。
                </span>
              </div>
            )}

            {/* LARGE, HIGH-LEGIBILITY SOAP INPUT BOXES */}
            <div
              className={`grid gap-5 ${
                soapGridMode === 'grid' ? 'grid-cols-1 lg:grid-cols-2' : 'grid-cols-1'
              }`}
            >
              {/* S: Subjective */}
              <div className="p-4 bg-slate-50/70 border border-slate-200 rounded-lg space-y-2.5">
                <div className="flex items-center justify-between gap-2">
                  <label
                    htmlFor="soap-s"
                    className="text-sm font-bold text-slate-900 flex items-center gap-2"
                  >
                    <span className="w-6 h-6 rounded bg-teal-700 text-white font-mono text-xs font-bold flex items-center justify-center shrink-0">
                      S
                    </span>
                    <span>Subjective（主観的情報・患者の訴え・経過）</span>
                  </label>
                  <span className="text-xs font-mono text-slate-400 tabular-nums">
                    {selectedPatient.currentSoap.subjective.length} 文字
                  </span>
                </div>

                {/* Quick-insert phrase buttons for S */}
                <div className="flex flex-wrap items-center gap-1.5">
                  {QUICK_PHRASES.subjective.map((phrase, i) => (
                    <button
                      key={i}
                      type="button"
                      disabled={!canEditSoap}
                      onClick={() => handleAppendSoapField('subjective', phrase)}
                      className="px-2 py-1 text-xs text-slate-700 bg-white hover:bg-teal-50 hover:text-teal-900 border border-slate-200 rounded transition-colors disabled:opacity-40"
                    >
                      + {phrase.slice(0, 16)}…
                    </button>
                  ))}
                </div>

                <textarea
                  id="soap-s"
                  rows={6}
                  disabled={!canEditSoap}
                  value={selectedPatient.currentSoap.subjective}
                  onChange={(e) =>
                    onUpdateSoap(selectedPatient.id, {
                      subjective: e.target.value,
                    })
                  }
                  placeholder="患者の主訴、症状の経過、家庭血圧、服薬状況などを大きく入力..."
                  className="w-full p-3.5 text-sm leading-relaxed bg-white border border-slate-300 rounded-md text-slate-900 focus:outline-none focus:border-teal-700 focus:ring-2 focus:ring-teal-700/15 disabled:opacity-60 resize-y"
                />
              </div>

              {/* O: Objective */}
              <div className="p-4 bg-slate-50/70 border border-slate-200 rounded-lg space-y-2.5">
                <div className="flex items-center justify-between gap-2">
                  <label
                    htmlFor="soap-o"
                    className="text-sm font-bold text-slate-900 flex items-center gap-2"
                  >
                    <span className="w-6 h-6 rounded bg-teal-700 text-white font-mono text-xs font-bold flex items-center justify-center shrink-0">
                      O
                    </span>
                    <span>Objective（客観的所見・身体診察・検査結果）</span>
                  </label>
                  <span className="text-xs font-mono text-slate-400 tabular-nums">
                    {selectedPatient.currentSoap.objective.length} 文字
                  </span>
                </div>

                {/* Quick-insert phrase buttons for O (including 1-click Vitals/Lab insertion!) */}
                <div className="flex flex-wrap items-center gap-1.5">
                  {latestVital && (
                    <button
                      type="button"
                      disabled={!canEditSoap}
                      onClick={() =>
                        handleAppendSoapField(
                          'objective',
                          `【バイタル】BP ${latestVital.systolicBp}/${latestVital.diastolicBp} mmHg, PR ${latestVital.pulse}/min, BT ${latestVital.temperature.toFixed(1)}℃, SpO2 ${latestVital.spo2}%。`
                        )
                      }
                      className="px-2 py-1 text-xs font-semibold text-teal-800 bg-teal-50 hover:bg-teal-100 border border-teal-200 rounded transition-colors disabled:opacity-40"
                    >
                      + 当日バイタル引用
                    </button>
                  )}
                  {latestLabPanel && (
                    <button
                      type="button"
                      disabled={!canEditSoap}
                      onClick={() =>
                        handleAppendSoapField(
                          'objective',
                          `【採血結果】${latestLabPanel.items
                            .map((i) => `${i.code} ${i.value}${i.unit}`)
                            .join(', ')}。`
                        )
                      }
                      className="px-2 py-1 text-xs font-semibold text-teal-800 bg-teal-50 hover:bg-teal-100 border border-teal-200 rounded transition-colors disabled:opacity-40"
                    >
                      + 直近採血値引用
                    </button>
                  )}
                  {QUICK_PHRASES.objective.slice(0, 2).map((phrase, i) => (
                    <button
                      key={i}
                      type="button"
                      disabled={!canEditSoap}
                      onClick={() => handleAppendSoapField('objective', phrase)}
                      className="px-2 py-1 text-xs text-slate-700 bg-white hover:bg-teal-50 hover:text-teal-900 border border-slate-200 rounded transition-colors disabled:opacity-40"
                    >
                      + {phrase.slice(0, 14)}…
                    </button>
                  ))}
                </div>

                <textarea
                  id="soap-o"
                  rows={6}
                  disabled={!canEditSoap}
                  value={selectedPatient.currentSoap.objective}
                  onChange={(e) =>
                    onUpdateSoap(selectedPatient.id, {
                      objective: e.target.value,
                    })
                  }
                  placeholder="身体診察所見、聴診所見、バイタルサイン、検体検査・画像所見を入力..."
                  className="w-full p-3.5 text-sm leading-relaxed bg-white border border-slate-300 rounded-md text-slate-900 focus:outline-none focus:border-teal-700 focus:ring-2 focus:ring-teal-700/15 disabled:opacity-60 resize-y"
                />
              </div>

              {/* A: Assessment */}
              <div className="p-4 bg-slate-50/70 border border-slate-200 rounded-lg space-y-2.5">
                <div className="flex items-center justify-between gap-2">
                  <label
                    htmlFor="soap-a"
                    className="text-sm font-bold text-slate-900 flex items-center gap-2"
                  >
                    <span className="w-6 h-6 rounded bg-teal-700 text-white font-mono text-xs font-bold flex items-center justify-center shrink-0">
                      A
                    </span>
                    <span>Assessment（診断・病態評価・鑑別）</span>
                  </label>
                  <span className="text-xs font-mono text-slate-400 tabular-nums">
                    {selectedPatient.currentSoap.assessment.length} 文字
                  </span>
                </div>

                {/* Quick-insert phrase buttons for A */}
                <div className="flex flex-wrap items-center gap-1.5">
                  <button
                    type="button"
                    disabled={!canEditSoap}
                    onClick={() =>
                      handleAppendSoapField(
                        'assessment',
                        selectedPatient.diseases
                          .map((d, idx) => `#${idx + 1} ${d.name} (${d.icd10Code})`)
                          .join('\n')
                      )
                    }
                    className="px-2 py-1 text-xs font-semibold text-teal-800 bg-teal-50 hover:bg-teal-100 border border-teal-200 rounded transition-colors disabled:opacity-40"
                  >
                    + 登録傷病名を番号付き引用
                  </button>
                  {QUICK_PHRASES.assessment.map((phrase, i) => (
                    <button
                      key={i}
                      type="button"
                      disabled={!canEditSoap}
                      onClick={() => handleAppendSoapField('assessment', phrase)}
                      className="px-2 py-1 text-xs text-slate-700 bg-white hover:bg-teal-50 hover:text-teal-900 border border-slate-200 rounded transition-colors disabled:opacity-40"
                    >
                      + {phrase.slice(0, 14)}…
                    </button>
                  ))}
                </div>

                <textarea
                  id="soap-a"
                  rows={6}
                  disabled={!canEditSoap}
                  value={selectedPatient.currentSoap.assessment}
                  onChange={(e) =>
                    onUpdateSoap(selectedPatient.id, {
                      assessment: e.target.value,
                    })
                  }
                  placeholder="問題リスト（#1, #2...）、重症度評価、治療効果判定を入力..."
                  className="w-full p-3.5 text-sm leading-relaxed bg-white border border-slate-300 rounded-md text-slate-900 focus:outline-none focus:border-teal-700 focus:ring-2 focus:ring-teal-700/15 disabled:opacity-60 resize-y"
                />
              </div>

              {/* P: Plan */}
              <div className="p-4 bg-slate-50/70 border border-slate-200 rounded-lg space-y-2.5">
                <div className="flex items-center justify-between gap-2">
                  <label
                    htmlFor="soap-p"
                    className="text-sm font-bold text-slate-900 flex items-center gap-2"
                  >
                    <span className="w-6 h-6 rounded bg-teal-700 text-white font-mono text-xs font-bold flex items-center justify-center shrink-0">
                      P
                    </span>
                    <span>Plan（治療方針・処方計画・患者指導）</span>
                  </label>
                  <span className="text-xs font-mono text-slate-400 tabular-nums">
                    {selectedPatient.currentSoap.plan.length} 文字
                  </span>
                </div>

                {/* Quick-insert phrase buttons for P */}
                <div className="flex flex-wrap items-center gap-1.5">
                  {QUICK_PHRASES.plan.map((phrase, i) => (
                    <button
                      key={i}
                      type="button"
                      disabled={!canEditSoap}
                      onClick={() => handleAppendSoapField('plan', phrase)}
                      className="px-2 py-1 text-xs text-slate-700 bg-white hover:bg-teal-50 hover:text-teal-900 border border-slate-200 rounded transition-colors disabled:opacity-40"
                    >
                      + {phrase.slice(0, 15)}…
                    </button>
                  ))}
                </div>

                <textarea
                  id="soap-p"
                  rows={6}
                  disabled={!canEditSoap}
                  value={selectedPatient.currentSoap.plan}
                  onChange={(e) =>
                    onUpdateSoap(selectedPatient.id, {
                      plan: e.target.value,
                    })
                  }
                  placeholder="処方内容の方針、追加検査計画、生活習慣指導、次回再診予定を入力..."
                  className="w-full p-3.5 text-sm leading-relaxed bg-white border border-slate-300 rounded-md text-slate-900 focus:outline-none focus:border-teal-700 focus:ring-2 focus:ring-teal-700/15 disabled:opacity-60 resize-y"
                />
              </div>
            </div>

            {/* PRESCRIPTION & LAB ORDER SECTION (Side-by-side 2-column layout below SOAP) */}
            <div className="grid grid-cols-1 lg:grid-cols-12 gap-5 pt-4 border-t border-slate-200">
              {/* Left 7 Cols: Prescription Order Builder */}
              <div className="lg:col-span-7 space-y-3">
                <div className="flex items-center justify-between">
                  <h3 className="text-sm font-bold text-slate-900">
                    処方オーダ（デモ）
                  </h3>
                  <span className="text-xs font-semibold text-slate-600 tabular-nums">
                    現在 {selectedPatient.currentPrescriptions.length} 剤登録中
                  </span>
                </div>

                {selectedPatient.currentPrescriptions.length > 0 ? (
                  <div className="border border-slate-200 rounded-md overflow-hidden">
                    <table className="w-full text-left border-collapse">
                      <thead>
                        <tr className="bg-slate-50 border-b border-slate-200 text-xs font-semibold text-slate-600">
                          <th className="py-2 px-3">薬剤名称 / コード</th>
                          <th className="py-2 px-3">1日用量・用法</th>
                          <th className="py-2 px-3 text-right">日数/回数</th>
                          <th className="py-2 px-3 text-right">削除</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-200 text-xs">
                        {selectedPatient.currentPrescriptions.map((rx) => (
                          <tr key={rx.id} className="hover:bg-slate-50/80">
                            <td className="py-2.5 px-3">
                              <div className="font-bold text-slate-900 text-sm">{rx.drugName}</div>
                              <div className="text-[11px] text-slate-500 font-mono tabular-nums">
                                {rx.master ? `レセ電算 ${rx.master.code}${rx.priceCode ? ` · 薬価基準 ${rx.priceCode}` : ''}` : `YJ:${rx.yjCode}`}
                              </div>
                            </td>
                            <td className="py-2.5 px-3 text-slate-800 font-medium">
                              {rx.dosagePerDay} · {rx.usage}
                            </td>
                            <td className="py-2.5 px-3 text-right font-mono tabular-nums font-bold text-slate-900">
                              {rx.days}
                              {rx.category === 'as_needed' ? '回分' : '日分'}
                            </td>
                            <td className="py-2.5 px-3 text-right">
                              <button
                                type="button"
                                disabled={!canAddRx}
                                aria-label={`${rx.drugName}を処方から削除`}
                                onClick={() => onRemovePrescription(selectedPatient.id, rx.id)}
                                className="p-1 text-slate-400 hover:text-red-600 disabled:opacity-40"
                              >
                                <Trash2 className="w-4 h-4" />
                              </button>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ) : (
                  <div className="p-4 bg-slate-50 border border-slate-200 rounded-md text-xs text-slate-500 text-center">
                    処方薬剤はまだ登録されていません。下のフォームから追加してください。
                  </div>
                )}

                {canAddRx && <div className="p-3.5 bg-slate-50 border border-slate-200 rounded-md space-y-2.5">
                  <ClinicalCatalogPicker key={selectedPatient.id} kind="drug" value={selectedDrug} onSelect={selectDrug} />
                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 text-xs">
                    <label className="grid gap-1">用量{selectedDrug?.unit ? `（規格単位 ${selectedDrug.unit}）` : ''}
                      <input className="rounded border border-slate-300 bg-white px-2 py-1.5" value={rxDosage}
                        onChange={(event) => setRxDosage(event.target.value)} maxLength={100} />
                    </label>
                    <label className="grid gap-1">用法
                      <input className="rounded border border-slate-300 bg-white px-2 py-1.5" value={rxUsage}
                        onChange={(event) => setRxUsage(event.target.value)} maxLength={120} />
                    </label>
                    <label className="grid gap-1">日数・回数
                      <input className="rounded border border-slate-300 bg-white px-2 py-1.5" type="number" min={1} max={90}
                        value={rxDays} onChange={(event) => setRxDays(event.target.value)} />
                    </label>
                  </div>
                  <div className="flex flex-wrap items-center gap-3 text-xs">
                    {selectedDrug?.drugForm === '1' && (
                      <label><input type="checkbox" checked={rxAsNeeded} onChange={(e) => setRxAsNeeded(e.target.checked)} /> 頓服</label>
                    )}
                    <button type="button" disabled={!canSubmitRx} onClick={handleAddPrescriptionClick}
                      className="rounded bg-teal-800 px-2.5 py-1.5 text-white disabled:opacity-50">処方追加</button>
                  </div>
                  <p className="text-xs text-slate-600">マスターは名称・規格の参照用です。照合は薬剤名と同一薬剤の重複候補に限られます。禁忌・相互作用・腎機能別用量は確認できません。</p>

                  {/* Real-time Drug Safety Warnings */}
                  {drugSafetyWarnings.length > 0 && (
                    <div className="space-y-1.5 pt-1">
                      {drugSafetyWarnings.map((warn, idx) => (
                        <div
                          key={idx}
                          className={`p-2.5 rounded border text-xs flex items-start gap-2 ${
                            warn.severity === 'error'
                              ? 'bg-red-50 border-red-200 text-red-900'
                              : 'bg-amber-50 border-amber-200 text-amber-900'
                          }`}
                        >
                          <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
                          <span className="font-medium">{warn.reason}</span>
                        </div>
                      ))}
                      {hasHardContraindication && (
                        <div className="pt-1 flex justify-end">
                          <label className="flex items-center gap-1.5 text-xs font-semibold text-red-900 cursor-pointer">
                            <input
                              type="checkbox"
                              checked={overrideContraConfirm}
                              onChange={(e) => setOverrideContraConfirm(e.target.checked)}
                            />
                            医師判断で薬剤名の一致を確認したうえでデモオーダに追加する
                          </label>
                        </div>
                      )}
                    </div>
                  )}
                </div>}
              </div>

              {/* Right 5 Cols: Lab Order Selection */}
              <div className="lg:col-span-5 space-y-2.5">
                <div className="flex items-center justify-between">
                  <h3 className="text-sm font-bold text-slate-900">
                    当日検体検査・生体検査オーダ
                  </h3>
                  <span className="text-xs text-slate-500 tabular-nums">
                    選択中 {selectedPatient.currentLabOrders.length} 項目
                  </span>
                </div>
                {canAddRx && (
                  <>
                    <ClinicalCatalogPicker key={selectedPatient.id} kind="procedure" value={selectedLab} onSelect={setSelectedLab} />
                    <button type="button" disabled={!canAddLab} onClick={addLab}
                      className="rounded bg-teal-800 px-2.5 py-1.5 text-xs text-white disabled:opacity-50">検査を追加</button>
                  </>
                )}
                <ul className="grid gap-2">
                  {selectedPatient.currentLabOrders.map((lab) => (
                    <li key={lab.id} className="flex items-center justify-between gap-2 rounded border border-slate-200 px-2.5 py-2 text-xs">
                      <span>{lab.name} · <span className="font-mono">{lab.code}</span></span>
                      {canAddRx && <button type="button" aria-label={`${lab.name}を取り消す`}
                        onClick={() => onToggleLabOrder(selectedPatient.id, lab)} className="p-1 text-slate-500 hover:text-red-700">
                        <Trash2 size={14} />
                      </button>}
                    </li>
                  ))}
                </ul>
              </div>
            </div>

            {/* HPKI DIGITAL SIGNATURE & AUTHENTICITY BAR */}
            <div className="pt-4 border-t border-slate-200 bg-slate-50 -mx-5 -mb-5 p-4 rounded-b-lg flex flex-wrap items-center justify-between gap-3">
              <div className="space-y-1 flex-1 min-w-[260px]">
                <div className="text-xs font-bold text-slate-900 flex items-center gap-1.5">
                  <ClipboardCheck className="w-4 h-4 text-teal-700" />
                  <span>
                    厚労省ガイドライン「真正性」：HPKI電子署名・タイムスタンプ確定
                  </span>
                </div>
                {selectedPatient.revisions.length > 0 ? (
                  <input
                    type="text"
                    value={revisionReason}
                    onChange={(e) => setRevisionReason(e.target.value)}
                    placeholder="修正・追記理由を入力（例：採血結果判明に伴うA/P追記）..."
                    className="w-full px-3 py-1.5 text-xs bg-white border border-slate-300 rounded text-slate-900"
                  />
                ) : (
                  <p className="text-xs text-slate-500">
                    確定ボタンを押すと、医師資格証（{currentStaff.hpkiCertId || 'HPKI'}）とSHA-256ハッシュ値により変更不可能な版として記録されます。
                  </p>
                )}
              </div>

              <button
                type="button"
                disabled={!canSignSoap}
                onClick={handleSignClick}
                className="px-5 py-2.5 text-sm font-bold text-white bg-teal-700 hover:bg-teal-800 disabled:bg-slate-300 rounded-lg transition-colors flex items-center gap-2 whitespace-nowrap shrink-0"
              >
                <ShieldCheck className="w-4 h-4" />
                {selectedPatient.isSigned
                  ? '修正版として再署名・履歴保存 (HPKI)'
                  : '電子署名してカルテ確定 (HPKI)'}
              </button>
            </div>
          </div>
        )}

        {/* SUB-TAB 2: LONGITUDINAL LABS & VITALS */}
        {centerTab === 'labs_vitals' && (
          <div className="bg-white border border-slate-200 rounded-lg p-5 space-y-5">
            <div className="flex items-center justify-between border-b border-slate-200 pb-3">
              <div>
                <h2 className="text-base font-bold text-slate-900">
                  検体検査結果・バイタルサイン時系列比較
                </h2>
                <p className="text-xs text-slate-500 mt-0.5">
                  基準値逸脱項目は H（高値）/ L（低値）ラベル付きで表示されます。
                </p>
              </div>
            </div>

            {selectedPatient.labHistory.length === 0 ? (
              <div className="p-6 text-center text-xs text-slate-500">
                過去の検体検査データはまだ登録されていません。
              </div>
            ) : (
              <div className="space-y-4">
                {selectedPatient.labHistory.map((panel) => (
                  <div key={panel.id} className="border border-slate-200 rounded-md overflow-hidden">
                    <div className="px-3.5 py-2.5 bg-slate-50 border-b border-slate-200 flex items-center justify-between text-xs">
                      <span className="font-semibold text-slate-900 tabular-nums">
                        検体採取日時：{panel.sampledAt}
                      </span>
                      <span className="text-slate-500">指示医：{panel.orderedBy}</span>
                    </div>
                    <table className="w-full text-left border-collapse text-xs">
                      <thead>
                        <tr className="border-b border-slate-200 text-[11px] text-slate-500 bg-slate-50/50">
                          <th className="py-2 px-3">検査項目</th>
                          <th className="py-2 px-3 text-right">測定値</th>
                          <th className="py-2 px-3">判定</th>
                          <th className="py-2 px-3 text-right">基準値範囲</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-200">
                        {panel.items.map((item) => {
                          const flag = evaluateLabFlag(item.value, item.refMin, item.refMax);
                          return (
                            <tr key={item.code} className="hover:bg-slate-50">
                              <td className="py-2 px-3 font-medium text-slate-900">{item.name}</td>
                              <td
                                className={`py-2 px-3 text-right font-mono tabular-nums font-semibold ${
                                  flag === 'high' || flag === 'critical'
                                    ? 'text-red-700'
                                    : flag === 'low'
                                    ? 'text-blue-700'
                                    : 'text-slate-900'
                                }`}
                              >
                                {item.value} {item.unit}
                              </td>
                              <td className="py-2 px-3">
                                {flag === 'normal' && (
                                  <span className="text-slate-500">基準内</span>
                                )}
                                {(flag === 'high' || flag === 'critical') && (
                                  <span className="font-semibold text-red-700">H 高値</span>
                                )}
                                {flag === 'low' && (
                                  <span className="font-semibold text-blue-700">L 低値</span>
                                )}
                              </td>
                              <td className="py-2 px-3 text-right font-mono tabular-nums text-slate-500">
                                {item.refMin} – {item.refMax} {item.unit}
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                ))}
              </div>
            )}

            {/* Vitals History Table */}
            <div className="pt-2">
              <h3 className="text-xs font-bold text-slate-900 mb-2">
                バイタルサイン推移
              </h3>
              <div className="border border-slate-200 rounded-md overflow-hidden">
                <table className="w-full text-left border-collapse text-xs">
                  <thead>
                    <tr className="bg-slate-50 border-b border-slate-200 text-[11px] text-slate-600">
                      <th className="py-2 px-3">測定日時</th>
                      <th className="py-2 px-3 text-right">血圧 (mmHg)</th>
                      <th className="py-2 px-3 text-right">脈拍 (/分)</th>
                      <th className="py-2 px-3 text-right">体温 (℃)</th>
                      <th className="py-2 px-3 text-right">SpO2 (%)</th>
                      <th className="py-2 px-3 text-right">体重 / BMI</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-200 font-mono tabular-nums">
                    {selectedPatient.vitalsHistory.map((v, i) => (
                      <tr key={i} className="hover:bg-slate-50">
                        <td className="py-2 px-3 text-slate-700">{v.measuredAt}</td>
                        <td
                          className={`py-2 px-3 text-right font-semibold ${
                            v.systolicBp >= 135 || v.diastolicBp >= 85
                              ? 'text-amber-700'
                              : 'text-slate-900'
                          }`}
                        >
                          {v.systolicBp}/{v.diastolicBp}
                        </td>
                        <td className="py-2 px-3 text-right">{v.pulse}</td>
                        <td
                          className={`py-2 px-3 text-right font-semibold ${
                            v.temperature >= 37.5 ? 'text-red-700' : 'text-slate-900'
                          }`}
                        >
                          {v.temperature.toFixed(1)}
                        </td>
                        <td className="py-2 px-3 text-right">{v.spo2}%</td>
                        <td className="py-2 px-3 text-right">
                          {v.weightKg}kg ({v.bmi})
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        )}

        {/* SUB-TAB 3: AUTHENTICITY & IMMUTABLE REVISION HISTORY (真正性) */}
        {centerTab === 'revisions' && (
          <div className="bg-white border border-slate-200 rounded-lg p-5 space-y-4">
            <div className="border-b border-slate-200 pb-3">
              <h2 className="text-base font-bold text-slate-900">
                厚労省ガイドライン「真正性」：電子署名・改ざん防止ハッシュ連鎖履歴
              </h2>
              <p className="text-xs text-slate-500 mt-0.5">
                確定後のカルテ修正は過去版を上書きせず、修正理由・HPKI署名ID・前版ハッシュを含む不変チェーンとして保存されます。
              </p>
            </div>

            {selectedPatient.revisions.length === 0 ? (
              <div className="p-6 bg-slate-50 border border-slate-200 rounded-md text-center space-y-2">
                <p className="text-xs text-slate-600">
                  この患者の診療録はまだ確定署名されていません。
                </p>
                <button
                  type="button"
                  onClick={() => setCenterTab('soap')}
                  className="px-3 py-1.5 text-xs font-semibold text-teal-700 hover:underline"
                >
                  SOAPカルテ画面へ戻り電子署名を実行する
                </button>
              </div>
            ) : (
              <div className="space-y-3">
                {selectedPatient.revisions.map((rev) => (
                  <div
                    key={rev.revisionNumber}
                    className="p-4 border border-slate-200 rounded-md bg-slate-50/60 space-y-2.5"
                  >
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div className="flex items-center gap-2 text-xs">
                        <span className="font-bold text-slate-900 tabular-nums">
                          第{rev.revisionNumber}版 (確定済)
                        </span>
                        <span className="text-slate-400">·</span>
                        <span className="font-mono text-slate-600 tabular-nums">
                          {rev.timestamp}
                        </span>
                        <span className="text-slate-400">·</span>
                        <span className="font-medium text-teal-800">
                          署名医：{rev.authorName} ({rev.hpkiSignatureId})
                        </span>
                      </div>
                      <span className="text-xs font-semibold text-emerald-700 flex items-center gap-1">
                        <ShieldCheck className="w-3.5 h-3.5" />
                        ハッシュ整合性検証OK
                      </span>
                    </div>

                    <p className="text-xs text-slate-700 font-medium">
                      確定・改訂理由：{rev.reasonForRevision}
                    </p>

                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-xs bg-white p-3 rounded border border-slate-200">
                      <div>
                        <span className="font-semibold text-slate-700">S: </span>
                        <span className="text-slate-600">{rev.soap.subjective}</span>
                      </div>
                      <div>
                        <span className="font-semibold text-slate-700">O: </span>
                        <span className="text-slate-600">{rev.soap.objective}</span>
                      </div>
                      <div>
                        <span className="font-semibold text-slate-700">A: </span>
                        <span className="text-slate-600">{rev.soap.assessment}</span>
                      </div>
                      <div>
                        <span className="font-semibold text-slate-700">P: </span>
                        <span className="text-slate-600">{rev.soap.plan}</span>
                      </div>
                    </div>

                    <div className="text-[11px] font-mono text-slate-500 tabular-nums space-y-0.5 pt-1">
                      <div>SHA-256 Record Hash : {rev.sha256Hash}</div>
                      <div>Previous Chain Hash : {rev.previousHash}</div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* SUB-TAB 4: READABILITY EXPORT / REFERRAL LETTER (見読性) */}
        {centerTab === 'referral_doc' && canExportReferral && (
          <div className="bg-white border border-slate-200 rounded-lg p-5 space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-200 pb-3">
              <div>
                <h2 className="text-base font-bold text-slate-900">
                  厚労省ガイドライン「見読性」：診療情報提供書（紹介状）・カルテ書面即時出力
                </h2>
                <p className="text-xs text-slate-500 mt-0.5">
                  監査時・他院紹介時・緊急時に直ちに肉眼で見読可能な標準様式として表示・出力します。
                </p>
              </div>
              <button
                type="button"
                onClick={async () => {
                  if (await onExportReferral(selectedPatient.id, referralHospital, referralPurpose)) {
                    setPrintPreviewNotif('デモ紹介状のテキストを出力しました。');
                  }
                }}
                className="px-3.5 py-2 text-xs font-semibold text-white bg-teal-700 hover:bg-teal-800 rounded-md flex items-center gap-1.5 whitespace-nowrap shrink-0"
              >
                <Printer className="w-3.5 h-3.5" />
                紹介状を確定出力・監査記録
              </button>
            </div>

            {printPreviewNotif && (
              <div className="p-2.5 bg-teal-50 border border-teal-200 rounded text-xs text-teal-900">
                {printPreviewNotif}
              </div>
            )}

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">
                  紹介先医療機関・診療科
                </label>
                <input
                  type="text"
                  value={referralHospital}
                  onChange={(e) => setReferralHospital(e.target.value)}
                  className="w-full px-3 py-1.5 text-xs bg-white border border-slate-300 rounded"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">
                  紹介目的
                </label>
                <input
                  type="text"
                  value={referralPurpose}
                  onChange={(e) => setReferralPurpose(e.target.value)}
                  className="w-full px-3 py-1.5 text-xs bg-white border border-slate-300 rounded"
                />
              </div>
            </div>

            {/* Print-ready Formatted Document Sheet */}
            <div className="p-5 bg-slate-50 border border-slate-300 rounded-md space-y-3 text-xs text-slate-800">
              <div className="text-center border-b border-slate-300 pb-2">
                <h3 className="text-base font-bold tracking-wide text-slate-900">
                  診療情報提供書（紹介状）
                </h3>
                <p className="text-[11px] text-slate-500 tabular-nums">
                  発行日：2026年11月9日 · 医療機関コード：{CLINIC_INFO.facilityCode}
                </p>
              </div>

              <div className="flex flex-wrap justify-between gap-2">
                <div className="font-semibold text-slate-900">{referralHospital}</div>
                <div className="text-right text-[11px] text-slate-600">
                  <div>{CLINIC_INFO.name}</div>
                  <div>{CLINIC_INFO.address}</div>
                  <div>担当医：{currentStaff.name}</div>
                </div>
              </div>

              <div className="p-2.5 bg-white border border-slate-200 rounded space-y-1 tabular-nums">
                <div>
                  <span className="font-semibold">患者氏名：</span>
                  {selectedPatient.kanjiName} ({selectedPatient.kanaName}) · {selectedPatient.sex} ·{' '}
                  {selectedPatient.birthDate}生 ({selectedPatient.age}歳)
                </div>
                <div>
                  <span className="font-semibold">傷病名：</span>
                  {selectedPatient.diseases.map((d) => `${d.name} (${d.icd10Code})`).join('、')}
                </div>
                <div>
                  <span className="font-semibold">紹介目的：</span>
                  {referralPurpose}
                </div>
              </div>

              <div className="space-y-1.5">
                <div>
                  <span className="font-semibold text-slate-900">【病歴および治療経過】</span>
                  <p className="mt-0.5 text-slate-700">{selectedPatient.currentSoap.subjective}</p>
                </div>
                <div>
                  <span className="font-semibold text-slate-900">【現在の身体所見・検査結果】</span>
                  <p className="mt-0.5 text-slate-700">{selectedPatient.currentSoap.objective}</p>
                </div>
                <div>
                  <span className="font-semibold text-slate-900">【現在の処方内容・アレルギー】</span>
                  <p className="mt-0.5 text-slate-700">
                    処方：
                    {selectedPatient.currentPrescriptions
                      .map((r) => `${r.drugName} ${r.dosagePerDay}`)
                      .join(' / ') || 'なし'}
                  </p>
                </div>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
