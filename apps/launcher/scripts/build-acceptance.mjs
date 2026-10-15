import { build } from "esbuild";
import fs from "node:fs";
fs.mkdirSync("dist-acceptance", { recursive: true });
await build({ entryPoints: ["src/testing/renderer-fixture.tsx"], bundle: true, outfile: "dist-acceptance/fixture.js", platform: "browser", format: "esm", jsx: "automatic", target: "chrome152" });
fs.writeFileSync("dist-acceptance/index.html", '<!doctype html><html lang="vi"><head><meta charset="UTF-8"><meta http-equiv="Content-Security-Policy" content="default-src \'self\'; script-src \'self\'; style-src \'self\' \'unsafe-inline\'; img-src \'self\' data:; connect-src \'self\'"><link rel="stylesheet" href="fixture.css"></head><body><div id="root"></div><script type="module" src="fixture.js"></script></body></html>');
