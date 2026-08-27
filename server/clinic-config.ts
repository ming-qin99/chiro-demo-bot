import { api } from "../convex/_generated/api.js";
import { convex } from "./convex-client.js";

export const CLINIKO_ENABLED_KEY = "cliniko_enabled";
const CONFIG_TTL_MS = 5_000;

export interface ClinicSettings {
  clinicName: string;
  practitionerName: string;
  address: string;
  hours: string;
  bookingPolicy: string;
  staffPhoneNumbers: string[];
  timezone: string;
  escalationReminderHours: number;
  followupDelayHours: number;
  followupAutoSend: boolean;
  demoStaffPhone?: string;
}

export interface ClinikoSettings {
  enabled: boolean;
  apiKey?: string;
  shard?: string;
  userAgent: string;
}

let cachedClinic: { at: number; value: ClinicSettings } | null = null;
let cachedCliniko: { at: number; value: ClinikoSettings } | null = null;

async function setting(key: string): Promise<string | null> {
  try {
    return await convex.query(api.settings.get, { key });
  } catch (err) {
    console.warn(`[clinic-config] failed to read settings.${key}`, err);
    return null;
  }
}

function configured(value: string | null, envValue: string | undefined, fallback: string): string {
  return value?.trim() || envValue?.trim() || fallback;
}

function configuredNumber(
  value: string | null,
  envValue: string | undefined,
  fallback: number,
): number {
  const parsed = Number(value?.trim() || envValue?.trim());
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function configuredBool(
  value: string | null,
  envValue: string | undefined,
  fallback: boolean,
): boolean {
  const raw = value?.trim() || envValue?.trim();
  if (!raw) return fallback;
  return raw.toLowerCase() === "true";
}

export function normalizeClinicPhone(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const digits = trimmed.replace(/\D/g, "");
  if (trimmed.startsWith("+") && digits.length >= 8 && digits.length <= 15) {
    return `+${digits}`;
  }
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length >= 11 && digits.length <= 15) return `+${digits}`;
  return null;
}

function phoneList(raw: string): string[] {
  return [
    ...new Set(
      raw
        .split(",")
        .map(normalizeClinicPhone)
        .filter((phone): phone is string => Boolean(phone)),
    ),
  ];
}

export async function getClinicSettings(): Promise<ClinicSettings> {
  if (cachedClinic && Date.now() - cachedClinic.at < CONFIG_TTL_MS) {
    return cachedClinic.value;
  }
  const [name, practitioner, address, hours, policy, staff, timezone, reminder, delay, auto, demo] =
    await Promise.all([
      setting("clinic_name"),
      setting("clinic_practitioner_name"),
      setting("clinic_address"),
      setting("clinic_hours"),
      setting("clinic_booking_policy"),
      setting("staff_phone_numbers"),
      setting("clinic_timezone"),
      setting("escalation_reminder_hours"),
      setting("followup_delay_hours"),
      setting("followup_auto_send"),
      setting("demo_staff_phone"),
    ]);
  const value: ClinicSettings = {
    clinicName: configured(name, process.env.CLINIC_NAME, "Harbour Health Clinic"),
    practitionerName: configured(
      practitioner,
      process.env.CLINIC_PRACTITIONER_NAME,
      "your practitioner",
    ),
    address: configured(address, process.env.CLINIC_ADDRESS, "Address available on request"),
    hours: configured(hours, process.env.CLINIC_HOURS, "Monday–Friday, 8am–6pm"),
    bookingPolicy: configured(
      policy,
      process.env.CLINIC_BOOKING_POLICY,
      "Please give at least 24 hours' notice for appointment changes where possible.",
    ),
    staffPhoneNumbers: phoneList(
      configured(staff, process.env.CLINIC_STAFF_PHONE_NUMBERS, ""),
    ),
    timezone: configured(timezone, process.env.CLINIC_TIMEZONE, "Australia/Sydney"),
    escalationReminderHours: configuredNumber(
      reminder,
      process.env.CLINIC_ESCALATION_REMINDER_HOURS,
      4,
    ),
    followupDelayHours: Math.min(
      24,
      configuredNumber(delay, process.env.CLINIC_FOLLOWUP_DELAY_HOURS, 2),
    ),
    followupAutoSend: configuredBool(auto, process.env.CLINIC_FOLLOWUP_AUTO_SEND, false),
    demoStaffPhone:
      normalizeClinicPhone(configured(demo, process.env.CLINIC_DEMO_STAFF_PHONE, "")) ??
      undefined,
  };
  cachedClinic = { at: Date.now(), value };
  return value;
}

export async function getClinikoSettings(): Promise<ClinikoSettings> {
  if (cachedCliniko && Date.now() - cachedCliniko.at < CONFIG_TTL_MS) {
    return cachedCliniko.value;
  }
  const enabledSetting = await setting(CLINIKO_ENABLED_KEY);
  const apiKey = process.env.CLINIKO_API_KEY?.trim() || undefined;
  const enabled = configuredBool(enabledSetting, process.env.CLINIKO_ENABLED, Boolean(apiKey));
  const value: ClinikoSettings = {
    enabled: enabled && Boolean(apiKey),
    apiKey,
    shard: process.env.CLINIKO_SHARD?.trim() || undefined,
    userAgent:
      process.env.CLINIKO_USER_AGENT?.trim() ||
      "Boop Clinic Assistant (developer@example.com)",
  };
  cachedCliniko = { at: Date.now(), value };
  return value;
}

export function clearClinicSettingsCache(): void {
  cachedClinic = null;
  cachedCliniko = null;
}
