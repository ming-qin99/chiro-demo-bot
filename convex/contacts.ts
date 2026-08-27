import { mutation, query, type QueryCtx } from "./_generated/server";
import { v } from "convex/values";

const roleV = v.union(v.literal("patient"), v.literal("staff"), v.literal("unknown"));

export const getByPhone = query({
  args: { phone: v.string() },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("contacts")
      .withIndex("by_phone", (q) => q.eq("phone", args.phone))
      .unique();
  },
});

export const getByClinikoId = query({
  args: { clinikoPatientId: v.string() },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("contacts")
      .withIndex("by_cliniko_id", (q) =>
        q.eq("clinikoPatientId", args.clinikoPatientId),
      )
      .first();
  },
});

export const upsert = mutation({
  args: {
    phone: v.string(),
    role: roleV,
    clinikoPatientId: v.optional(v.string()),
    displayName: v.optional(v.string()),
    lastSeenAt: v.optional(v.number()),
    lastMatchAttemptAt: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const now = Date.now();
    const existing = await ctx.db
      .query("contacts")
      .withIndex("by_phone", (q) => q.eq("phone", args.phone))
      .unique();
    const patch = {
      role: args.role,
      clinikoPatientId: args.clinikoPatientId,
      displayName: args.displayName,
      lastSeenAt: args.lastSeenAt ?? now,
      lastMatchAttemptAt: args.lastMatchAttemptAt,
    };
    if (existing) {
      await ctx.db.patch(existing._id, patch);
      return existing._id;
    }
    return await ctx.db.insert("contacts", {
      phone: args.phone,
      ...patch,
      createdAt: now,
    });
  },
});

async function readContacts(ctx: QueryCtx, limit: number) {
  return await ctx.db.query("contacts").order("desc").take(Math.min(limit, 500));
}

export const list = query({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, args) => readContacts(ctx, args.limit ?? 100),
});

export const listForDashboard = query({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, args) => readContacts(ctx, args.limit ?? 100),
});
