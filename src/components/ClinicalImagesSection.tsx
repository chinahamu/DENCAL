import React, { useMemo, useRef, useState } from 'react';
import {
  ArrowRight,
  Camera,
  Columns2,
  Edit3,
  ImagePlus,
  Maximize2,
  Trash2,
  X,
} from 'lucide-react';
import type { ClinicalImageItem, ClinicalImagePhase } from '../types/emr';

export interface ClinicalImageUploadInput {
  id: string;
  phase: ClinicalImagePhase;
  pairGroupId?: string;
  bodySite: string;
  takenAt: string;
  caption: string;
  mimeType: 'image/jpeg' | 'image/png' | 'image/webp';
  width: number;
  height: number;
  base64Data: string;
}

export interface ClinicalImageUpdateInput {
  id: string;
  phase: ClinicalImagePhase;
  pairGroupId?: string;
  bodySite: string;
  takenAt: string;
  caption: string;
}

interface ClinicalImagesSectionProps {
  patientId: string;
  images: ClinicalImageItem[];
  canEditImages: boolean;
  canQuoteToSoap: boolean;
  onAddImage: (input: ClinicalImageUploadInput) => Promise<boolean>;
  onUpdateImage: (input: ClinicalImageUpdateInput) => Promise<boolean>;
  onRemoveImage: (imageId: string) => Promise<boolean>;
  onQuoteToObjective?: (text: string) => void;
}

export const PHASE_LABELS: Record<ClinicalImagePhase, string> = {
  before: '処置前 (Before)',
  after: '処置後 (After)',
  progress: '経過 (Progress)',
  single: '単発所見 (Single)',
};

const PHASE_BADGE_STYLES: Record<ClinicalImagePhase, string> = {
  before: 'bg-amber-100 text-amber-900 border-amber-300',
  after: 'bg-emerald-100 text-emerald-900 border-emerald-300',
  progress: 'bg-blue-100 text-blue-900 border-blue-300',
  single: 'bg-slate-100 text-slate-800 border-slate-300',
};

const BODY_SITE_PRESETS = [
  '顔面・頭部',
  '口腔・咽頭',
  '頸部',
  '胸部・背部',
  '腹部',
  '右上肢・手',
  '左上肢・手',
  '右下肢・足',
  '左下肢・足',
];

function currentLocalDateTime() {
  return new Date().toLocaleString('sv-SE', { timeZone: 'Asia/Tokyo' }).slice(0, 16);
}

export function imageEndpointUrl(patientId: string, imageId: string): string {
  return `/api/clinical/patients/${encodeURIComponent(patientId)}/images/${encodeURIComponent(imageId)}`;
}

async function readImageFile(
  file: File,
  autoResize: boolean,
): Promise<{
  mimeType: 'image/jpeg' | 'image/png' | 'image/webp';
  width: number;
  height: number;
  base64Data: string;
  previewUrl: string;
}> {
  const validMimes = ['image/jpeg', 'image/png', 'image/webp'] as const;
  const fallbackMime: 'image/jpeg' | 'image/png' | 'image/webp' =
    validMimes.find((m) => m === file.type) ?? 'image/jpeg';

  const dataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => (typeof reader.result === 'string' ? resolve(reader.result) : reject(new Error('画像を読み込めません')));
    reader.onerror = () => reject(new Error('ファイルの読み込みに失敗しました'));
    reader.readAsDataURL(file);
  });

  const img = await new Promise<HTMLImageElement>((resolve, reject) => {
    const element = new Image();
    element.onload = () => resolve(element);
    element.onerror = () => reject(new Error('有効な画像ファイルを選択してください（JPEG / PNG / WebP）'));
    element.src = dataUrl;
  });

  const maxDimension = 1920;
  let targetWidth = img.naturalWidth || img.width || 1;
  let targetHeight = img.naturalHeight || img.height || 1;
  const needsResize = autoResize && (targetWidth > maxDimension || targetHeight > maxDimension);

  if (needsResize) {
    const scale = maxDimension / Math.max(targetWidth, targetHeight);
    targetWidth = Math.max(1, Math.round(targetWidth * scale));
    targetHeight = Math.max(1, Math.round(targetHeight * scale));
    const canvas = document.createElement('canvas');
    canvas.width = targetWidth;
    canvas.height = targetHeight;
    const ctx = canvas.getContext('2d');
    if (ctx) {
      ctx.drawImage(img, 0, 0, targetWidth, targetHeight);
      const outputMime = fallbackMime === 'image/png' ? 'image/png' : 'image/jpeg';
      const resizedUrl = canvas.toDataURL(outputMime, 0.88);
      return {
        mimeType: outputMime,
        width: targetWidth,
        height: targetHeight,
        base64Data: resizedUrl,
        previewUrl: resizedUrl,
      };
    }
  }

  return {
    mimeType: fallbackMime,
    width: targetWidth,
    height: targetHeight,
    base64Data: dataUrl,
    previewUrl: dataUrl,
  };
}

