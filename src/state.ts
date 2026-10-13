import type { Properties } from "./types.js";

type Session = { id: number; lastActivity: number };
export type State = {
  deviceId: string;
  userId?: string;
  properties: Properties;
  sequence: number;
  session?: Session;
  optedOut: boolean;
};
export class StateStore {
  constructor(
    private readonly storage: Storage,
    private readonly key: string,
  ) {}
  read(): State {
    const raw = this.storage.getItem(this.key);
    if (!raw)
      return { deviceId: crypto.randomUUID(), properties: {}, sequence: 0, optedOut: false };
    const state = JSON.parse(raw) as State;
    if (
      !state.deviceId ||
      typeof state.sequence !== "number" ||
      typeof state.properties !== "object" ||
      state.properties === null
    )
      throw new Error("Invalid Tripmeter state");
    return state;
  }
  write(state: State): void {
    this.storage.setItem(this.key, JSON.stringify(state));
  }
}
export function touchSession(
  state: State,
  now: number,
): { name: string; time: number; sessionId: number }[] {
  const events = [];
  if (!state.session || now - state.session.lastActivity > 1800000) {
    if (state.session)
      events.push({
        name: "session_end",
        time: state.session.lastActivity + 1,
        sessionId: state.session.id,
      });
    state.session = { id: now, lastActivity: now };
    events.push({ name: "session_start", time: now, sessionId: now });
  } else state.session.lastActivity = now;
  return events;
}
