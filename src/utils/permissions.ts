import type { UserRole } from '../types/emr';

const rank: Record<UserRole, number> = { clerk: 1, nurse: 2, doctor: 3, admin: 4 };
const minimum = {
  view_chart: 'clerk',
  register_patient: 'clerk',
  settle_billing: 'clerk',
  record_vitals: 'nurse',
  edit_soap: 'doctor',
  sign_soap: 'doctor',
  add_prescription: 'doctor',
  create_backup: 'admin',
  restore_backup: 'admin',
  view_audit: 'admin',
} satisfies Record<string, UserRole>;

export type EmrAction = keyof typeof minimum;

export function isEmrAction(value: string): value is EmrAction {
  return Object.hasOwn(minimum, value);
}

export function canPerformAction(role: UserRole, action: EmrAction): boolean {
  return rank[role] >= rank[minimum[action]];
}
