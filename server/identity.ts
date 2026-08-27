import { api } from "../convex/_generated/api.js";
import { convex } from "./convex-client.js";
import { getClinicSettings, getClinikoSettings, normalizeClinicPhone } from "./clinic-config.js";
import { ClinikoClient, findPatientByPhone, patientDisplayName } from "./cliniko/client.js";

export type Audience = "patient" | "staff" | "unknown";

export interface ResolvedContact {
  phone: string;
  audience: Audience;
  clinikoPatientId?: string;
  displayName?: string;
  readMemoryScopes: string[];
  writeMemoryScope: string;
}

const MATCH_RETRY_MS = 6 * 60 * 60 * 1_000;

export function memoryScopesFor(audience: Audience, phone: string): {
  readMemoryScopes: string[];
  writeMemoryScope: string;
} {
  if (audience === "staff") {
    return { readMemoryScopes: ["staff", "clinic"], writeMemoryScope: "staff" };
  }
  const patientScope = `patient:${phone}`;
  return {
    readMemoryScopes: [patientScope, "clinic"],
    writeMemoryScope: patientScope,
  };
}

function resolved(
  phone: string,
  audience: Audience,
  details: { clinikoPatientId?: string; displayName?: string } = {},
): ResolvedContact {
  return { phone, audience, ...details, ...memoryScopesFor(audience, phone) };
}

export async function resolveContact(rawPhone: string): Promise<ResolvedContact> {
  const phone = normalizeClinicPhone(rawPhone);
  if (!phone) throw new Error("Inbound phone number is not valid E.164");

  const clinic = await getClinicSettings();
  if (clinic.staffPhoneNumbers.includes(phone)) {
    await convex.mutation(api.contacts.upsert, { phone, role: "staff" });
    return resolved(phone, "staff");
  }

  const cached = await convex.query(api.contacts.getByPhone, { phone });
  if (cached?.role === "patient" && cached.clinikoPatientId) {
    await convex.mutation(api.contacts.upsert, {
      phone,
      role: "patient",
      clinikoPatientId: cached.clinikoPatientId,
      displayName: cached.displayName,
    });
    return resolved(phone, "patient", {
      clinikoPatientId: cached.clinikoPatientId,
      displayName: cached.displayName,
    });
  }

  const now = Date.now();
  const shouldTryMatch =
    cached?.lastMatchAttemptAt === undefined || now - cached.lastMatchAttemptAt >= MATCH_RETRY_MS;
  const cliniko = await getClinikoSettings();
  if (cliniko.enabled && cliniko.apiKey && shouldTryMatch) {
    try {
      const client = new ClinikoClient({
        apiKey: cliniko.apiKey,
        shard: cliniko.shard,
        userAgent: cliniko.userAgent,
      });
      const patient = await findPatientByPhone(client, phone);
      if (patient) {
        const displayName = patientDisplayName(patient);
        await convex.mutation(api.contacts.upsert, {
          phone,
          role: "patient",
          clinikoPatientId: String(patient.id),
          displayName,
          lastMatchAttemptAt: now,
        });
        return resolved(phone, "patient", {
          clinikoPatientId: String(patient.id),
          displayName,
        });
      }
    } catch (err) {
      console.warn("[identity] Cliniko phone match failed", err);
    }
  }

  await convex.mutation(api.contacts.upsert, {
    phone,
    role: "unknown",
    displayName: cached?.displayName,
    lastMatchAttemptAt: shouldTryMatch ? now : cached?.lastMatchAttemptAt,
  });
  return resolved(phone, "unknown", { displayName: cached?.displayName });
}
