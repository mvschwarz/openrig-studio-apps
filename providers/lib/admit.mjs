// The owner check every provider runs first, whatever owner-check.mjs a deployment ships.
// Copyright 2026 mvschwarz. Licensed under the Apache License, Version 2.0.
//
// owner-check.mjs is the one module a deployment replaces to change who a provider answers (see its header). Its ownerCheck(req)
// may answer at once or with a promise. checked(req) waits for it and fails closed: anything but { ok: true } is a refusal, and a
// check that throws, rejects or doesn't answer in time refuses too, so no request goes on before the check has said yes.
import { ownerCheck } from "./owner-check.mjs";

const REFUSED = "This request didn't come from this Studio.";

// A check that never answers would hold every request: past OWNER_CHECK_MS (10 s; OPENRIG_OWNER_CHECK_MS overrides) it's a refusal too.
const OWNER_CHECK_MS = (() => {
  const n = Number(process.env.OPENRIG_OWNER_CHECK_MS);
  return Number.isFinite(n) && n > 0 ? n : 10_000;
})();

export async function checked(req) {
  let timer;
  try {
    const owner = await Promise.race([
      ownerCheck(req),
      new Promise((resolve) => {
        timer = setTimeout(() => resolve({ ok: false }), OWNER_CHECK_MS);
      }),
    ]);
    if (owner?.ok === true) return { ok: true };
    return { ok: false, why: typeof owner?.why === "string" && owner.why ? owner.why : REFUSED };
  } catch {
    return { ok: false, why: REFUSED };
  } finally {
    clearTimeout(timer);
  }
}
