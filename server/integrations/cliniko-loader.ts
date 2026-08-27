import { getClinikoSettings } from "../clinic-config.js";
import { createClinikoMcp, createClinikoTools } from "../cliniko/tools.js";
import { registerIntegration } from "./registry.js";

export function registerClinikoIntegration(): void {
  registerIntegration({
    name: "cliniko",
    description:
      "Cliniko practice data with patient-pinned reads and draft-gated appointment writes.",
    requiredEnv: ["CLINIKO_API_KEY"],
    isEnabled: async () => (await getClinikoSettings()).enabled,
    createServer: async (ctx) => createClinikoMcp(ctx),
    createTools: async (ctx) => createClinikoTools(ctx),
  });
  console.log("[cliniko] registered Cliniko integration");
}
