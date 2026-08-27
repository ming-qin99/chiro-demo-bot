import { mutation, query } from "./_generated/server";
import { v } from "convex/values";

const kindV = v.union(v.literal("reminder"), v.literal("followup"));
const statusV = v.union(
  v.literal("scheduled"),
  v.literal("drafted"),
  v.literal("sent"),
  v.literal("skipped"),
  v.literal("failed"),
);

export const claim = mutation({
  args: {
    outreachId: v.string(),
    kind: kindV,
    appointmentId: v.string(),
    patientPhone: v.string(),
    scheduledFor: v.number(),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("clinikoOutreach")
      .withIndex("by_appointment_id_and_kind", (q) =>
        q.eq("appointmentId", args.appointmentId).eq("kind", args.kind),
      )
      .unique();
    if (existing) return { claimed: false, row: existing };
    const id = await ctx.db.insert("clinikoOutreach", {
      ...args,
      status: "scheduled",
      createdAt: Date.now(),
    });
    return { claimed: true, id };
  },
});

export const setStatus = mutation({
  args: {
    outreachId: v.string(),
    status: statusV,
    draftId: v.optional(v.string()),
    error: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const row = await ctx.db
      .query("clinikoOutreach")
      .withIndex("by_outreach_id", (q) => q.eq("outreachId", args.outreachId))
      .unique();
    if (!row) return null;
    await ctx.db.patch(row._id, {
      status: args.status,
      draftId: args.draftId ?? row.draftId,
      error: args.error,
      ...(args.status === "sent" ? { sentAt: Date.now() } : {}),
    });
    return row._id;
  },
});

export const recent = query({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, args) =>
    await ctx.db.query("clinikoOutreach").order("desc").take(Math.min(args.limit ?? 100, 500)),
});
