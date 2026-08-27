import { useMemo, useState } from "react";
import { useQuery } from "convex/react";
import { api } from "../../../convex/_generated/api.js";
import {
  EmptyState,
  HeaderPill,
  PanelPage,
  mutedTextClass,
  panelCardClass,
  subtlePanelClass,
} from "./PanelPrimitives.js";

type Status = "all" | "pending" | "answered" | "relayed" | "dismissed";

const STATUSES: Status[] = ["all", "pending", "answered", "relayed", "dismissed"];

function statusClass(status: string, isDark: boolean): string {
  if (status === "pending") {
    return isDark
      ? "border-amber-400/20 bg-amber-400/10 text-amber-300"
      : "border-amber-200 bg-amber-50 text-amber-700";
  }
  if (status === "relayed" || status === "answered") {
    return isDark
      ? "border-emerald-400/20 bg-emerald-400/10 text-emerald-300"
      : "border-emerald-200 bg-emerald-50 text-emerald-700";
  }
  return isDark
    ? "border-white/10 bg-white/5 text-zinc-400"
    : "border-zinc-200 bg-zinc-50 text-zinc-600";
}

export function EscalationsPanel({ isDark }: { isDark: boolean }) {
  const [status, setStatus] = useState<Status>("all");
  const rows = useQuery(api.escalations.listForDashboard, {
    status: status === "all" ? undefined : status,
    limit: 100,
  });
  const pendingCount = useMemo(
    () => (rows ?? []).filter((row) => row.status === "pending").length,
    [rows],
  );

  return (
    <PanelPage
      eyebrow="Clinic workflow"
      title="Escalations"
      description="Patient questions handed to clinic staff, with their answer and relay lifecycle."
      stat={<HeaderPill isDark={isDark}>{pendingCount} pending</HeaderPill>}
      maxWidth="max-w-[1040px]"
    >
      <div className={panelCardClass(isDark, "flex flex-wrap items-center gap-1 px-3 py-3")}>
        {STATUSES.map((option) => (
          <button
            key={option}
            type="button"
            onClick={() => setStatus(option)}
            className={`rounded-xl px-2.5 py-1 text-xs capitalize transition-colors ${
              status === option
                ? isDark
                  ? "bg-zinc-100 text-zinc-950"
                  : "bg-zinc-900 text-white"
                : isDark
                  ? "text-zinc-400 hover:bg-white/5"
                  : "text-zinc-500 hover:bg-zinc-100"
            }`}
          >
            {option}
          </button>
        ))}
      </div>

      <div className={panelCardClass(isDark, "overflow-hidden")}>
        {rows === undefined ? (
          <div className="space-y-3 p-5">
            {Array.from({ length: 4 }, (_, index) => (
              <div key={index} className={subtlePanelClass(isDark, "h-20 shimmer")} />
            ))}
          </div>
        ) : rows.length === 0 ? (
          <EmptyState isDark={isDark}>No escalations match this filter</EmptyState>
        ) : (
          <div className={`divide-y ${isDark ? "divide-white/10" : "divide-zinc-100"}`}>
            {rows.map((row) => (
              <article key={row.escalationId} className="space-y-2 px-5 py-4">
                <div className="flex flex-wrap items-center gap-2">
                  <span className={`rounded border px-1.5 py-0.5 text-[10px] font-medium ${statusClass(row.status, isDark)}`}>
                    {row.status}
                  </span>
                  <span className={`text-xs font-medium ${isDark ? "text-zinc-200" : "text-zinc-800"}`}>
                    {row.patientName ?? "Patient"}
                  </span>
                  <span className={`ml-auto text-[10px] mono ${mutedTextClass(isDark)}`}>
                    {new Date(row.createdAt).toLocaleString()}
                  </span>
                </div>
                <p className={`text-sm leading-relaxed ${isDark ? "text-zinc-300" : "text-zinc-700"}`}>
                  {row.question}
                </p>
                {row.context && (
                  <p className={`text-xs leading-relaxed ${mutedTextClass(isDark)}`}>
                    Context: {row.context}
                  </p>
                )}
                {row.answer && (
                  <div className={subtlePanelClass(isDark, "px-3 py-2 text-xs leading-relaxed")}>
                    <span className={mutedTextClass(isDark)}>Practitioner answer: </span>
                    <span className={isDark ? "text-zinc-200" : "text-zinc-800"}>{row.answer}</span>
                  </div>
                )}
                <div className={`text-[10px] mono ${mutedTextClass(isDark)}`}>{row.escalationId}</div>
              </article>
            ))}
          </div>
        )}
      </div>
    </PanelPage>
  );
}
