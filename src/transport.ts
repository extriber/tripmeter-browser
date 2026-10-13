import { newEmitter } from "@snowplow/tracker-core";
import type { Queue } from "./queue.js";
import { TripmeterError } from "./types.js";

export class Transport {
  private pending?: Promise<void>;
  private nextAttemptAt = 0;
  private lastFailure?: TripmeterError;
  private failures = 0;
  canFlushAutomatically(): boolean {
    return Date.now() >= this.nextAttemptAt;
  }
  constructor(
    private readonly endpoint: URL,
    private readonly queue: Queue,
  ) {}
  flush(keepalive = false): Promise<void> {
    if (this.pending) return this.pending;
    if (this.lastFailure?.status === 429 && !this.canFlushAutomatically())
      return Promise.reject(this.lastFailure);
    this.pending = this.send(keepalive).finally(() => {
      this.pending = undefined;
    });
    return this.pending;
  }
  private async send(keepalive: boolean): Promise<void> {
    let failure: TripmeterError | undefined;
    const emitter = newEmitter({
      endpoint: this.endpoint.host,
      protocol: this.endpoint.protocol === "https:" ? "https" : "http",
      postPath: `${this.endpoint.pathname.replace(/\/$/, "")}/com.snowplowanalytics.snowplow/tp2`,
      // Fetch keepalive requests share a 64 KiB browser budget; larger events stay queued for the next normal flush.
      maxPostBytes: keepalive ? 60000 : 1000000,
      connectionTimeout: 10000,
      keepalive,
      credentials: "omit",
      eventStore: this.queue,
      retryStatusCodes: [400, 401, 403, 410, 413, 422],
      customFetch: async (request) => {
        try {
          const response = await fetch(request);
          if (!response.ok) {
            failure = new TripmeterError("delivery", response.status);
            if (response.status === 429) {
              this.queue.limitBatch(Number(response.headers.get("X-Tripmeter-Max-Batch-Events")));
              const retry = response.headers.get("Retry-After");
              const seconds = retry === null ? Number.NaN : Number(retry);
              const retryAt = Number.isFinite(seconds)
                ? Date.now() + Math.max(0, seconds) * 1000
                : Date.parse(retry ?? "");
              this.nextAttemptAt = Number.isFinite(retryAt)
                ? Math.max(Date.now() + 1000, retryAt)
                : Date.now() + this.retryDelay();
            } else if ([400, 401, 403, 410, 413, 422].includes(response.status)) {
              this.nextAttemptAt = Number.POSITIVE_INFINITY;
            } else this.nextAttemptAt = Date.now() + this.retryDelay();
          }
          return response;
        } catch {
          failure = new TripmeterError("delivery");
          this.nextAttemptAt = Date.now() + this.retryDelay();
          throw failure;
        }
      },
    });
    await emitter.flush();
    if (failure) {
      this.lastFailure = failure;
      throw failure;
    }
    this.lastFailure = undefined;
    this.nextAttemptAt = 0;
    this.failures = 0;
  }
  private retryDelay(): number {
    return Math.min(60000, 1000 * 2 ** Math.min(this.failures++, 6));
  }
}
