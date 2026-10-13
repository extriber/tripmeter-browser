import { TripmeterError, type Properties } from "./types.js";

export function validateProperties(properties: Properties): void {
  const ancestors = new Set<object>();
  const visit = (value: unknown): void => {
    if (value === null || typeof value === "string" || typeof value === "boolean") return;
    if (typeof value === "number" && Number.isFinite(value)) return;
    if (typeof value !== "object" || ancestors.has(value)) throw new TripmeterError("payload");
    if (!Array.isArray(value) && ![Object.prototype, null].includes(Object.getPrototypeOf(value)))
      throw new TripmeterError("payload");
    ancestors.add(value);
    Object.values(value).forEach(visit);
    ancestors.delete(value);
  };
  if (properties === null || typeof properties !== "object" || Array.isArray(properties))
    throw new TripmeterError("payload");
  visit(properties);
}
