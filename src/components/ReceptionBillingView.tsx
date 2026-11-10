import React, { useMemo, useState } from 'react';
import {
  CheckCircle2,
  CreditCard,
  FileText,
  Printer,
  Receipt,
  Search,
  ShieldCheck,
  UserPlus,
} from 'lucide-react';
import { PatientRecord, StaffMember, VisitStatus } from '../types/emr';
import { CLINIC_INFO } from '../data/seedData';
import { calculateMedicalFeePoints, canPerformAction } from '../utils/emrLogic';

interface ReceptionBillingViewProps {
  patients: PatientRecord[];
  selectedPatientId: string;
  currentStaff: StaffMember;
  onSelectPatient: (patientId: string) => void;
  onOpenNewPatientModal: () => void;
  onCompleteBilling: (patientId: string) => void;
  onNavigateToChart: (patientId: string) => void;
}

const STATUS_LABELS: Record<VisitStatus, string> = {
  waiting: '待合中',
  in_consultation: '診察中',
  billing: '会計待ち',
  completed: '精算完了',
};

export const ReceptionBillingView: React.FC<ReceptionBillingViewProps> = ({
  patients,
  selectedPatientId,
  currentStaff,
  onSelectPatient,
  onOpenNewPatientModal,
  onCompleteBilling,
  onNavigateToChart,
}) => {
  const [search, setSearch] = useState('');
  const [receiptToast, setReceiptToast] = useState<string | null>(null);

  const selectedPatient = useMemo(
    () => patients.find((p) => p.id === selectedPatientId) || patients[0],
    [patients, selectedPatientId]
  );

  const filteredPatients = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return patients;
    return patients.filter(
      (p) =>
        p.kanjiName.toLowerCase().includes(q) ||
        p.kanaName.toLowerCase().includes(q) ||
        p.id.toLowerCase().includes(q)
    );
  }, [patients, search]);

  const feeCalc = useMemo(() => {
    if (!selectedPatient) return null;
    const hasChronic = selectedPatient.diseases.some((d) => d.isChronicDiseaseTarget);
    return calculateMedicalFeePoints(
      selectedPatient.visitType,
      selectedPatient.copayRatio,
      hasChronic,
      selectedPatient.currentPrescriptions,
      selectedPatient.currentLabOrders,
      selectedPatient.mynaVerified
    );
  }, [selectedPatient]);

  const canSettleBilling =
    canPerformAction(currentStaff.role, 'settle_billing') || currentStaff.role === 'doctor';

  const handleSettleClick = () => {
    if (!selectedPatient) return;
    onCompleteBilling(selectedPatient.id);
    setReceiptToast(
      `${selectedPatient.kanjiName} 様の窓口会計（¥${feeCalc?.copayAmountYen.toLocaleString()}）を確定し、領収書・診療明細書・院外処方箋を発行しました。`
    );
    setTimeout(() => setReceiptToast(null), 5000);
  };

  if (!selectedPatient || !feeCalc) return null;

  return (
    <div className="space-y-4">
      {/* Top Summary Strip */}
      <div className="grid grid-cols-1 sm:grid-cols-4 gap-3 bg-white border border-slate-200 rounded-lg p-4">
        <div>
          <div className="text-xs text-slate-500">本日来院受付総数</div>
          <div className="text-xl font-bold font-mono tabular-nums text-slate-900 mt-0.5">
            {patients.length} <span className="text-xs font-sans font-normal text-slate-500">名</span>
          </div>
        </div>
        <div>
          <div className="text-xs text-slate-500">診察待合・診察中</div>
          <div className="text-xl font-bold font-mono tabular-nums text-teal-700 mt-0.5">
            {patients.filter((p) => p.visitStatus === 'waiting' || p.visitStatus === 'in_consultation').length}{' '}
            <span className="text-xs font-sans font-normal text-slate-500">名</span>
          </div>
        </div>
        <div>
          <div className="text-xs text-slate-500">会計待ち（カルテ確定済）</div>
          <div className="text-xl font-bold font-mono tabular-nums text-amber-700 mt-0.5">
            {patients.filter((p) => p.visitStatus === 'billing').length}{' '}
            <span className="text-xs font-sans font-normal text-slate-500">名</span>
          </div>
        </div>
        <div className="flex items-center justify-between sm:justify-end">
          <button
            type="button"
            onClick={onOpenNewPatientModal}
            className="px-4 py-2 text-xs font-semibold text-white bg-teal-700 hover:bg-teal-800 rounded-lg flex items-center gap-1.5 whitespace-nowrap shrink-0"
          >
            <UserPlus className="w-4 h-4" />
            新規来院・新患登録
          </button>
        </div>
      </div>

      {receiptToast && (
        <div
          role="status"
          className="p-3 bg-emerald-50 border border-emerald-200 rounded-lg text-xs text-emerald-900 flex items-center gap-2"
        >
          <CheckCircle2 className="w-4 h-4 text-emerald-700 shrink-0" />
          <span>{receiptToast}</span>
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-4 items-start">
        {/* Left 7 Cols: Reception & Accounting Table */}
        <div className="lg:col-span-7 bg-white border border-slate-200 rounded-lg overflow-hidden">
          <div className="p-4 border-b border-slate-200 flex flex-wrap items-center justify-between gap-2">
            <div>
              <h2 className="text-sm font-bold text-slate-900">
                外来受付・オンライン資格確認・会計一覧
              </h2>
              <p className="text-xs text-slate-500 mt-0.5">
                行を選択すると右ペインに診療報酬点数内訳・領収書プレビューを表示します。
              </p>
            </div>
            <div className="relative w-60">
              <Search className="w-3.5 h-3.5 text-slate-400 absolute left-2.5 top-1/2 -translate-y-1/2" />
              <input
                type="search"
                aria-label="会計患者検索"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="患者名・ID検索..."
                className="w-full pl-8 pr-3 py-1.5 text-xs bg-slate-50 border border-slate-200 rounded-md"
              />
            </div>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse text-xs">
              <thead>
                <tr className="bg-slate-50 border-b border-slate-200 text-[11px] font-semibold text-slate-600">
                  <th className="py-2.5 px-3">受付番号</th>
                  <th className="py-2.5 px-3">患者ID / 氏名</th>
                  <th className="py-2.5 px-3">保険種別・資格確認</th>
                  <th className="py-2.5 px-3">カルテ署名</th>
                  <th className="py-2.5 px-3">進捗状況</th>
                  <th className="py-2.5 px-3 text-right">操作</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-200">
                {filteredPatients.map((pt) => {
                  const active = pt.id === selectedPatient.id;
                  return (
                    <tr
                      key={pt.id}
                      onClick={() => onSelectPatient(pt.id)}
                      className={`cursor-pointer transition-colors ${
                        active ? 'bg-teal-50/70' : 'hover:bg-slate-50'
                      }`}
                    >
                      <td className="py-2.5 px-3 font-mono font-semibold text-teal-800 tabular-nums">
                        {pt.receptionNumber}
                        <div className="text-[11px] font-normal text-slate-500">
                          {pt.receptionTime}
                        </div>
                      </td>
                      <td className="py-2.5 px-3">
                        <div className="font-bold text-slate-900">{pt.kanjiName}</div>
                        <div className="text-[11px] text-slate-500 font-mono tabular-nums">
                          {pt.id} · {pt.age}歳 · {pt.visitType}
                        </div>
                      </td>
                      <td className="py-2.5 px-3 tabular-nums">
                        <div className="text-slate-800">
                          {pt.insuranceType} ({Math.round(pt.copayRatio * 10)}割)
                        </div>
                        <div className="text-[11px] text-teal-700">
                          {pt.mynaVerified ? 'マイナ保険証確認済' : '資格確認済'}
                        </div>
                      </td>
                      <td className="py-2.5 px-3">
                        {pt.isSigned ? (
                          <span className="font-semibold text-emerald-700 flex items-center gap-1">
                            <ShieldCheck className="w-3.5 h-3.5" />
                            HPKI署名済
                          </span>
                        ) : (
                          <span className="text-amber-700">未確定</span>
                        )}
                      </td>
                      <td className="py-2.5 px-3 font-semibold text-slate-800">
                        {STATUS_LABELS[pt.visitStatus]}
                      </td>
                      <td className="py-2.5 px-3 text-right">
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            onNavigateToChart(pt.id);
                          }}
                          className="text-xs font-medium text-teal-700 hover:underline whitespace-nowrap"
                        >
                          カルテを開く
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>

        {/* Right 5 Cols: Medical Fee Statement & Receipt (診療明細書・領収証) */}
        <div className="lg:col-span-5 bg-white border border-slate-200 rounded-lg p-4 space-y-4">
          <div className="flex items-center justify-between border-b border-slate-200 pb-3">
            <div>
              <h2 className="text-sm font-bold text-slate-900 flex items-center gap-1.5">
                <Receipt className="w-4 h-4 text-teal-700" />
                診療費請求書兼領収証・診療明細書
              </h2>
              <p className="text-xs text-slate-500 mt-0.5 tabular-nums">
                患者：{selectedPatient.kanjiName} 様 ({selectedPatient.id})
              </p>
            </div>
            <span className="text-xs font-semibold text-slate-700">
              {selectedPatient.billingCompleted ? '精算・発行済' : '精算待ち'}
            </span>
          </div>

          {/* Statement Header */}
          <div className="p-3 bg-slate-50 border border-slate-200 rounded-md text-xs space-y-1 tabular-nums">
            <div className="flex justify-between">
              <span className="text-slate-500">診療日：2026年11月9日</span>
              <span className="text-slate-500">保険者番号：{selectedPatient.insurerNumber}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-slate-700 font-medium">
                区分：{selectedPatient.visitType} · {selectedPatient.insuranceType}
              </span>
              <span className="text-slate-700 font-medium">
                負担割合：{Math.round(selectedPatient.copayRatio * 10)}割負担
              </span>
            </div>
          </div>

          {/* Detailed Fee Breakdown Table */}
          <div className="border border-slate-200 rounded-md overflow-hidden">
            <table className="w-full text-left border-collapse text-xs">
              <thead>
                <tr className="bg-slate-50 border-b border-slate-200 text-[11px] text-slate-600">
                  <th className="py-2 px-3">部・区分</th>
                  <th className="py-2 px-3">算定項目名称</th>
                  <th className="py-2 px-3 text-right">点数</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-200 tabular-nums">
                {feeCalc.items.map((item, idx) => (
                  <tr key={idx}>
                    <td className="py-2 px-3 text-slate-500 whitespace-nowrap">{item.category}</td>
                    <td className="py-2 px-3">
                      <div className="font-medium text-slate-900">{item.name}</div>
                      {item.note && (
                        <div className="text-[11px] text-slate-500">{item.note}</div>
                      )}
                    </td>
                    <td className="py-2 px-3 text-right font-mono font-semibold text-slate-900 whitespace-nowrap">
                      {item.points} 点
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Total Points & Copayment Box */}
          <div className="p-3.5 bg-slate-50 border border-slate-200 rounded-md space-y-2 tabular-nums">
            <div className="flex justify-between text-xs text-slate-600">
              <span>保険総点数 (1点=10円)</span>
              <span className="font-mono font-semibold text-slate-900">
                {feeCalc.totalPoints.toLocaleString()} 点 (¥{feeCalc.totalMedicalYen.toLocaleString()})
              </span>
            </div>
            <div className="flex justify-between text-xs text-slate-600">
              <span>端数処理（健康保険法第75条 10円未満四捨五入）</span>
              <span className="font-mono">適用済</span>
            </div>
            <div className="pt-2 border-t border-slate-200 flex items-baseline justify-between">
              <span className="text-sm font-bold text-slate-900">今回窓口請求額（一部負担金）</span>
              <span className="text-xl font-bold font-mono text-teal-800">
                ¥{feeCalc.copayAmountYen.toLocaleString()}
              </span>
            </div>
          </div>

          <div className="flex items-center gap-2 pt-1">
            <button
              type="button"
              disabled={!canSettleBilling || selectedPatient.billingCompleted}
              onClick={handleSettleClick}
              className="flex-1 py-2.5 px-4 text-xs font-semibold text-white bg-teal-700 hover:bg-teal-800 disabled:bg-slate-300 rounded-lg transition-colors flex items-center justify-center gap-1.5"
            >
              <CreditCard className="w-4 h-4" />
              {selectedPatient.billingCompleted
                ? '会計精算・領収書発行済み'
                : '会計完了・領収書/処方箋を発行'}
            </button>
          </div>

          <p className="text-[11px] text-slate-500 leading-relaxed">
            発行元：{CLINIC_INFO.name}（医療機関コード：{CLINIC_INFO.facilityCode}）
          </p>
        </div>
      </div>
    </div>
  );
};
