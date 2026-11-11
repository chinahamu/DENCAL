import type { IncomingMessage } from 'node:http';
import type { AllergyItem, DiseaseRecord, LabOrderItem, MasterReference, PatientRegistration, PrescriptionItem, SoapContent, VitalRecord } from '../src/types/emr';

export class ClinicalError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

export function invalidInput(): never {
  throw new ClinicalError(400, 'invalid_input');
}

export async function readClinicalInput(req: IncomingMessage): Promise<unknown> {
  if (req.headers['content-type']?.split(';')[0] !== 'application/json') invalidInput();
  const length = Number(req.headers['content-length']);
  if (!Number.isSafeInteger(length) || length < 1 || length > 128 * 1024) invalidInput();
  const chunks: Buffer[] = [];
  try {
    for await (const chunk of req) chunks.push(chunk);
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    return invalidInput();
  }
}

export function object(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) invalidInput();
  return value as Record<string, unknown>;
}

export function string(value: unknown, max = 256): string {
  if (typeof value !== 'string' || value.length > max) invalidInput();
  return value;
}

export function requiredText(value: unknown, max = 256): string {
  const text = string(value, max).trim();
  return text || invalidInput();
}

function choice<T extends string | number>(value: unknown, values: readonly T[]): T {
  return values.find((entry) => entry === value) ?? invalidInput();
}

function boolean(value: unknown): boolean {
  if (typeof value !== 'boolean') invalidInput();
  return value;
}

function number(value: unknown, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) invalidInput();
  return value;
}

function date(value: unknown): string {
  const input = requiredText(value, 10);
  const parsed = new Date(input + 'T00:00:00Z');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input) || !Number.isFinite(parsed.getTime()) ||
      parsed.toISOString().slice(0, 10) !== input) invalidInput();
  return input;
}

function masterReference(value: unknown): MasterReference | undefined {
  if (value === undefined) return undefined;
  const input = object(value);
  const itemId = number(input.itemId, 1, Number.MAX_SAFE_INTEGER);
  if (!Number.isInteger(itemId)) invalidInput();
  return { itemId, code: requiredText(input.code), releaseDate: date(input.releaseDate) };
}

const soapFields = ['subjective', 'objective', 'assessment', 'plan'] as const;

export function soapPatch(value: unknown): Partial<SoapContent> {
  const input = object(value);
  const patch: Partial<SoapContent> = {};
  for (const field of soapFields) {
    if (Object.hasOwn(input, field)) patch[field] = string(input[field], 16_000);
  }
  if (!Object.keys(patch).length || Object.keys(input).length !== Object.keys(patch).length) invalidInput();
  return patch;
}

export function registration(value: unknown): PatientRegistration {
  const input = object(value);
  return {
    kanjiName: requiredText(input.kanjiName),
    kanaName: requiredText(input.kanaName),
    sex: choice(input.sex, ['男性', '女性']),
    birthDate: date(input.birthDate),
    bloodType: string(input.bloodType),
    phone: string(input.phone),
    address: string(input.address),
    insuranceType: choice(input.insuranceType, ['社保・本人', '国保・一般', '後期高齢者', '公費併用']),
    copayRatio: choice(input.copayRatio, [0.1, 0.2, 0.3]),
    mynaVerified: boolean(input.mynaVerified),
    chiefComplaint: requiredText(input.chiefComplaint, 4000),
  };
}

export function allergy(value: unknown): AllergyItem {
  const input = object(value);
  return {
    substance: requiredText(input.substance),
    category: choice(input.category, ['drug', 'food', 'other']),
    severity: choice(input.severity, ['moderate', 'severe']),
    reaction: string(input.reaction),
  };
}

export function vitals(value: unknown, measuredAt: string): VitalRecord {
  const input = object(value);
  return {
    measuredAt,
    systolicBp: number(input.systolicBp, 1, 400),
    diastolicBp: number(input.diastolicBp, 1, 400),
    pulse: number(input.pulse, 1, 400),
    temperature: number(input.temperature, 20, 50),
    spo2: number(input.spo2, 0, 100),
    weightKg: number(input.weightKg, 0.1, 1000),
    bmi: number(input.bmi, 0.1, 200),
  };
}

export function diagnosis(value: unknown): DiseaseRecord {
  const input = object(value);
  return {
    id: requiredText(input.id),
    master: masterReference(input.master),
    name: requiredText(input.name),
    icd10Code: string(input.icd10Code),
    isMain: boolean(input.isMain),
    isChronicDiseaseTarget: boolean(input.isChronicDiseaseTarget),
    startDate: date(input.startDate),
    outcome: choice(input.outcome, ['ongoing', 'cured', 'suspected']),
  };
}

export function prescription(value: unknown): PrescriptionItem {
  const input = object(value);
  const days = number(input.days, 1, 365);
  if (!Number.isInteger(days)) invalidInput();
  return {
    id: requiredText(input.id),
    master: masterReference(input.master),
    priceCode: input.priceCode === undefined ? undefined : string(input.priceCode),
    drugName: requiredText(input.drugName),
    dosagePerDay: requiredText(input.dosagePerDay),
    usage: requiredText(input.usage),
    days,
    category: choice(input.category, ['internal', 'external', 'as_needed']),
    genericAllowed: boolean(input.genericAllowed),
  };
}

export function labOrder(value: unknown): LabOrderItem {
  const input = object(value);
  return {
    id: requiredText(input.id),
    master: masterReference(input.master),
    code: requiredText(input.code),
    name: requiredText(input.name),
  };
}
