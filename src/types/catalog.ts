export const catalogKinds = {
  diagnosis: '傷病名',
  drug: '医薬品',
  procedure: '医科診療行為（検査候補）',
} as const;

export type CatalogKind = keyof typeof catalogKinds;
export const masterUploadLimit = 20 * 1024 * 1024;

export interface CatalogEntry {
  id: number;
  code: string;
  name: string;
  releaseDate: string;
  icd10: string;
  unit: string;
  drugForm: string;
  priceCode: string;
}

export interface CatalogRelease {
  kind: CatalogKind;
  releaseDate: string;
  importedAt: string;
  sha256: string;
  count: number;
}
