import { TripmeterError } from "./types.js";

/** Keeps this client's data available in memory if browser persistence becomes unavailable. */
export class ScopedStorage implements Storage {
  private persistent?: Storage;
  private readonly memory = new Map<string, string>();
  private names: string[] = [];

  constructor(
    private readonly prefix: string,
    private readonly onError: (error: TripmeterError) => void,
  ) {
    try {
      this.persistent = globalThis.localStorage;
      this.refresh();
      if (!this.persistent) return;
      const probe = `${prefix}probe`;
      this.persistent.setItem(probe, probe);
      if (this.persistent.getItem(probe) !== probe) throw new Error("Storage unavailable");
      this.persistent.removeItem(probe);
    } catch {
      this.useMemory();
    }
  }

  private useMemory(): void {
    this.persistent = undefined;
    this.onError(new TripmeterError("storage"));
  }

  private refresh(): void {
    if (this.persistent) {
      const data = new Map<string, string>();
      try {
        for (let i = 0; i < this.persistent.length; i++) {
          const key = this.persistent.key(i);
          if (key?.startsWith(this.prefix)) {
            const value = this.persistent.getItem(key);
            if (value !== null) data.set(key, value);
          }
        }
        this.memory.clear();
        data.forEach((value, key) => this.memory.set(key, value));
      } catch {
        this.useMemory();
      }
    }
    this.names = [...this.memory.keys()];
  }

  get length(): number {
    this.refresh();
    return this.names.length;
  }
  key(index: number): string | null {
    return this.names[index] ?? null;
  }
  getItem(key: string): string | null {
    if (this.persistent) {
      try {
        const value = this.persistent.getItem(key);
        if (value === null) this.memory.delete(key);
        else this.memory.set(key, value);
        return value;
      } catch {
        this.useMemory();
      }
    }
    return this.memory.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.memory.set(key, value);
    if (this.persistent) {
      try {
        this.persistent.setItem(key, value);
      } catch {
        this.useMemory();
      }
    }
  }
  removeItem(key: string): void {
    this.memory.delete(key);
    if (this.persistent) {
      try {
        this.persistent.removeItem(key);
      } catch {
        this.useMemory();
      }
    }
  }
  clear(): void {
    this.refresh();
    for (const key of this.names) this.removeItem(key);
  }
}
