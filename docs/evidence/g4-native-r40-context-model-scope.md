# Native 40: initial context model scope

Date: 19/10/2026. Baseline `e03c19b3fe6c3021a9a035fcf824975a8c8b4b30`. Native **40 / browser worker 25**.

## Diagnosis and change

The user's Native 39 health trace described a retained `append`, not an initial full load: 13,916 prompt characters versus 67,829 full characters, two planned transport messages. The fragment input readback was verified and Send acceptance observed. Web completed with a 302-character `native_envelope`, not the required ACK. The attempt failed with `CONTEXT_FRAGMENT_ACK_FAILED`, delivery unknown. This does not establish why the model ignored the ACK instruction, but rules out treating the observed response as a valid staging acknowledgement.

Native passed the context staging model for every mode except `patch`. Consequently a short append was forced into staging plus COMMIT even though it fit one normal message. Native 40 passes the staging model only for `full`; a request without a stable retained plan also remains a full load. Initial/rebound full loads retain the requested 3.8 behavior. Append, patch and replacement use the primary model. Large updates can still require fragments and strict ACK; this is not a general ACK bypass or a claim that all Web failures are fixed.

Strict ACK validation, failed/unknown fences and no automatic resend remain intact. The fix does not forward a premature staging tool call to the IDE. Browser worker code and fingerprint are unchanged.

## Validation

An actual HTTP regression captures generation options and runs the real transport planner for initial full, append, patch, compact replacement and a stateless full request. The old condition fails the model-scope assertion; the fix passes, preserving staging for both full cases and one-message transport for short retained updates.

- Native build PASS.
- All **188 Native tests PASS**, zero failure, cancellation or skip.
- Root typecheck and lint PASS.
- Red/green logs: `.tmp/r40-regression-before.log` and `.tmp/r40-regression-after.log`.
- Suite/check logs: `.tmp/r40-native-tests.log`, `.tmp/r40-build.log`, `.tmp/r40-typecheck.log`, `.tmp/r40-lint.log`.

Source/build and log hashes are in the [manifest](mcp/native-r40-context-model-scope.json). The previous 440-test whole-repository result belongs to `e03c19b`; no fresh whole-repository 441-test result is claimed here.

## Login and live acceptance

The user confirmed the rejected Google sign-in is in **Secondary Account**. No authentication/profile change, browser restart or live resend was performed for this hotfix. Default remains untouched. The configured driver can launch with `--enable-automation`; Google lists software-controlled browsers among possible sign-in restrictions in its [supported-browser guidance](https://support.google.com/accounts/answer/7675428?hl=en). The screenshot alone does not identify every Google risk signal, and removing that flag is not a proven login fix.

Native 40 still needs an idle manual restart and real Default smoke test. The two-model full-load flow, two-account handoff, complete IDE executor and P6–P8 gates remain open. Use the [quick test guide](../NATIVE_TEST_QUICKSTART.md); never delete fences or automatically replay the failed request to obtain a green result. No push, merge or deployment.
