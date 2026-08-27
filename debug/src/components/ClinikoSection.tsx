import { useCallback, useEffect, useState } from "react";
import { useQuery } from "convex/react";
import { HugeiconsIcon } from "@hugeicons/react";
import { ClinicIcon } from "@hugeicons/core-free-icons";
import { api } from "../../../convex/_generated/api.js";
import { panelCardClass, subtlePanelClass } from "./PanelPrimitives.js";

interface ClinikoStatus {
  enabled: boolean;
  configured: boolean;
  connected: boolean;
  shard: string | null;
  businesses: Array<{ id: string; name: string; timeZone: string | null }>;
  error: string | null;
}

const DEMO_STATUS: ClinikoStatus = {
  enabled: true,
  configured: true,
  connected: true,
  shard: "au2",
  businesses: [{ id: "demo", name: "Harbour Health Clinic", timeZone: "Australia/Sydney" }],
  error: null,
};

export function ClinikoSection({ isDark }: { isDark: boolean }) {
  const demo = useQuery(api.demo.status)?.enabled ?? false;
  const [status, setStatus] = useState<ClinikoStatus | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    if (demo) {
      setStatus(DEMO_STATUS);
      setLoaded(true);
      return;
    }
    try {
      const res = await fetch("/api/cliniko/status");
      const body = (await res.json()) as ClinikoStatus;
      setStatus(body);
    } catch (err) {
      setStatus({
        enabled: false,
        configured: false,
        connected: false,
        shard: null,
        businesses: [],
        error: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setLoaded(true);
    }
  }, [demo]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  async function toggle() {
    if (demo || busy) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/cliniko/${status?.enabled ? "disable" : "enable"}`, {
        method: "POST",
      });
      setStatus((await res.json()) as ClinikoStatus);
    } finally {
      setBusy(false);
    }
  }

  const connected = status?.connected ?? false;
  const title = isDark ? "text-zinc-50" : "text-zinc-950";
  const muted = isDark ? "text-zinc-400" : "text-zinc-500";

  return (
    <section className={panelCardClass(isDark, "fade-in overflow-hidden")}>
      <div className="flex flex-col gap-3 px-4 py-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex min-w-0 items-start gap-3">
          <span className={`inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-xl ${isDark ? "bg-sky-400/10 text-sky-300" : "bg-sky-50 text-sky-700"}`}>
            <HugeiconsIcon icon={ClinicIcon} size={20} strokeWidth={1.8} />
          </span>
          <div className="min-w-0">
            <div className={`text-sm font-medium ${title}`}>Cliniko</div>
            <div className={`mt-1 max-w-3xl text-xs leading-relaxed ${muted}`}>
              Patient records, appointments, availability, and practitioner follow-up instructions.
              The API key stays in the server environment.
            </div>
            <div className="mt-2 text-[10px] text-zinc-500 mono">
              {demo ? "demo connection" : `cliniko_enabled = "${status?.enabled ? "true" : "false"}"`}
            </div>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-3">
          <span className={`inline-flex items-center gap-2 rounded-full px-2.5 py-1 text-xs ${connected ? "bg-emerald-400/10 text-emerald-500" : "bg-zinc-400/10 text-zinc-500"}`}>
            <span className={`h-2 w-2 rounded-full ${connected ? "bg-emerald-400" : "bg-zinc-500"}`} />
            {connected ? "Connected" : loaded ? "Not connected" : "Checking…"}
          </span>
          <button
            type="button"
            disabled={!loaded || !status?.configured || busy || demo}
            onClick={toggle}
            className={`rounded-xl border px-3 py-1.5 text-xs disabled:cursor-not-allowed disabled:opacity-40 ${isDark ? "border-white/10 bg-white/5 text-zinc-200" : "border-zinc-200 bg-white text-zinc-700"}`}
          >
            {status?.enabled ? "Disable" : "Enable"}
          </button>
        </div>
      </div>
      <div className={`border-t px-4 py-4 ${isDark ? "border-white/10" : "border-zinc-200"}`}>
        {connected ? (
          <div className={subtlePanelClass(isDark, "px-3 py-3 text-xs")}>
            {status?.businesses.map((business) => (
              <div key={business.id} className="flex flex-wrap items-center justify-between gap-2">
                <span className={title}>{business.name}</span>
                <span className="text-zinc-500 mono">
                  {[business.timeZone, status.shard].filter(Boolean).join(" · ")}
                </span>
              </div>
            ))}
          </div>
        ) : (
          <div className={subtlePanelClass(isDark, "px-3 py-3 text-xs leading-relaxed text-zinc-500")}>
            {status?.error || "Set CLINIKO_API_KEY and CLINIKO_USER_AGENT, then enable Cliniko."}
          </div>
        )}
      </div>
    </section>
  );
}
