import { defineConfig } from "vitest/config";
import { packageVersion } from "./build-config";
export default defineConfig({
  define: { __TRIPMETER_VERSION__: JSON.stringify(packageVersion) },
  test: { environment: "happy-dom", restoreMocks: true },
});
