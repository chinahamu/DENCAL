export interface FinalizedRecordResult {
  encounterId: number;
  revision: number;
  patientId: string;
  patientName: string;
  patientKana: string;
  visitDate: string;
  finalizedAt: string;
}

export interface FinalizedRecordPage {
  records: FinalizedRecordResult[];
  hasNext: boolean;
}

export interface FinalizedRecordDocument {
  filename: string;
  html: string;
}
