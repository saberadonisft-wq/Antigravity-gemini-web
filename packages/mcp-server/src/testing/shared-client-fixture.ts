import { runSharedStdio } from "../shared-stdio.js";

// Test frontend only. The owning test supplies a labelled controlled runtime in its own process.
try {
  await runSharedStdio({ scope: process.env.AG_TEST_SCOPE!, descriptorFile: process.env.AG_TEST_DESCRIPTOR!, fingerprint: process.env.AG_TEST_FINGERPRINT!, createRuntime: async () => { throw Error("Fixture owner must already be running"); } });
  process.exit(0);
} catch { console.error("Owned fixture connection rejected"); process.exit(1); }
