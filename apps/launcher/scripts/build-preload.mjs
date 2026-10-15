import { build } from "esbuild";
await build({
  entryPoints: ["src/preload/index.ts"], outfile: "dist/preload/index.cjs",
  bundle: true, format: "cjs", platform: "node", target: "node22",
  external: ["electron"], sourcemap: false,
});
