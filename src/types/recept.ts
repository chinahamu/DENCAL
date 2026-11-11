export interface PerformedProcedure {
  id: string;
  code: string;
  name: string;
  performedOn: string | null;
  quantity: number;
  unit: string | null;
  cancelledAt: string | null;
  cancellationReason: string | null;
}

export interface ReceptReceipt {
  integrationId: string;
  bodySha256: string;
  status: 'received' | 'confirmation_required' | 'applied' | 'rejected';
  issues: { code: string; path: string }[];
}

export interface ReceptOutboxItem {
  id: string;
  chartRevision: number;
  transferRevision: number;
  event: 'initial' | 'correction' | 'cancel';
  queuedAt: string;
  attempts: number;
  sending: boolean;
  receipt: ReceptReceipt | null;
  lastError: string | null;
  diagnosisCodes: string[];
  performedItems: { id: string; code: string; performedOn: string; quantity: number; unit: string; status: 'performed' | 'cancelled' }[];
}

export interface ReceptWorkspace {
  performances: PerformedProcedure[];
  outbox: ReceptOutboxItem[];
  facilityId: string;
  senderId: string;
  visitDate: string;
  today: string;
  finalized: boolean;
  performanceVersion: string;
  chartRevision: number | null;
  transportConfigured: boolean;
}
