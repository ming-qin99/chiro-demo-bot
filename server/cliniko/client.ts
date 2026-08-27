import type {
  ClinikoIndividualAppointment,
  ClinikoPage,
  ClinikoPatient,
} from "./types.js";

export interface ClinikoClientOptions {
  apiKey: string;
  shard?: string;
  userAgent?: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export interface ClinikoRequestOptions {
  method?: "GET" | "POST" | "PATCH" | "DELETE";
  query?: Record<string, string | number | boolean | string[] | undefined>;
  body?: unknown;
  retries?: number;
}

const SHARD_RE = /^[a-z]{2}\d{1,2}$/i;
const MAX_PAGES = 20;

export function deriveClinikoShard(apiKey: string, override?: string): string {
  const candidate = override?.trim() || apiKey.match(/-([a-z]{2}\d{1,2})$/i)?.[1] || "au1";
  if (!SHARD_RE.test(candidate)) {
    throw new Error("CLINIKO_SHARD must look like au2, uk1, ca1, or eu1");
  }
  return candidate.toLowerCase();
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function responseMessage(status: number, body: string): string {
  if (!body) return `Cliniko API request failed (${status})`;
  try {
    const parsed = JSON.parse(body) as { message?: string; error?: string; errors?: unknown };
    return parsed.message || parsed.error || JSON.stringify(parsed.errors) || `Cliniko API error ${status}`;
  } catch {
    return `Cliniko API request failed (${status}): ${body.slice(0, 300)}`;
  }
}

export class ClinikoClient {
  readonly shard: string;
  readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly userAgent: string;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private tokens = 150;
  private lastRefillAt: number;

  constructor(options: ClinikoClientOptions) {
    if (!options.apiKey.trim()) throw new Error("CLINIKO_API_KEY is required");
    this.apiKey = options.apiKey.trim();
    this.shard = deriveClinikoShard(this.apiKey, options.shard);
    this.baseUrl = `https://api.${this.shard}.cliniko.com/v1`;
    this.userAgent = options.userAgent?.trim() || "Boop Clinic Assistant (developer@example.com)";
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? defaultSleep;
    this.lastRefillAt = this.now();
  }

  private async acquireToken(): Promise<void> {
    const now = this.now();
    const elapsed = Math.max(0, now - this.lastRefillAt);
    this.tokens = Math.min(150, this.tokens + (elapsed / 60_000) * 150);
    this.lastRefillAt = now;
    if (this.tokens >= 1) {
      this.tokens -= 1;
      return;
    }
    const waitMs = Math.ceil(((1 - this.tokens) / 150) * 60_000);
    await this.sleep(waitMs);
    this.tokens = 0;
    this.lastRefillAt = this.now();
  }

  private requestUrl(pathOrUrl: string, query?: ClinikoRequestOptions["query"]): URL {
    const url = pathOrUrl.startsWith("http")
      ? new URL(pathOrUrl)
      : new URL(pathOrUrl.replace(/^\//, ""), `${this.baseUrl}/`);
    if (url.protocol !== "https:" || url.hostname !== `api.${this.shard}.cliniko.com`) {
      throw new Error("Refusing to follow a Cliniko pagination link outside the configured shard");
    }
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value === undefined) continue;
      if (Array.isArray(value)) {
        for (const item of value) url.searchParams.append(key, item);
      } else {
        url.searchParams.set(key, String(value));
      }
    }
    return url;
  }

  async request<T>(pathOrUrl: string, options: ClinikoRequestOptions = {}): Promise<T> {
    await this.acquireToken();
    const url = this.requestUrl(pathOrUrl, options.query);
    const method = options.method ?? "GET";
    const response = await this.fetchImpl(url, {
      method,
      headers: {
        Accept: "application/json",
        Authorization: `Basic ${Buffer.from(`${this.apiKey}:`).toString("base64")}`,
        "User-Agent": this.userAgent,
        ...(options.body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: AbortSignal.timeout(20_000),
    });

    if (response.status === 429 && (options.retries ?? 2) > 0) {
      const resetSeconds = Number(response.headers.get("x-ratelimit-reset"));
      const retryAfter = Number(response.headers.get("retry-after"));
      const waitMs = Number.isFinite(resetSeconds) && resetSeconds > 0
        ? Math.max(250, resetSeconds * 1_000 - this.now())
        : Number.isFinite(retryAfter) && retryAfter > 0
          ? retryAfter * 1_000
          : 1_000;
      await this.sleep(Math.min(waitMs, 65_000));
      return this.request<T>(pathOrUrl, { ...options, retries: (options.retries ?? 2) - 1 });
    }

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(responseMessage(response.status, body));
    }
    if (response.status === 204) return null as T;
    return (await response.json()) as T;
  }

  async paginate<T>(
    path: string,
    collectionKey: string,
    query: ClinikoRequestOptions["query"] = {},
    maxPages = MAX_PAGES,
  ): Promise<T[]> {
    const rows: T[] = [];
    let next: string | undefined = path;
    let first = true;
    for (let page = 0; next && page < maxPages; page += 1) {
      const payload: ClinikoPage<T> = await this.request<ClinikoPage<T>>(next, {
        query: first ? { per_page: 100, ...query } : undefined,
      });
      const pageRows = payload[collectionKey];
      if (Array.isArray(pageRows)) rows.push(...(pageRows as T[]));
      next = payload.links?.next;
      first = false;
    }
    return rows;
  }
}

export function normalizeClinikoPhone(raw: string): string {
  // Some international displays include a domestic trunk marker, e.g.
  // +61 (0) 412…; it is not part of the E.164 number.
  return raw
    .trim()
    .replace(/^(\+\d{1,3})\s*\(0\)/, "$1")
    .replace(/\D/g, "")
    .replace(/^00/, "");
}

export function patientDisplayName(patient: ClinikoPatient): string {
  return (
    patient.preferred_first_name?.trim() ||
    patient.label?.trim() ||
    `${patient.first_name} ${patient.last_name}`.trim()
  );
}

export async function findPatientByPhone(
  client: ClinikoClient,
  phone: string,
): Promise<ClinikoPatient | null> {
  const wanted = normalizeClinikoPhone(phone);
  const patients = await client.paginate<ClinikoPatient>("/patients", "patients", {}, MAX_PAGES);
  return (
    patients.find((patient) =>
      (patient.patient_phone_numbers ?? []).some((entry) => {
        const normalized = normalizeClinikoPhone(entry.normalized_number || entry.number);
        return normalized === wanted || normalized.endsWith(wanted) || wanted.endsWith(normalized);
      }),
    ) ?? null
  );
}

export function appointmentPatientId(appointment: ClinikoIndividualAppointment): string | null {
  if (appointment.patient?.id) return String(appointment.patient.id);
  const link = appointment.patient?.links?.self;
  return link?.match(/\/patients\/(\d+)/)?.[1] ?? null;
}
