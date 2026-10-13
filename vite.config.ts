import { defineConfig } from "vite";
import { packageVersion } from "./build-config";
export default defineConfig({
  define: { __TRIPMETER_VERSION__: JSON.stringify(packageVersion) },
  build: {
    lib: {
      entry: "src/index.ts",
      name: "Tripmeter",
      formats: ["es", "iife"],
      fileName: (format) => (format === "es" ? "index.js" : "tripmeter.js"),
    },
  },
});
