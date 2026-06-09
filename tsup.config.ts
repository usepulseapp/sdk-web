import { defineConfig } from "tsup";
import pkg from "./package.json";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm", "cjs"],
  dts: true,
  clean: true,
  sourcemap: false,
  // Inject the SDK version at build time so context.sdkVersion is always set.
  // The fallback in source (typeof __PULSE_SDK_VERSION__ !== "undefined") handles
  // the vitest/source path where no substitution happens.
  define: {
    __PULSE_SDK_VERSION__: JSON.stringify(pkg.version),
  },
  // Zero runtime dependencies; everything tree-shakes into the output.
  external: [],
  noExternal: [],
  // Browser-first output — no Node.js shims injected.
  platform: "browser",
  target: "es2019",
});
