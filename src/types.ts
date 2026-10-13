export type Property = string | number | boolean | null | Property[] | { [key: string]: Property };
export type Properties = Record<string, Property>;
export type IdentifyOperations = { $set?: Properties; $setOnce?: Properties; $unset?: string[] };
export type ClientOptions = {
  apiKey: string;
  bucket: string;
  endpoint?: string;
  onError?: (error: TripmeterError) => void;
};
export class TripmeterError extends Error {
  constructor(
    public readonly code: "configuration" | "storage" | "delivery" | "payload" | "capacity",
    public readonly status?: number,
  ) {
    super(`Tripmeter ${code} failure${status === undefined ? "" : ` (${status})`}`);
    this.name = "TripmeterError";
  }
}
export type SdkEvent = {
  event_type: string;
  device_id: string;
  user_id?: string;
  session_id: number;
  time: number;
  insert_id: string;
  event_id: number;
  event_properties: Properties;
  user_properties: Properties;
  user_properties_snapshot: Properties;
  platform: "Web";
  user_agent: string;
  language: string;
  ip: "$remote";
  library: string;
};
