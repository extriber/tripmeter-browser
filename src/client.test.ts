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
test.each(["http://localhost:8080/tripmeter", "http://192.168.0.10:8080/tripmeter"])(
  "supports an explicitly configured development collector: %s",
  async (endpoint) => {
    const { fetch } = requests();
    const c = createClient({ apiKey: "test-key", bucket: "channel_nol_dev", endpoint });
    clients.push(c);
    c.track("development_view");
    await c.flush();
    expect(fetch.mock.calls[0][0].url).toBe(`${endpoint}/com.snowplowanalytics.snowplow/tp2`);
    expect(fetch.mock.calls[0][0].credentials).toBe("omit");
  },
);
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
test("continues sending in memory when persistent storage is unavailable", async () => {
  const { batches } = requests();
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
  await c.flush();
  expect(batches.some((b) => b.event.event_type === "view")).toBe(true);
  expect(onError).toHaveBeenCalledWith(expect.objectContaining({ code: "storage" }));
});

test("contains a denied localStorage getter and keeps collecting", async () => {
  const { batches } = requests();
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "localStorage")!;
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    get() {
      throw new DOMException("Denied", "SecurityError");
    },
  });
  try {
    const c = client("denied-storage");
    c.track("view");
    await c.flush();
    expect(batches.some((b) => b.event.event_type === "view")).toBe(true);
  } finally {
    Object.defineProperty(globalThis, "localStorage", descriptor);
  }
});

test("preserves pending events when storage fills during collection", async () => {
  const { batches } = requests();
  const c = client("storage-full");
  c.track("before_full");
  const spy = vi.spyOn(localStorage, "setItem").mockImplementation(() => {
    throw new DOMException("Full", "QuotaExceededError");
  });
  try {
    c.track("after_full");
    await c.flush();
    expect(batches.map((b) => b.event.event_type)).toEqual([
      "session_start",
      "before_full",
      "after_full",
    ]);
  } finally {
    spy.mockRestore();
  }
});

test("reports a corrupt pending event instead of resolving a flush without sending", async () => {
  const { fetch } = requests();
  const onError = vi.fn();
  const c = createClient({ apiKey: "key", bucket: "corrupt", onError });
  clients.push(c);
  c.track("view");
  const key = Array.from({ length: localStorage.length }, (_, i) => localStorage.key(i)!).find(
    (key) => key.includes(":queue:"),
  )!;
  localStorage.setItem(key, "invalid-json");
  await expect(c.flush()).rejects.toMatchObject({ code: "storage" });
  expect(onError).toHaveBeenCalledWith(expect.objectContaining({ code: "storage" }));
  expect(fetch).not.toHaveBeenCalled();
  expect(localStorage.getItem(key)).toBe("invalid-json");
});

test("bounds pending events at 1000 and resumes after the queue drains", async () => {
  const { batches } = requests();
  const onError = vi.fn();
  const c = createClient({ apiKey: "key", bucket: "capacity", onError });
  clients.push(c);
  c.track("seed");
  const seedKey = Array.from({ length: localStorage.length }, (_, i) => localStorage.key(i)!).find(
    (key) => key.includes(":queue:"),
  )!;
  const seed = JSON.parse(localStorage.getItem(seedKey)!);
  const prefix = seedKey.slice(0, seedKey.indexOf(":queue:") + 7);
  for (let i = 0; i < 998; i++) {
    const stored = structuredClone(seed);
    const envelope = JSON.parse(stored.payload.ue_pr);
    envelope.data.data.event.insert_id = `restored-${i}`;
    stored.payload.ue_pr = JSON.stringify(envelope);
    localStorage.setItem(`${prefix}restored-${i}`, JSON.stringify(stored));
  }
  c.track("overflow");
  expect(onError).toHaveBeenCalledWith(expect.objectContaining({ code: "capacity" }));
  await c.flush();
  expect(batches).toHaveLength(1000);
  expect(batches.some((b) => b.event.event_type === "overflow")).toBe(false);
  c.track("after_drain");
  await c.flush();
  expect(batches.at(-1).event.event_type).toBe("after_drain");
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
