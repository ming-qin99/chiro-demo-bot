import { mutation, query, type QueryCtx } from "./_generated/server";
import { v } from "convex/values";
import { isDemoId, isDemoModeEnabled } from "./demoMode";

const statusV = v.union(
  v.literal("pending"),
  v.literal("answered"),
  v.literal("relayed"),
  v.literal("dismissed"),
);

export const create = mutation({
  args: {
    escalationId: v.string(),
    patientConversationId: v.string(),
    patientPhone: v.string(),
    patientName: v.optional(v.string()),
    question: v.string(),
    context: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    return await ctx.db.insert("escalations", {
      ...args,
      status: "pending",
      createdAt: Date.now(),
    });
  },
});

export const get = query({
  args: { escalationId: v.string() },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("escalations")
      .withIndex("by_escalation_id", (q) => q.eq("escalationId", args.escalationId))
      .unique();
  },
});

async function readEscalations(
  ctx: QueryCtx,
  status: "pending" | "answered" | "relayed" | "dismissed" | undefined,
  limit: number,
  demoOnly: boolean,
) {
  const rows = status
    ? await ctx.db
        .query("escalations")
        .withIndex("by_status_and_created_at", (q) => q.eq("status", status))
        .order("desc")
        .take(Math.min(limit + 100, 500))
    : await ctx.db.query("escalations").order("desc").take(Math.min(limit + 100, 500));
  return rows
    .filter((row) => isDemoId(row.escalationId) === demoOnly)
    .slice(0, limit);
}

export const list = query({
  args: { status: v.optional(statusV), limit: v.optional(v.number()) },
  handler: async (ctx, args) => readEscalations(ctx, args.status, args.limit ?? 50, false),
});

export const listForDashboard = query({
  args: { status: v.optional(statusV), limit: v.optional(v.number()) },
  handler: async (ctx, args) =>
    readEscalations(ctx, args.status, args.limit ?? 50, await isDemoModeEnabled(ctx)),
});

export const updateStatus = mutation({
  args: {
    escalationId: v.string(),
    status: statusV,
    answer: v.optional(v.string()),
    remindedAt: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const row = await ctx.db
      .query("escalations")
      .withIndex("by_escalation_id", (q) => q.eq("escalationId", args.escalationId))
      .unique();
    if (!row) return null;
    await ctx.db.patch(row._id, {
      status: args.status,
      answer: args.answer ?? row.answer,
      remindedAt: args.remindedAt ?? row.remindedAt,
      ...(args.status === "answered" || args.status === "relayed"
        ? { answeredAt: row.answeredAt ?? Date.now() }
        : {}),
    });
    return row._id;
  },
});

export const dueForReminder = query({
  args: { createdBefore: v.number(), remindedBefore: v.number(), limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query("escalations")
      .withIndex("by_status_and_created_at", (q) =>
        q.eq("status", "pending").lte("createdAt", args.createdBefore),
      )
      .order("asc")
      .take(Math.min(args.limit ?? 50, 100));
    return rows.filter(
      (row) =>
        !isDemoId(row.escalationId) &&
        (row.remindedAt === undefined || row.remindedAt <= args.remindedBefore),
    );
  },
});
