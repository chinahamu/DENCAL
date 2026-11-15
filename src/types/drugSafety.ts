export interface DrugSafetySection {
  section: string;
  body: string;
}

export interface DrugSafetyDocument {
  documentId: string;
  sourceFile: string;
  title: string;
  productName: string;
  revision: string;
  companyId: string;
  sha256: string;
  importedAt: string;
  sections: DrugSafetySection[];
}

export interface DrugSafetyResult {
  status: 'no_code' | 'not_imported' | 'not_found' | 'matched' | 'unavailable';
  yjCode: string;
  documents: DrugSafetyDocument[];
}
