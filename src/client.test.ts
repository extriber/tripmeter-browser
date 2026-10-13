import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { createClient } from "./index";

let clients: ReturnType<typeof createClient>[] = [];
beforeEach(() => {
  localStorage.clear();
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-14T00:00:00Z"));
});
afterEach(() => {
  clients.forEach((c) => c.destroy());
  clients = [];
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
function client(bucket: string, apiKey = "test-key") {
  const c = createClient({ apiKey, bucket, endpoint: "https://collector.example/tripmeter" });
  clients.push(c);
  return c;
}
function requests() {
  const batches: any[] = [];
  const fetch = vi.fn(async (request: Request) => {
    const body = await request.clone().json();
    batches.push(...body.data.map((p: any) => JSON.parse(p.ue_pr).data.data));
    return new Response("{}", { status: 200 });
  });
  vi.stubGlobal("fetch", fetch);
  return { batches, fetch };
}
test("sends an explicit bucket, identity, typed properties and one stable event ID", async () => {
  const { batches } = requests();
  const c = client("channel_nol_dev");
  c.setUserId("member-007");
  c.identify({ $set: { tier: "gold", count: 0, enabled: false } });
  c.track("product_view", { price: 12500, ids: ["001"], available: false });
  await c.flush();
  const view = batches.find((b) => b.event.event_type === "product_view");
  expect(view).toMatchObject({
    api_key: "test-key",
    bucket: "channel_nol_dev",
    event: {
      user_id: "member-007",
      event_properties: { price: 12500, ids: ["001"], available: false },
      user_properties_snapshot: { tier: "gold", count: 0, enabled: false },
    },
  });
  expect(view.event.insert_id).toBeTruthy();
  expect(view.event.session_id).toBe(Date.now());
  expect(batches.filter((b) => b.event.event_type === "session_start")).toHaveLength(1);
});
test("isolates buckets and clears user properties on logout", async () => {
  const { batches } = requests();
  const dev = client("channel_nol_dev", "dev-key");
  const prd = client("channel_nol_prd", "prd-key");
  dev.setUserId("dev-member");
  dev.identify({ $set: { tier: "dev" } });
  prd.track("production_view", {});
  dev.reset();
  dev.track("anonymous_view", {});
  await dev.flush();
  await prd.flush();
  const production = batches.find((b) => b.event.event_type === "production_view");
  const anonymous = batches.find((b) => b.event.event_type === "anonymous_view");
  expect(production.event.user_id).toBeUndefined();
  expect(production.event.user_properties_snapshot).toEqual({});
  expect(anonymous.event.user_id).toBeUndefined();
  expect(anonymous.event.user_properties_snapshot).toEqual({});
  expect(production.bucket).toBe("channel_nol_prd");
  expect(anonymous.bucket).toBe("channel_nol_dev");
});
test("retains failed events across reload and key rotation with original event identity", async () => {
  const failing = vi.fn(async () => new Response("{}", { status: 503 }));
  vi.stubGlobal("fetch", failing);
  const first = client("channel_nol_dev", "old-key");
  first.track("offline_view", {});
  await expect(first.flush()).rejects.toMatchObject({ status: 503 });
  const state = Array.from({ length: localStorage.length }, (_, i) =>
    localStorage.getItem(localStorage.key(i)!),
  ).join("");
  expect(state).not.toContain("old-key");
  first.destroy();
  const { batches } = requests();
  const second = client("channel_nol_dev", "new-key");
  await second.flush();
  expect(batches.filter((b) => b.event.event_type === "offline_view")).toHaveLength(1);
  expect(batches.every((b) => b.api_key === "new-key")).toBe(true);
});
test("keeps session at exactly 30 minutes and starts a new session after inactivity", async () => {
  const { batches } = requests();
  const c = client("channel_nol_dev");
  c.track("first", {});
  vi.setSystemTime(Date.now() + 1800000);
  c.track("boundary", {});
  vi.setSystemTime(Date.now() + 1800001);
  c.track("later", {});
  await c.flush();
  const events = Object.fromEntries(batches.map((b) => [b.event.event_type, b.event]));
  expect(events.first.session_id).toBe(events.boundary.session_id);
  expect(events.later.session_id).not.toBe(events.first.session_id);
  expect(events.session_end.time).toBe(events.boundary.time + 1);
});
test("requires bucket and rejects storage failure without throwing into host track handlers", () => {
  requests();
  expect(() => client("")).toThrow();
  const onError = vi.fn();
  vi.stubGlobal("localStorage", {
    getItem: () => null,
    setItem: () => {
      throw new DOMException("Full", "QuotaExceededError");
    },
  });
  const c = createClient({ apiKey: "key", bucket: "dev", onError });
  clients.push(c);
  expect(() => c.track("view", {})).not.toThrow();
  expect(onError).toHaveBeenCalled();
});

test("fixes the destination at initialization even if the caller mutates options", async () => {
  const { batches } = requests();
  const options = { apiKey: "dev-key", bucket: "channel_nol_dev" };
  const c = createClient(options);
  clients.push(c);
  options.bucket = "channel_nol_prd";
  c.track("view", {});
  await c.flush();
  expect(batches.every((b) => b.bucket === "channel_nol_dev")).toBe(true);
});
test("rejects non-JSON properties without emitting partial session events", async () => {
  const { batches } = requests();
  const onError = vi.fn();
  const c = createClient({ apiKey: "key", bucket: "dev", onError });
  clients.push(c);
  c.track("invalid", { price: Number.NaN });
  await c.flush();
  expect(batches).toHaveLength(0);
  expect(onError).toHaveBeenCalledWith(expect.objectContaining({ code: "payload" }));
  c.track("valid", { price: 0 });
  await c.flush();
  expect(batches.map((b) => b.event.event_type)).toEqual(["session_start", "valid"]);
});
test("retains rejected events and drops unsent events only on explicit opt out", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response("{}", { status: 403 })),
  );
  const c = client("dev");
  c.track("view", {});
  await expect(c.flush()).rejects.toMatchObject({ status: 403 });
  c.setOptOut(true);
  c.track("not-consented", {});
  const { batches, fetch } = requests();
  await c.flush();
  expect(fetch).not.toHaveBeenCalled();
  c.setOptOut(false);
  c.track("consented", {});
  await c.flush();
  expect(batches.map((b) => b.event.event_type)).toEqual(["consented"]);
});

