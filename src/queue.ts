import type { EventStore, EventStorePayload } from "@snowplow/tracker-core";
import { TripmeterError, type SdkEvent } from "./types.js";

/** Queue entries contain the immutable bucket and event, never a credential. */
export class Queue implements EventStore {
  private inflight: string[] = [];
  private batchLimit = 2000;
  limitBatch(count: number): void {
    if (Number.isSafeInteger(count) && count > 0) this.batchLimit = Math.min(2000, count);
  }
  constructor(
    private readonly storage: Storage,
    private readonly prefix: string,
    private readonly apiKey: string,
  ) {}
  private keys(): string[] {
    return Array.from({ length: this.storage.length }, (_, i) => this.storage.key(i))
      .filter((key): key is string => key !== null && key.startsWith(this.prefix))
      .sort();
  }
  enqueue(bucket: string, events: SdkEvent[]): void {
    // Validate the full emission before persisting even its session lifecycle events.
    const entries = events.map((event) => ({ event, value: this.encode(bucket, event) }));
    for (const { event, value } of entries) {
      this.storage.setItem(
        `${this.prefix}${String(Date.now()).padStart(16, "0")}:${String(event.event_id).padStart(16, "0")}:${event.insert_id}`,
        JSON.stringify(value),
      );
    }
  }
  private encode(bucket: string, event: SdkEvent): EventStorePayload {
    const value: EventStorePayload = {
      payload: {
        e: "ue",
        eid: event.insert_id,
        dtm: String(event.time),
        ue_pr: JSON.stringify({
          schema: "iglu:com.snowplowanalytics.snowplow/unstruct_event/jsonschema/1-0-0",
          data: {
            schema: "iglu:kr.tripstore/tripmeter_event/jsonschema/1-0-0",
            data: { bucket, event },
          },
        }),
      },
    };
    // Leave room for the wire envelope and current credential within the existing 1 MB collector batch limit.
    if (new TextEncoder().encode(JSON.stringify(this.authorize(value))).length + 88 > 1000000)
      throw new TripmeterError("payload");
    return value;
  }
  private authorize(value: EventStorePayload): EventStorePayload {
    const payload = { ...value.payload };
    const envelope = JSON.parse(String(payload.ue_pr));
    envelope.data.data.api_key = this.apiKey;
    payload.ue_pr = JSON.stringify(envelope);
    return { ...value, payload };
  }
  async count(): Promise<number> {
    return this.keys().length;
  }
  async add(value: EventStorePayload): Promise<number> {
    this.storage.setItem(
      `${this.prefix}${Date.now()}:${crypto.randomUUID()}`,
      JSON.stringify(value),
    );
    return this.count();
  }
  async removeHead(count: number): Promise<void> {
    this.inflight.slice(0, count).forEach((key) => this.storage.removeItem(key));
    this.inflight = this.inflight.slice(count);
  }
  iterator(): ReturnType<EventStore["iterator"]> {
    this.inflight = this.keys().slice(0, this.batchLimit);
    const keys = [...this.inflight];
    let index = 0;
    return {
      next: async () => {
        while (index < keys.length) {
          const raw = this.storage.getItem(keys[index++]);
          if (raw) return { done: false, value: this.authorize(JSON.parse(raw)) };
        }
        return { done: true, value: undefined };
      },
    };
  }
  async getAll(): Promise<EventStorePayload[]> {
    return this.keys().flatMap((key) => {
      const raw = this.storage.getItem(key);
      return raw ? [this.authorize(JSON.parse(raw))] : [];
    });
  }
  async getAllPayloads(): ReturnType<EventStore["getAllPayloads"]> {
    return (await this.getAll()).map((value) => value.payload);
  }
  clear(): void {
    this.keys().forEach((key) => this.storage.removeItem(key));
  }
}
