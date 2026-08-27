import express from "express";
import { api } from "../convex/_generated/api.js";
import { convex } from "./convex-client.js";
import {
  CLINIKO_ENABLED_KEY,
  clearClinicSettingsCache,
  getClinikoSettings,
} from "./clinic-config.js";
import { clinikoBusinesses } from "./cliniko/tools.js";

async function status() {
  const settings = await getClinikoSettings();
  if (!settings.apiKey) {
    return {
      enabled: false,
      configured: false,
      connected: false,
      shard: settings.shard ?? null,
      businesses: [],
      error: "CLINIKO_API_KEY is not configured",
    };
  }
  if (!settings.enabled) {
    return {
      enabled: false,
      configured: true,
      connected: false,
      shard: settings.shard ?? null,
      businesses: [],
      error: null,
    };
  }
  try {
    const businesses = await clinikoBusinesses();
    return {
      enabled: true,
      configured: true,
      connected: true,
      shard: settings.shard ?? null,
      businesses: businesses.map((business) => ({
        id: business.id,
        name: business.name,
        timeZone: business.time_zone ?? null,
      })),
      error: null,
    };
  } catch (err) {
    return {
      enabled: true,
      configured: true,
      connected: false,
      shard: settings.shard ?? null,
      businesses: [],
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export function createClinikoRouter(): express.Router {
  const router = express.Router();
  router.get("/status", async (_req, res) => {
    const value = await status();
    res.status(value.enabled && value.configured && !value.connected ? 502 : 200).json(value);
  });
  router.post("/enable", async (_req, res) => {
    await convex.mutation(api.settings.set, { key: CLINIKO_ENABLED_KEY, value: "true" });
    clearClinicSettingsCache();
    res.json(await status());
  });
  router.post("/disable", async (_req, res) => {
    await convex.mutation(api.settings.set, { key: CLINIKO_ENABLED_KEY, value: "false" });
    clearClinicSettingsCache();
    res.json(await status());
  });
  return router;
}
