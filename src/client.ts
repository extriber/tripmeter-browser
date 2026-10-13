import { validateProperties } from "./validation.js";
import { Queue } from "./queue.js";
import { StateStore, touchSession, type State } from "./state.js";
import { Transport } from "./transport.js";
import {
  TripmeterError,
  type ClientOptions,
  type IdentifyOperations,
  type Properties,
  type SdkEvent,
} from "./types.js";

declare const __TRIPMETER_VERSION__: string;

const instances = new Map<string, TripmeterClient>();
export class TripmeterClient {
  private readonly store: StateStore;
  private readonly queue: Queue;
  private readonly transport: Transport;
  private readonly timer: ReturnType<typeof setInterval>;
  private destroyed = false;
  private disabled = false;
  private readonly automaticFlush = () => {
    if (!this.transport.canFlushAutomatically()) return;
    void this.flush().catch((error) => this.report(error));
  };
  private readonly hiddenFlush = () => {
    if (document.visibilityState === "hidden" && this.transport.canFlushAutomatically())
      void this.flush(true).catch((error) => this.report(error));
  };
  private readonly pagehideFlush = () => {
    if (!this.transport.canFlushAutomatically()) return;
    void this.flush(true).catch((error) => this.report(error));
  };

  constructor(
    private readonly options: ClientOptions,
    private readonly scope: string,
    endpoint: URL,
  ) {
    this.store = new StateStore(localStorage, `TRIPMETER:browser:v1:${scope}:state`);
    this.queue = new Queue(localStorage, `TRIPMETER:browser:v1:${scope}:queue:`, options.apiKey);
    this.transport = new Transport(endpoint, this.queue);
    this.guard(() => {
      const state = this.store.read();
      this.store.write(state);
    });
    this.timer = setInterval(this.automaticFlush, 1000);
    window.addEventListener("online", this.automaticFlush);
    window.addEventListener("pagehide", this.pagehideFlush);
    document.addEventListener("visibilitychange", this.hiddenFlush);
  }
  private report(error: unknown): void {
    try {
      this.options.onError?.(
        error instanceof TripmeterError ? error : new TripmeterError("storage"),
      );
    } catch {
      /* Host callbacks cannot break collection. */
    }
  }
  private guard(action: () => void): void {
    if (this.destroyed || this.disabled) return;
    try {
      action();
    } catch (error) {
      if (!(error instanceof TripmeterError && error.code === "payload")) this.disabled = true;
      this.report(error);
    }
  }
  setUserId(userId: string): void {
    this.guard(() => {
      if (typeof userId !== "string" || !userId.trim()) throw new TripmeterError("payload");
      const state = this.store.read();
      state.userId = userId;
      this.store.write(state);
    });
  }
  identify(operations: IdentifyOperations): void {
    this.guard(() => {
      const state = this.store.read();
      if (state.optedOut) return;
      validateProperties(operations.$setOnce ?? {});
      validateProperties(operations.$set ?? {});
      for (const [key, value] of Object.entries(operations.$setOnce ?? {})) {
        if (!Object.hasOwn(state.properties, key))
          state.properties = { ...state.properties, [key]: structuredClone(value) };
      }
      state.properties = { ...state.properties, ...structuredClone(operations.$set ?? {}) };
      for (const key of operations.$unset ?? []) delete state.properties[key];
      const wire: Properties = {};
      if (operations.$set) wire.$set = operations.$set;
      if (operations.$setOnce) wire.$setOnce = operations.$setOnce;
      if (operations.$unset)
        wire.$unset = Object.fromEntries(operations.$unset.map((key) => [key, "-"]));
      this.trackState(state, "$identify", {}, wire);
    });
  }
  track(name: string, properties: Properties = {}): void {
    this.guard(() => {
      this.trackState(this.store.read(), name, properties);
    });
  }
  private trackState(
    state: State,
    name: string,
    properties: Properties,
    operations?: Properties,
  ): void {
    if (state.optedOut) return;
    if (typeof name !== "string" || !name.trim()) throw new TripmeterError("payload");
    validateProperties(properties);
    const now = Date.now();
    const lifecycle = touchSession(state, now);
    const events = lifecycle.map((event) =>
      this.createEvent(state, event.name, {}, event.time, event.sessionId),
    );
    events.push(this.createEvent(state, name, properties, now, state.session!.id, operations));
    this.queue.enqueue(this.options.bucket, events);
    this.store.write(state);
    void this.queue
      .count()
      .then((count) => {
        if (count >= 30) this.automaticFlush();
      })
      .catch((error) => {
        this.disabled = true;
        this.report(error);
      });
  }
  private createEvent(
    state: State,
    name: string,
    properties: Properties,
    time: number,
    sessionId: number,
    operations?: Properties,
  ): SdkEvent {
    return {
      event_type: name,
      device_id: state.deviceId,
      user_id: state.userId,
      session_id: sessionId,
      time,
      insert_id: crypto.randomUUID(),
      event_id: ++state.sequence,
      event_properties: structuredClone(properties),
      user_properties: structuredClone(operations ?? state.properties),
      user_properties_snapshot: structuredClone(state.properties),
      platform: "Web",
      user_agent: navigator.userAgent,
      language: navigator.languages?.[0] ?? navigator.language,
      ip: "$remote",
      library: `tripmeter-browser/${__TRIPMETER_VERSION__}`,
    };
  }
  reset(): void {
    this.guard(() => {
      const previous = this.store.read();
      this.store.write({
        deviceId: crypto.randomUUID(),
        properties: {},
        sequence: 0,
        optedOut: previous.optedOut,
      });
    });
  }
  setOptOut(optedOut: boolean): void {
    this.guard(() => {
      const state = this.store.read();
      state.optedOut = optedOut;
      this.store.write(state);
      if (optedOut) this.queue.clear();
    });
  }
  async flush(keepalive = false): Promise<void> {
    if (this.destroyed || this.disabled || this.store.read().optedOut) return;
    await this.transport.flush(keepalive);
  }
  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    clearInterval(this.timer);
    window.removeEventListener("online", this.automaticFlush);
    window.removeEventListener("pagehide", this.pagehideFlush);
    document.removeEventListener("visibilitychange", this.hiddenFlush);
    instances.delete(this.scope);
  }
}
export function createClient(options: ClientOptions): TripmeterClient {
  if (
    typeof options.apiKey !== "string" ||
    !options.apiKey.trim() ||
    typeof options.bucket !== "string" ||
    !options.bucket.trim()
  )
    throw new TripmeterError("configuration");
  let endpoint: URL;
  try {
    endpoint = new URL(options.endpoint ?? "https://collect.tripstore.kr/tripmeter");
  } catch {
    throw new TripmeterError("configuration");
  }
  if (
    !["https:", "http:"].includes(endpoint.protocol) ||
    endpoint.username ||
    endpoint.password ||
    endpoint.search ||
    endpoint.hash
  )
    throw new TripmeterError("configuration");
  const scope = encodeURIComponent(
    `${endpoint.origin}${endpoint.pathname.replace(/\/$/, "")}:${options.bucket}`,
  );
  if (instances.has(scope)) throw new TripmeterError("configuration");
  const client = new TripmeterClient(Object.freeze({ ...options }), scope, endpoint);
  instances.set(scope, client);
  return client;
}
