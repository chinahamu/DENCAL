import React, { useState } from 'react';
import { ShieldCheck, X } from 'lucide-react';
import { PatientRegistration } from '../types/emr';

interface NewPatientModalProps {
  isOpen: boolean;
  onClose: () => void;
  onRegisterPatient: (newPatient: PatientRegistration) => Promise<boolean>;
}

export const NewPatientModal: React.FC<NewPatientModalProps> = ({
  isOpen,
  onClose,
  onRegisterPatient,
}) => {
  const [kanjiName, setKanjiName] = useState('');
  const [kanaName, setKanaName] = useState('');
  const [sex, setSex] = useState<'男性' | '女性'>('男性');
  const [birthDate, setBirthDate] = useState('1980-05-15');
  const [bloodType, setBloodType] = useState('A型 Rh(+)');
  const [phone, setPhone] = useState('090-1234-5678');
  const [address, setAddress] = useState('東京都千代田区九段北1-4-8');
  const [insuranceType, setInsuranceType] = useState<
    '社保・本人' | '国保・一般' | '後期高齢者' | '公費併用'
  >('社保・本人');
  const [copayRatio, setCopayRatio] = useState<0.1 | 0.2 | 0.3>(0.3);
  const [chiefComplaint, setChiefComplaint] = useState('');
  const [mynaVerified, setMynaVerified] = useState(true);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const [submitting, setSubmitting] = useState(false);

  if (!isOpen) return null;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (submitting) return;
    if (!kanjiName.trim() || !kanaName.trim() || !chiefComplaint.trim()) {
      setErrorMessage('患者氏名・フリガナ・本日の主訴は必須入力項目です。');
      return;
    }

    setSubmitting(true);
    const saved = await onRegisterPatient({
      kanjiName, kanaName, sex, birthDate, bloodType, phone, address,
      insuranceType, copayRatio, chiefComplaint, mynaVerified,
    });
    setSubmitting(false);
    if (!saved) {
      setErrorMessage('患者を登録できませんでした。入力内容、職種と所属部署を確認してください。');
      return;
    }
    setKanjiName('');
    setKanaName('');
    setChiefComplaint('');
    setErrorMessage(null);
    onClose();
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="new-patient-modal-title"
      className="fixed inset-0 z-50 bg-slate-900/50 flex items-center justify-center p-4"
    >
      <div className="bg-white border border-slate-200 rounded-lg max-w-xl w-full p-5 space-y-4 shadow-lg">
        <div className="flex items-center justify-between border-b border-slate-200 pb-3">
          <div>
            <h2 id="new-patient-modal-title" className="text-base font-bold text-slate-900">
              新規来院受付・新患カルテ開設（第1号用紙）
            </h2>
            <p className="text-xs text-slate-500 mt-0.5">
              マイナ保険証オンライン資格確認または被保険者証情報を登録します。
            </p>
          </div>
          <button
            type="button"
            aria-label="モーダルを閉じる"
            onClick={onClose}
            className="p-1 text-slate-400 hover:text-slate-700"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {errorMessage && (
          <div role="alert" className="p-2.5 bg-red-50 border border-red-200 rounded text-xs text-red-800">
            {errorMessage}
          </div>
        )}

        <form onSubmit={handleSubmit} className="space-y-3 text-xs">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label htmlFor="np-kanji" className="block font-semibold text-slate-700 mb-1">
                患者氏名（漢字） *
              </label>
              <input
                id="np-kanji"
                type="text"
                value={kanjiName}
                onChange={(e) => setKanjiName(e.target.value)}
                placeholder="例：渡辺 恒一"
                className="w-full px-2.5 py-1.5 bg-white border border-slate-300 rounded text-slate-900"
              />
            </div>
            <div>
              <label htmlFor="np-kana" className="block font-semibold text-slate-700 mb-1">
                フリガナ（全角カナ） *
              </label>
              <input
                id="np-kana"
                type="text"
                value={kanaName}
                onChange={(e) => setKanaName(e.target.value)}
                placeholder="例：ワタナベ コウイチ"
                className="w-full px-2.5 py-1.5 bg-white border border-slate-300 rounded text-slate-900"
              />
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <div>
              <label htmlFor="np-sex" className="block font-semibold text-slate-700 mb-1">
                性別
              </label>
              <select
                id="np-sex"
                value={sex}
                onChange={(e) => setSex(e.target.value as '男性' | '女性')}
                className="w-full px-2.5 py-1.5 bg-white border border-slate-300 rounded text-slate-900"
              >
                <option value="男性">男性</option>
                <option value="女性">女性</option>
              </select>
            </div>
            <div>
              <label htmlFor="np-dob" className="block font-semibold text-slate-700 mb-1">
                生年月日
              </label>
              <input
                id="np-dob"
                type="date"
                value={birthDate}
                onChange={(e) => setBirthDate(e.target.value)}
                className="w-full px-2.5 py-1.5 bg-white border border-slate-300 rounded font-mono tabular-nums text-slate-900"
              />
            </div>
            <div>
              <label htmlFor="np-blood" className="block font-semibold text-slate-700 mb-1">
                血液型
              </label>
              <input
                id="np-blood"
                type="text"
                value={bloodType}
                onChange={(e) => setBloodType(e.target.value)}
                className="w-full px-2.5 py-1.5 bg-white border border-slate-300 rounded text-slate-900"
              />
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label htmlFor="np-ins" className="block font-semibold text-slate-700 mb-1">
                保険種別
              </label>
              <select
                id="np-ins"
                value={insuranceType}
                onChange={(e) =>
                  setInsuranceType(
                    e.target.value as '社保・本人' | '国保・一般' | '後期高齢者' | '公費併用'
                  )
                }
                className="w-full px-2.5 py-1.5 bg-white border border-slate-300 rounded text-slate-900"
              >
                <option value="社保・本人">社保・本人 (3割)</option>
                <option value="国保・一般">国保・一般 (3割)</option>
                <option value="後期高齢者">後期高齢者 (1割/2割)</option>
                <option value="公費併用">公費併用</option>
              </select>
            </div>
            <div>
              <label htmlFor="np-copay" className="block font-semibold text-slate-700 mb-1">
                窓口負担割合
              </label>
              <select
                id="np-copay"
                value={copayRatio}
                onChange={(e) => setCopayRatio(Number(e.target.value) as 0.1 | 0.2 | 0.3)}
                className="w-full px-2.5 py-1.5 bg-white border border-slate-300 rounded font-mono tabular-nums text-slate-900"
              >
                <option value={0.3}>3割負担</option>
                <option value={0.2}>2割負担</option>
                <option value={0.1}>1割負担</option>
              </select>
            </div>
          </div>

          <div>
            <label htmlFor="np-complaint" className="block font-semibold text-slate-700 mb-1">
              本日の主訴・来院目的 *
            </label>
            <input
              id="np-complaint"
              type="text"
              value={chiefComplaint}
              onChange={(e) => setChiefComplaint(e.target.value)}
              placeholder="例：昨日からの咳・微熱、健康診断での血圧高値指摘など"
              className="w-full px-2.5 py-1.5 bg-white border border-slate-300 rounded text-slate-900"
            />
          </div>

          <label className="p-2.5 bg-teal-50/60 border border-teal-200 rounded flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={mynaVerified}
              onChange={(e) => setMynaVerified(e.target.checked)}
              className="accent-teal-700"
            />
            <ShieldCheck className="w-4 h-4 text-teal-700 shrink-0" />
            <span className="font-medium text-slate-800">
              マイナ保険証（オンライン資格確認端末）による受給資格・薬剤情報同意を確認済
            </span>
          </label>

          <div className="pt-2 flex items-center justify-end gap-2 border-t border-slate-200">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 text-xs font-medium text-slate-700 bg-slate-100 hover:bg-slate-200 rounded-md"
            >
              キャンセル
            </button>
            <button
              type="submit" disabled={submitting}
              className="px-4 py-2 text-xs font-semibold text-white bg-teal-700 hover:bg-teal-800 rounded-md"
            >
              受付確定・カルテを開設
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
