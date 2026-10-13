import { createClient, TripmeterError, type Properties } from "./dist/index.js";
const values: Properties = { price: 0, active: false, nested: { ids: ["001"] } };
const client = createClient({ apiKey: "type-contract-key", bucket: "channel_nol_dev" });
client.track("type-contract", values);
client.identify({ $unset: ["tier"] });
const error: Error = new TripmeterError("delivery", 503);
void error;
