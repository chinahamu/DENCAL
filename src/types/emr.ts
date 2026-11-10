export type UserRole = 'doctor' | 'nurse' | 'clerk' | 'admin';

export interface StaffMember {
  id: string;
  name: string;
  role: UserRole;
  roleLabel: string;
  department: string;
  hpkiCertId?: string; // 保健医療福祉分野公開鍵基盤 (HPKI) 医師資格証ID
  twoFactorEnabled: boolean;
}

export type VisitStatus = 'waiting' | 'in_consultation' | 'billing' | 'completed';

export interface AllergyItem {
  substance: string;
  category: 'drug' | 'food' | 'other';
  severity: 'severe' | 'moderate';
  reaction: string;
}

export interface DiseaseRecord {
  id: string;
  icd10Code: string;
  name: string;
  isMain: boolean;
  isChronicDiseaseTarget: boolean; // 特定疾患療養管理料対象
  startDate: string;
  outcome: 'ongoing' | 'cured' | 'suspected';
}

export interface VitalRecord {
  measuredAt: string;
  systolicBp: number;
  diastolicBp: number;
  pulse: number;
  temperature: number;
  spo2: number;
  weightKg: number;
  bmi: number;
}

export interface LabResultItem {
  code: string;
  name: string;
  value: number;
  unit: string;
  refMin: number;
  refMax: number;
  category: 'hematology' | 'biochemistry' | 'metabolism' | 'renal';
}

export interface LabPanelRecord {
  id: string;
  sampledAt: string;
  orderedBy: string;
  items: LabResultItem[];
}

export interface PrescriptionItem {
  id: string;
  yjCode: string;
  drugName: string;
  dosagePerDay: string;
  usage: string;
  days: number;
  category: 'internal' | 'external' | 'as_needed';
  genericAllowed: boolean;
  pointsPerDay: number;
}

export interface LabOrderItem {
  id: string;
  code: string;
  name: string;
  points: number;
}

export interface SoapContent {
  subjective: string;
  objective: string;
  assessment: string;
  plan: string;
}

export interface SoapRevision {
  revisionNumber: number;
  timestamp: string;
  authorId: string;
  authorName: string;
  authorRole: UserRole;
  hpkiSignatureId: string;
  reasonForRevision: string;
  soap: SoapContent;
  prescriptions: PrescriptionItem[];
  labOrders: LabOrderItem[];
  sha256Hash: string;
  previousHash: string;
}

export interface PatientRecord {
  id: string; // e.g., PT-001042
  kanjiName: string;
  kanaName: string;
  sex: '男性' | '女性';
  birthDate: string;
  age: number;
  bloodType: string;
  phone: string;
  address: string;
  insuranceType: '社保・本人' | '国保・一般' | '後期高齢者' | '公費併用';
  insurerNumber: string;
  copayRatio: 0.1 | 0.2 | 0.3;
  mynaVerified: boolean;
  visitType: '初診' | '再診';
  visitStatus: VisitStatus;
  receptionTime: string;
  receptionNumber: string;
  chiefComplaint: string;
  allergies: AllergyItem[];
  contraindicatedClasses: string[];
  diseases: DiseaseRecord[];
  vitalsHistory: VitalRecord[];
  labHistory: LabPanelRecord[];
  currentSoap: SoapContent;
  currentPrescriptions: PrescriptionItem[];
  currentLabOrders: LabOrderItem[];
  isSigned: boolean;
  signedAt?: string;
  signedBy?: string;
  hpkiCertId?: string;
  currentHash?: string;
  revisions: SoapRevision[];
  billingCompleted: boolean;
  receiptIssuedAt?: string;
}

export interface DrugCatalogItem {
  yjCode: string;
  drugName: string;
  drugClass: string;
  defaultDosage: string;
  defaultUsage: string;
  defaultDays: number;
  pointsPerDay: number;
  contraindicationKeywords: string[];
  renalCautionEgfrBelow?: number;
}

export interface FeeBreakdownItem {
  category: string;
  name: string;
  points: number;
  note?: string;
}

export interface MedicalFeeCalculationResult {
  items: FeeBreakdownItem[];
  totalPoints: number;
  totalMedicalYen: number;
  copayRatio: 0.1 | 0.2 | 0.3;
  copayAmountYen: number; // 10円単位四捨五入
}

export interface BackupSnapshot {
  id: string;
  createdAt: string;
  createdBy: string;
  type: 'auto_hourly' | 'daily_immutable' | 'manual_checkpoint';
  storageTier: '院内プライマリRAID10' | '院内隔離NAS (WORM不変)' | 'オフライン暗号化アーカイブ';
  patientCount: number;
  revisionCount: number;
  auditLogCount: number;
  sizeBytes: number;
  cipherSpec: 'AES-256-GCM / TLS 1.3';
  sha256Checksum: string;
  verifiedStatus: 'verified' | 'failed';
  lastVerifiedAt: string;
  payloadSnapshotJson: string;
}

export interface AuditLogEntry {
  id: string;
  timestamp: string;
  actorId: string;
  actorName: string;
  actorRole: UserRole;
  actionType:
    | 'RECORD_VIEW'
    | 'SOAP_SIGN'
    | 'SOAP_REVISION'
    | 'PRESCRIPTION_ADD'
    | 'PATIENT_REGISTER'
    | 'BILLING_SETTLE'
    | 'BACKUP_CREATE'
    | 'BACKUP_VERIFY'
    | 'BACKUP_RESTORE'
    | 'ROLE_SWITCH'
    | 'DOCUMENT_EXPORT';
  targetPatientId?: string;
  targetPatientName?: string;
  summary: string;
  integrityHash: string;
  ipAddress: string;
}

export interface MhlwComplianceItem {
  id: string;
  pillar: '真正性 (Authenticity)' | '見読性 (Readability)' | '保存性 (Preservability)' | '安全管理措置 (Security Governance)';
  sectionRef: string;
  title: string;
  requirement: string;
  implementationDetail: string;
  status: 'compliant' | 'attention';
}
