import { describe, expect, it, vi } from "vitest";
import {
  ClinikoClient,
  deriveClinikoShard,
  normalizeClinikoPhone,
} from "../server/cliniko/client.js";

describe("ClinikoClient", () => {
  it("derives and validates the regional API shard", () => {
    expect(deriveClinikoShard("secret-au2")).toBe("au2");
    expect(deriveClinikoShard("secret-without-suffix")).toBe("au1");
    expect(deriveClinikoShard("secret-au2", "uk1")).toBe("uk1");
    expect(() => deriveClinikoShard("secret", "example.com")).toThrow(/CLINIKO_SHARD/);
  });

  it("uses Basic auth, a contactable User-Agent, and repeated q[] filters", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ individual_appointments: [], links: {} }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    ) as unknown as typeof fetch;
    const client = new ClinikoClient({
      apiKey: "test-key-au1",
      userAgent: "Clinic Assistant (ops@example.test)",
      fetchImpl,
    });

    await client.request("/individual_appointments", {
      query: { "q[]": ["patient_id:=42", "starts_at:>=2026-08-27T00:00:00Z"] },
    });

    const [input, init] = fetchImpl.mock.calls[0] as unknown as [URL, RequestInit];
    expect(input.hostname).toBe("api.au1.cliniko.com");
    expect(input.searchParams.getAll("q[]")).toEqual([
      "patient_id:=42",
      "starts_at:>=2026-08-27T00:00:00Z",
    ]);
    expect(new Headers(init.headers).get("authorization")).toBe(
      `Basic ${Buffer.from("test-key-au1:").toString("base64")}`,
    );
    expect(new Headers(init.headers).get("user-agent")).toBe(
      "Clinic Assistant (ops@example.test)",
    );
  });

  it("follows same-shard pagination links and rejects foreign hosts", async () => {
    const fetchImpl = vi.fn(async () => {
      const page = fetchImpl.mock.calls.length;
      return new Response(
        JSON.stringify(
          page === 1
            ? {
                patients: [{ id: 1 }],
                links: { next: "https://api.au1.cliniko.com/v1/patients?page=2" },
              }
            : { patients: [{ id: 2 }], links: {} },
        ),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as unknown as typeof fetch;
    const client = new ClinikoClient({ apiKey: "test-au1", fetchImpl });

    await expect(client.paginate<{ id: number }>("/patients", "patients")).resolves.toEqual([
      { id: 1 },
      { id: 2 },
    ]);
    await expect(
      client.request("https://malicious.example/v1/patients"),
    ).rejects.toThrow(/outside the configured shard/);
  });

  it("honors X-RateLimit-Reset before retrying a 429", async () => {
    let now = 1_000_000;
    const sleeps: number[] = [];
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        new Response("", {
          status: 429,
          headers: { "x-ratelimit-reset": String((now + 2_000) / 1_000) },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      ) as unknown as typeof fetch;
    const client = new ClinikoClient({
      apiKey: "test-au1",
      fetchImpl,
      now: () => now,
      sleep: async (ms) => {
        sleeps.push(ms);
        now += ms;
      },
    });

    await expect(client.request<{ ok: boolean }>("/businesses")).resolves.toEqual({ ok: true });
    expect(sleeps).toEqual([2_000]);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("normalizes common phone formatting", () => {
    expect(normalizeClinikoPhone("+61 (0) 412 345 678")).toBe("61412345678");
    expect(normalizeClinikoPhone("0061 412 345 678")).toBe("61412345678");
  });
});
