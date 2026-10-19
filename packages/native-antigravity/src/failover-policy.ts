import { z } from "zod";
import { NativeRouteError } from "./native-protocol.js";

export const NativeNotSentProofSchema=z.object({
  delivery:z.literal("not_sent"),code:z.string().regex(/^[A-Z0-9_]{1,80}$/),
  phase:z.enum(["checkpoint","model_selection","submission"]),observedAt:z.string().datetime(),
}).strict();
export type NativeNotSentProof=z.infer<typeof NativeNotSentProofSchema>;
const eligibleCodes=new Set(["BUSY","MODEL_UNAVAILABLE","BROWSER_LOGIN_REQUIRED","ACCOUNT_IDENTITY_UNVERIFIED","ACCOUNT_IDENTITY_CHANGED"]);

/** Only explicit local/broker no-Send failures may authorize another account. */
export function nativeNotSentProof(error:unknown):NativeNotSentProof|undefined {
  if(!(error instanceof NativeRouteError)||error.delivery!=="not_sent")return;
  const parsed=NativeNotSentProofSchema.safeParse({delivery:error.delivery,code:error.code,phase:error.phase,observedAt:new Date().toISOString()});
  return parsed.success?parsed.data:undefined;
}
export function permitsAccountFailover(proof:NativeNotSentProof):boolean {
  // Captchas, generic Web errors, ACK failures, cancellation and unknown outcomes
  // are deliberately not quota signals or authorization to switch accounts.
  return eligibleCodes.has(proof.code);
}