test("rejects an oversized event before persisting partial session events", async () => {
  const { batches } = requests();
  const onError = vi.fn();
  const c = createClient({ apiKey: "key", bucket: "dev", onError });
  clients.push(c);
  c.track("too-large", { content: "x".repeat(1000000) });
  await c.flush();
  expect(batches).toHaveLength(0);
  expect(onError).toHaveBeenCalledWith(expect.objectContaining({ code: "payload" }));
  c.track("valid", {});
  await c.flush();
  expect(batches.map((b) => b.event.event_type)).toEqual(["session_start", "valid"]);
});

test("honors quota retry time, preserves events, and adapts batch size", async () => {
  const blocked = vi.fn(
    async () =>
      new Response("{}", {
        status: 429,
        headers: { "Retry-After": "5", "X-Tripmeter-Max-Batch-Events": "2" },
      }),
  );
  vi.stubGlobal("fetch", blocked);
  const c = client("channel_nol_dev");
  c.track("one", {});
  c.track("two", {});
  await expect(c.flush()).rejects.toMatchObject({ status: 429 });
  await vi.advanceTimersByTimeAsync(4000);
  expect(blocked).toHaveBeenCalledTimes(1);
  await expect(c.flush()).rejects.toMatchObject({ status: 429 });
  const sizes: number[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (request: Request) => {
      sizes.push((await request.json()).data.length);
      return new Response("{}", { status: 200 });
    }),
  );
  await vi.advanceTimersByTimeAsync(1000);
  await c.flush();
  expect(sizes).toEqual([2, 1]);
});

test("does not repeatedly send a rejected key from background timers", async () => {
  const fetch = vi.fn(async () => new Response("{}", { status: 403 }));
  vi.stubGlobal("fetch", fetch);
  const c = client("channel_nol_dev");
  c.track("view", {});
  await expect(c.flush()).rejects.toMatchObject({ status: 403 });
  await vi.advanceTimersByTimeAsync(60000);
  expect(fetch).toHaveBeenCalledTimes(1);
  const { batches } = requests();
  await c.flush();
  expect(batches.some((b) => b.event.event_type === "view")).toBe(true);
});