export const ClinicalImagesSection: React.FC<ClinicalImagesSectionProps> = ({
  patientId,
  images,
  canEditImages,
  canQuoteToSoap,
  onAddImage,
  onUpdateImage,
  onRemoveImage,
  onQuoteToObjective,
}) => {
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [showAddForm, setShowAddForm] = useState(false);
  const [autoResize, setAutoResize] = useState(true);
  const [selectedFile, setSelectedFile] = useState<{
    name: string;
    mimeType: 'image/jpeg' | 'image/png' | 'image/webp';
    width: number;
    height: number;
    base64Data: string;
    previewUrl: string;
  } | null>(null);
  const [phase, setPhase] = useState<ClinicalImagePhase>('before');
  const [bodySite, setBodySite] = useState('');
  const [pairGroupId, setPairGroupId] = useState('');
  const [takenAt, setTakenAt] = useState(currentLocalDateTime);
  const [caption, setCaption] = useState('');
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Editing existing metadata state
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editPhase, setEditPhase] = useState<ClinicalImagePhase>('before');
  const [editBodySite, setEditBodySite] = useState('');
  const [editPairGroupId, setEditPairGroupId] = useState('');
  const [editTakenAt, setEditTakenAt] = useState('');
  const [editCaption, setEditCaption] = useState('');

  // Lightbox / comparison modal state
  const [modalPairGroup, setModalPairGroup] = useState<string | null>(null);
  const [modalSingleImage, setModalSingleImage] = useState<ClinicalImageItem | null>(null);

  // Group images by pairGroupId for Before/After comparison cards
  const { pairedGroups, ungroupedImages, existingGroups } = useMemo(() => {
    const groups = new Map<string, ClinicalImageItem[]>();
    const singles: ClinicalImageItem[] = [];
    for (const img of images) {
      if (img.pairGroupId) {
        const list = groups.get(img.pairGroupId) ?? [];
        list.push(img);
        groups.set(img.pairGroupId, list);
      } else {
        singles.push(img);
      }
    }
    const phaseRank: Record<ClinicalImagePhase, number> = { before: 0, progress: 1, after: 2, single: 3 };
    const paired: { groupId: string; items: ClinicalImageItem[] }[] = [];
    for (const [groupId, list] of groups.entries()) {
      paired.push({
        groupId,
        items: [...list].sort((a, b) => phaseRank[a.phase] - phaseRank[b.phase] || a.takenAt.localeCompare(b.takenAt)),
      });
    }
    return {
      pairedGroups: paired,
      ungroupedImages: singles,
      existingGroups: Array.from(groups.keys()),
    };
  }, [images]);

  async function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setErrorMsg(null);
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) {
      setErrorMsg('JPEG、PNG、または WebP 形式の画像ファイルを選択してください。');
      return;
    }
    try {
      const processed = await readImageFile(file, autoResize);
      setSelectedFile({ name: file.name, ...processed });
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : '画像の読み込みに失敗しました。');
    }
  }

  function startPairAfterFor(sourceImg: ClinicalImageItem) {
    const groupLabel = sourceImg.pairGroupId || `${sourceImg.bodySite} ビフォーアフター`;
    setShowAddForm(true);
    setPhase('after');
    setBodySite(sourceImg.bodySite);
    setPairGroupId(groupLabel);
    setTakenAt(currentLocalDateTime());
    setCaption('');
    setErrorMsg(null);
    // If source image didn't have a pairGroupId yet, we can also update it or let the user group them
    if (!sourceImg.pairGroupId && canEditImages) {
      void onUpdateImage({
        id: sourceImg.id,
        phase: sourceImg.phase,
        pairGroupId: groupLabel,
        bodySite: sourceImg.bodySite,
        takenAt: sourceImg.takenAt,
        caption: sourceImg.caption,
      });
    }
  }

  function beginEdit(img: ClinicalImageItem) {
    setEditingId(img.id);
    setEditPhase(img.phase);
    setEditBodySite(img.bodySite);
    setEditPairGroupId(img.pairGroupId ?? '');
    setEditTakenAt(img.takenAt);
    setEditCaption(img.caption);
  }

  async function handleSaveEdit(e: React.FormEvent) {
    e.preventDefault();
    if (!editingId || !editBodySite.trim() || busy) return;
    setBusy(true);
    try {
      const ok = await onUpdateImage({
        id: editingId,
        phase: editPhase,
        pairGroupId: editPairGroupId.trim() || undefined,
        bodySite: editBodySite.trim(),
        takenAt: editTakenAt.trim() || currentLocalDateTime(),
        caption: editCaption.trim(),
      });
      if (ok) setEditingId(null);
    } finally {
      setBusy(false);
    }
  }

  async function handleSubmitAdd(e: React.FormEvent) {
    e.preventDefault();
    if (!selectedFile || !bodySite.trim() || busy) return;
    setBusy(true);
    setErrorMsg(null);
    try {
      const resolvedPairGroup =
        pairGroupId.trim() ||
        (phase === 'before' || phase === 'after' ? `${bodySite.trim()} 処置前後比較` : undefined);
      const ok = await onAddImage({
        id: `img-${crypto.randomUUID()}`,
        phase,
        pairGroupId: resolvedPairGroup,
        bodySite: bodySite.trim(),
        takenAt: takenAt.trim() || currentLocalDateTime(),
        caption: caption.trim(),
        mimeType: selectedFile.mimeType,
        width: selectedFile.width,
        height: selectedFile.height,
        base64Data: selectedFile.base64Data,
      });
      if (ok) {
        setSelectedFile(null);
        setCaption('');
        if (fileInputRef.current) fileInputRef.current.value = '';
        setShowAddForm(false);
      }
    } finally {
      setBusy(false);
    }
  }

  function buildObjectiveQuote(): string {
    if (images.length === 0) return '';
    const summaries = images.map((img) => {
      const note = img.caption ? `：${img.caption}` : '';
      return `${img.bodySite}（${PHASE_LABELS[img.phase]}・${img.takenAt}）${note}`;
    });
    return `【処置・患部画像 (${images.length}枚)】${summaries.join(' / ')}。`;
  }

  const activeModalPair = pairedGroups.find((g) => g.groupId === modalPairGroup);

  return (
    <div className="pt-4 border-t border-slate-200 space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h3 className="text-sm font-bold text-slate-900 flex items-center gap-1.5">
            <Camera className="w-4 h-4 text-teal-700" />
            <span>患部・処置画像（ビフォーアフター比較・所見添付）</span>
            <span className="text-xs font-semibold text-slate-500 tabular-nums ml-1">
              ({images.length} 枚登録中)
            </span>
          </h3>
          <p className="text-xs text-slate-500 mt-0.5">
            処置前（Before）・処置後（After）・経過写真を登録し、並列比較できます。確定時に画像のSHA-256ハッシュも診療録に固定されます。
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {canQuoteToSoap && images.length > 0 && onQuoteToObjective && (
            <button
              type="button"
              onClick={() => onQuoteToObjective(buildObjectiveQuote())}
              className="px-2.5 py-1.5 text-xs font-semibold text-teal-800 bg-teal-50 hover:bg-teal-100 border border-teal-200 rounded-md transition-colors"
            >
              + 処置画像所見を O欄へ引用
            </button>
          )}
          {canEditImages && (
            <button
              type="button"
              onClick={() => {
                setShowAddForm(!showAddForm);
                setErrorMsg(null);
              }}
              className="px-3 py-1.5 text-xs font-semibold text-white bg-teal-700 hover:bg-teal-800 rounded-md flex items-center gap-1.5 transition-colors"
            >
              <ImagePlus className="w-3.5 h-3.5" />
              {showAddForm ? '画像追加フォームを閉じる' : '患部・処置画像を追加'}
            </button>
          )}
        </div>
      </div>

      {/* Add New Image Form */}
      {showAddForm && canEditImages && (
        <form
          onSubmit={handleSubmitAdd}
          className="p-4 bg-slate-50 border border-slate-200 rounded-lg space-y-3"
        >
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="text-xs font-bold text-slate-800">新規処置画像の添付</span>
            <label className="flex items-center gap-1.5 text-xs text-slate-600 cursor-pointer">
              <input
                type="checkbox"
                checked={autoResize}
                onChange={(e) => setAutoResize(e.target.checked)}
              />
              高解像度写真を長辺1920px以下に自動最適化して保存
            </label>
          </div>

          {errorMsg && (
            <p role="alert" className="text-xs text-red-700 font-medium">
              {errorMsg}
            </p>
          )}

          <div className="grid grid-cols-1 lg:grid-cols-12 gap-4 items-start">
            {/* File selection and preview */}
            <div className="lg:col-span-5 space-y-2">
              <label className="block text-xs font-semibold text-slate-700">
                画像ファイル（JPEG / PNG / WebP · 最大5MiB）
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="image/jpeg,image/png,image/webp"
                  onChange={handleFileChange}
                  className="mt-1 block w-full text-xs text-slate-700 file:mr-2 file:py-1.5 file:px-3 file:rounded file:border-0 file:text-xs file:font-semibold file:bg-teal-700 file:text-white hover:file:bg-teal-800"
                />
              </label>
              {selectedFile ? (
                <div className="p-2 bg-white border border-slate-200 rounded-md space-y-1.5">
                  <img
                    src={selectedFile.previewUrl}
                    alt="選択中の処置画像プレビュー"
                    className="max-h-44 w-auto mx-auto rounded object-contain"
                  />
                  <div className="text-[11px] text-slate-500 text-center font-mono tabular-nums">
                    {selectedFile.name} ({selectedFile.width}×{selectedFile.height}px)
                  </div>
                </div>
              ) : (
                <div className="h-32 border-2 border-dashed border-slate-300 rounded-md flex items-center justify-center text-xs text-slate-400 bg-white">
                  画像ファイルを選択するとプレビューが表示されます
                </div>
              )}
            </div>

            {/* Metadata inputs */}
            <div className="lg:col-span-7 space-y-3 text-xs">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <label className="grid gap-1 font-semibold text-slate-700">
                  撮影ステージ（区分）
                  <select
                    value={phase}
                    onChange={(e) => setPhase(e.target.value as ClinicalImagePhase)}
                    className="rounded border border-slate-300 bg-white px-2.5 py-1.5 text-slate-900"
                  >
                    <option value="before">処置前 (Before)</option>
                    <option value="after">処置後 (After)</option>
                    <option value="progress">経過観察 (Progress)</option>
                    <option value="single">単発所見 (Single)</option>
                  </select>
                </label>

                <label className="grid gap-1 font-semibold text-slate-700">
                  撮影日時
                  <input
                    type="text"
                    value={takenAt}
                    onChange={(e) => setTakenAt(e.target.value)}
                    placeholder="2026-11-24 16:30"
                    maxLength={32}
                    className="rounded border border-slate-300 bg-white px-2.5 py-1.5 font-mono"
                  />
                </label>
              </div>

              <div className="space-y-1">
                <label className="block font-semibold text-slate-700">
                  対象部位（必須）
                  <input
                    type="text"
                    required
                    value={bodySite}
                    onChange={(e) => setBodySite(e.target.value)}
                    placeholder="例：右前腕屈側、左頬部など"
                    maxLength={128}
                    className="mt-1 w-full rounded border border-slate-300 bg-white px-2.5 py-1.5"
                  />
                </label>
                <div className="flex flex-wrap items-center gap-1 pt-0.5">
                  <span className="text-[11px] text-slate-500 mr-1">部位クイック選択:</span>
                  {BODY_SITE_PRESETS.map((preset) => (
                    <button
                      key={preset}
                      type="button"
                      onClick={() => setBodySite(preset)}
                      className="px-2 py-0.5 text-[11px] bg-white hover:bg-teal-50 text-slate-700 border border-slate-200 rounded"
                    >
                      {preset}
                    </button>
                  ))}
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <label className="grid gap-1 font-semibold text-slate-700">
                  ビフォーアフター比較グループ名（任意）
                  <input
                    type="text"
                    list={`pair-groups-${patientId}`}
                    value={pairGroupId}
                    onChange={(e) => setPairGroupId(e.target.value)}
                    placeholder="同じ名前で処置前後を並列表示"
                    maxLength={128}
                    className="rounded border border-slate-300 bg-white px-2.5 py-1.5"
                  />
                  <datalist id={`pair-groups-${patientId}`}>
                    {existingGroups.map((g) => (
                      <option key={g} value={g} />
                    ))}
                  </datalist>
                </label>

                <label className="grid gap-1 font-semibold text-slate-700">
                  処置メモ・画像所見コメント
                  <input
                    type="text"
                    value={caption}
                    onChange={(e) => setCaption(e.target.value)}
                    placeholder="例：デブリードマン・縫合処置後、止血良好"
                    maxLength={2000}
                    className="rounded border border-slate-300 bg-white px-2.5 py-1.5"
                  />
                </label>
              </div>

              <div className="flex justify-end gap-2 pt-1">
                <button
                  type="button"
                  onClick={() => setShowAddForm(false)}
                  className="px-3 py-1.5 text-xs font-semibold text-slate-700 border border-slate-300 bg-white rounded hover:bg-slate-100"
                >
                  キャンセル
                </button>
                <button
                  type="submit"
                  disabled={busy || !selectedFile || !bodySite.trim()}
                  className="px-4 py-1.5 text-xs font-semibold text-white bg-teal-700 hover:bg-teal-800 rounded disabled:opacity-50"
                >
                  {busy ? '保存中…' : 'カルテ下書きに画像を追加'}
                </button>
              </div>
            </div>
          </div>
        </form>
      )}

      {/* Empty State */}
      {images.length === 0 ? (
        <div className="p-4 bg-slate-50 border border-slate-200 rounded-md text-xs text-slate-500 text-center">
          患部・処置画像はまだ添付されていません。
        </div>
      ) : (
        <div className="space-y-4">
          {/* Before / After Paired Comparison Cards */}
          {pairedGroups.map(({ groupId, items }) => {
            const hasBefore = items.some((i) => i.phase === 'before');
            const hasAfter = items.some((i) => i.phase === 'after');
            const firstItem = items[0];
            return (
              <div
                key={groupId}
                className="border border-slate-200 rounded-lg bg-slate-50/70 overflow-hidden"
              >
                <div className="px-3.5 py-2 bg-slate-100 border-b border-slate-200 flex flex-wrap items-center justify-between gap-2">
                  <div className="flex items-center gap-2 text-xs">
                    <Columns2 className="w-3.5 h-3.5 text-teal-700" />
                    <span className="font-bold text-slate-900">{groupId}</span>
                    <span className="text-slate-500">({items.length}枚)</span>
                    {hasBefore && hasAfter && (
                      <span className="px-2 py-0.5 text-[11px] font-semibold bg-teal-100 text-teal-900 rounded">
                        ビフォーアフター比較済
                      </span>
                    )}
                  </div>
                  <div className="flex items-center gap-2">
                    {items.length >= 2 && (
                      <button
                        type="button"
                        onClick={() => setModalPairGroup(groupId)}
                        className="px-2.5 py-1 text-xs font-semibold text-teal-800 bg-white hover:bg-teal-50 border border-slate-300 rounded flex items-center gap-1"
                      >
                        <Maximize2 className="w-3 h-3" />
                        並列拡大比較
                      </button>
                    )}
                    {canEditImages && hasBefore && !hasAfter && firstItem && (
                      <button
                        type="button"
                        onClick={() => startPairAfterFor(firstItem)}
                        className="px-2.5 py-1 text-xs font-semibold text-white bg-teal-700 hover:bg-teal-800 rounded flex items-center gap-1"
                      >
                        <ArrowRight className="w-3 h-3" />
                        処置後 (After) 画像を追加
                      </button>
                    )}
                  </div>
                </div>

                <div className="p-3 grid grid-cols-1 md:grid-cols-2 gap-3">
                  {items.map((img) => renderImageCard(img))}
                </div>
              </div>
            );
          })}

          {/* Ungrouped / Single Images */}
          {ungroupedImages.length > 0 && (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              {ungroupedImages.map((img) => renderImageCard(img))}
            </div>
          )}
        </div>
      )}

      {/* Lightbox Modal for Paired Comparison or Single Zoom */}
      {(activeModalPair || modalSingleImage) && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="処置画像の拡大比較プレビュー"
          className="fixed inset-0 z-50 bg-slate-900/75 flex items-center justify-center p-4"
        >
          <div className="bg-white rounded-lg max-w-5xl w-full max-h-[90vh] overflow-y-auto p-5 space-y-4 shadow-xl">
            <div className="flex items-center justify-between border-b border-slate-200 pb-3">
              <h4 className="text-sm font-bold text-slate-900">
                {activeModalPair
                  ? `ビフォーアフター並列比較：${activeModalPair.groupId}`
                  : `${modalSingleImage?.bodySite}（${modalSingleImage ? PHASE_LABELS[modalSingleImage.phase] : ''}）`}
              </h4>
              <button
                type="button"
                aria-label="拡大表示を閉じる"
                onClick={() => {
                  setModalPairGroup(null);
                  setModalSingleImage(null);
                }}
                className="p-1.5 text-slate-500 hover:text-slate-900 rounded border border-slate-200"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            {activeModalPair ? (
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                {activeModalPair.items.map((img) => (
                  <div key={img.id} className="border border-slate-200 rounded-md p-3 space-y-2 bg-slate-50">
                    <div className="flex items-center justify-between text-xs">
                      <span className={`px-2 py-0.5 rounded border font-bold ${PHASE_BADGE_STYLES[img.phase]}`}>
                        {PHASE_LABELS[img.phase]}
                      </span>
                      <span className="font-mono text-slate-600">{img.takenAt}</span>
                    </div>
                    <img
                      src={imageEndpointUrl(patientId, img.id)}
                      alt={`${img.bodySite} ${PHASE_LABELS[img.phase]}`}
                      className="max-h-[55vh] w-auto mx-auto rounded object-contain bg-white"
                    />
                    <div className="text-xs text-slate-800">
                      <div className="font-bold">{img.bodySite}</div>
                      {img.caption && <p className="mt-0.5 text-slate-700">{img.caption}</p>}
                      <p className="mt-1 text-[11px] font-mono text-slate-500 break-all">
                        SHA-256: {img.sha256}
                      </p>
                    </div>
                  </div>
                ))}
              </div>
            ) : modalSingleImage ? (
              <div className="space-y-3">
                <img
                  src={imageEndpointUrl(patientId, modalSingleImage.id)}
                  alt={modalSingleImage.bodySite}
                  className="max-h-[65vh] w-auto mx-auto rounded object-contain bg-slate-50"
                />
                <div className="text-xs text-slate-700 space-y-1">
                  <div>
                    <span className="font-bold">{modalSingleImage.bodySite}</span> · 撮影日時:{' '}
                    {modalSingleImage.takenAt} · 登録者: {modalSingleImage.uploadedBy}
                  </div>
                  {modalSingleImage.caption && <p>{modalSingleImage.caption}</p>}
                  <div className="font-mono text-[11px] text-slate-500 break-all">
                    SHA-256: {modalSingleImage.sha256}
                  </div>
                </div>
              </div>
            ) : null}
          </div>
        </div>
      )}
    </div>
  );

  function renderImageCard(img: ClinicalImageItem) {
    const isEditing = editingId === img.id;
    return (
      <div
        key={img.id}
        className="bg-white border border-slate-200 rounded-md p-3 flex flex-col justify-between gap-2.5"
      >
        <div className="space-y-2">
          <div className="flex flex-wrap items-center justify-between gap-1.5">
            <div className="flex items-center gap-1.5">
              <span
                className={`px-2 py-0.5 text-[11px] font-bold rounded border ${PHASE_BADGE_STYLES[img.phase]}`}
              >
                {PHASE_LABELS[img.phase]}
              </span>
              <span className="text-xs font-bold text-slate-900">{img.bodySite}</span>
            </div>
            <span className="text-[11px] font-mono text-slate-500 tabular-nums">{img.takenAt}</span>
          </div>

          <div className="relative bg-slate-50 border border-slate-200 rounded overflow-hidden flex items-center justify-center min-h-36">
            <img
              src={imageEndpointUrl(patientId, img.id)}
              alt={`${img.bodySite} (${PHASE_LABELS[img.phase]})`}
              className="max-h-48 w-auto object-contain cursor-pointer"
              onClick={() => setModalSingleImage(img)}
            />
            <button
              type="button"
              onClick={() => setModalSingleImage(img)}
              aria-label={`${img.bodySite}の画像を拡大表示`}
              className="absolute top-1.5 right-1.5 p-1 bg-white/90 hover:bg-white text-slate-700 rounded border border-slate-300 shadow-2xs"
              title="拡大表示"
            >
              <Maximize2 className="w-3.5 h-3.5" />
            </button>
          </div>

          {isEditing ? (
            <form onSubmit={handleSaveEdit} className="space-y-2 pt-1 text-xs border-t border-slate-200">
              <div className="grid grid-cols-2 gap-2">
                <label className="grid gap-0.5">
                  区分
                  <select
                    value={editPhase}
                    onChange={(e) => setEditPhase(e.target.value as ClinicalImagePhase)}
                    className="rounded border border-slate-300 px-2 py-1"
                  >
                    <option value="before">処置前 (Before)</option>
                    <option value="after">処置後 (After)</option>
                    <option value="progress">経過 (Progress)</option>
                    <option value="single">単発所見 (Single)</option>
                  </select>
                </label>
                <label className="grid gap-0.5">
                  部位
                  <input
                    type="text"
                    required
                    value={editBodySite}
                    onChange={(e) => setEditBodySite(e.target.value)}
                    className="rounded border border-slate-300 px-2 py-1"
                  />
                </label>
              </div>
              <div className="grid grid-cols-2 gap-2">
                <label className="grid gap-0.5">
                  比較グループ名
                  <input
                    type="text"
                    value={editPairGroupId}
                    onChange={(e) => setEditPairGroupId(e.target.value)}
                    className="rounded border border-slate-300 px-2 py-1"
                  />
                </label>
                <label className="grid gap-0.5">
                  撮影日時
                  <input
                    type="text"
                    value={editTakenAt}
                    onChange={(e) => setEditTakenAt(e.target.value)}
                    className="rounded border border-slate-300 px-2 py-1 font-mono"
                  />
                </label>
              </div>
              <label className="grid gap-0.5">
                所見コメント
                <input
                  type="text"
                  value={editCaption}
                  onChange={(e) => setEditCaption(e.target.value)}
                  className="rounded border border-slate-300 px-2 py-1"
                />
              </label>
              <div className="flex justify-end gap-1.5">
                <button
                  type="button"
                  onClick={() => setEditingId(null)}
                  className="px-2.5 py-1 border border-slate-300 rounded text-slate-700"
                >
                  取消
                </button>
                <button
                  type="submit"
                  disabled={busy}
                  className="px-2.5 py-1 bg-teal-700 text-white rounded font-semibold"
                >
                  更新
                </button>
              </div>
            </form>
          ) : (
            <>
              {img.caption && <p className="text-xs text-slate-700">{img.caption}</p>}
              <div className="text-[11px] text-slate-500 font-mono tabular-nums flex flex-wrap items-center justify-between gap-1">
                <span>
                  {img.width}×{img.height}px · {Math.max(1, Math.round(img.byteSize / 1024))} KiB
                </span>
                <span title={img.sha256}>SHA-256: {img.sha256.slice(0, 12)}…</span>
              </div>
            </>
          )}
        </div>

        {canEditImages && !isEditing && (
          <div className="pt-2 border-t border-slate-100 flex flex-wrap items-center justify-between gap-2 text-xs">
            {img.phase === 'before' ? (
              <button
                type="button"
                onClick={() => startPairAfterFor(img)}
                className="text-teal-800 font-semibold hover:underline flex items-center gap-1"
              >
                <ArrowRight className="w-3 h-3" />
                この処置後(After)を追加
              </button>
            ) : (
              <span />
            )}
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => beginEdit(img)}
                className="text-slate-600 hover:text-slate-900 flex items-center gap-1"
              >
                <Edit3 className="w-3.5 h-3.5" />
                編集
              </button>
              <button
                type="button"
                aria-label={`${img.bodySite}の処置画像を削除`}
                onClick={() => void onRemoveImage(img.id)}
                className="text-slate-500 hover:text-red-700 flex items-center gap-1"
              >
                <Trash2 className="w-3.5 h-3.5" />
                除外
              </button>
            </div>
          </div>
        )}
      </div>
    );
  }
};

