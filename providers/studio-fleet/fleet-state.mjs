// The join the dashboard actually renders: accounts × boxes, with staleness
// treated as information rather than as an error.
//
// THE RULE THAT SHAPES THIS FILE: a reading you cannot take right now does not
// erase the reading you took before. An account parked on no box cannot be
// sampled at all, and an exhausted account may not be sampleable either — but a
// RESET TIMESTAMP IS A FACT ABOUT THE PAST AND STAYS TRUE. Knowing when an
// account frees up is the thing this exists to answer, so it must not depend on
// being able to reach that account now.
//
// Hence "stale-but-last-known" is a first-class state, not a failure. The worst
// case is a slightly old answer. The worst case is never a blank.
import fs from "node:fs";
import path from "node:path";

const LINE = (o) => JSON.stringify(o) + "\n";

export function appendSample(storeDir, sample) {
  fs.mkdirSync(storeDir, { recursive: true });
  fs.appendFileSync(path.join(storeDir, "samples.jsonl"), LINE({ ...sample, at: new Date().toISOString() }));
}

export function readSamples(storeDir) {
  const f = path.join(storeDir, "samples.jsonl");
  if (!fs.existsSync(f)) return [];
  return fs.readFileSync(f, "utf8").split("\n").filter(Boolean).flatMap((l) => {
    try { return [JSON.parse(l)]; } catch { return []; }
  });
}

// Labels are the human's, not ours. An org id is not a name, and asking someone
// to recognise "3c4e00b6…" at a glance is the whole problem this dashboard is
// supposed to remove.
export function labelFor(labels, org) {
  return (org && labels[org]) || (org ? `${String(org).slice(0, 8)}…` : "unknown account");
}

export function buildView({ samples, boxes, labels = {}, now = Date.now() }) {
  // Latest sample per box, and the latest SUCCESSFUL sample per account. Those
  // are different questions: the first says what a box is on, the second says
  // what we last knew about an account wherever it was seen.
  // LAST-KNOWN IS THE READING. Not a fallback — the primary.
  //
  // The first shape treated a fresh sample as the real answer and last-known as
  // a degraded substitute. Measured against a real box, that is backwards: a
  // cached OAuth token expires on the order of an hour and only refreshes when
  // a seat on that box happens to use it, so an occasional dashboard will find
  // the credential stale far more often than fresh. Under the old shape the
  // normal case rendered as degradation.
  //
  // So a box's reading is the last good reading we have, and FRESHNESS IS AN
  // ATTRIBUTE OF IT rather than a different kind of state. Sampling does not
  // produce a different sort of answer; it makes the same answer younger.
  //
  // What that does NOT license is hiding age. A number with no age invites
  // someone to act on it as current, which is why readingFrom is not optional
  // and the surface leads with how old it is.
  const lastGoodByBox = new Map();
  const lastAttemptByBox = new Map();
  const lastGoodByOrg = new Map();
  for (const s of samples) {
    if (!s.host) continue;
    lastAttemptByBox.set(s.host, s);
    if (s.sampled) {
      lastGoodByBox.set(s.host, s);
      if (s.org) lastGoodByOrg.set(s.org, s);
    }
  }

  const boxRows = boxes.map((host) => {
    // Keyed on the BOX, not the org. A failed probe often carries no org at all
    // — the live 401 did — so an org-keyed lookup loses the box's own history
    // exactly when it is needed, and every column renders as a dash while a
    // perfectly good reading from an hour ago sits in the store.
    const good = lastGoodByBox.get(host) || null;
    const attempt = lastAttemptByBox.get(host) || null;
    return {
      host,
      account: good?.org ?? attempt?.org ?? null,
      label: (good?.org ?? attempt?.org) ? labelFor(labels, good?.org ?? attempt?.org) : null,
      // The reading. Always the last good one; null only if there has never been one.
      used5h: good?.used5h ?? null,
      used7d: good?.used7d ?? null,
      resets5h: good?.resets5h ?? null,
      resets7d: good?.resets7d ?? null,
      readingFrom: good?.at ?? null,
      hasReading: Boolean(good),
      // The attempt is SECONDARY — it says whether the reading got any younger,
      // not whether the reading is trustworthy. An auth failure here means the
      // credential on that box is stale; it says nothing about the account.
      lastAttempt: attempt && {
        at: attempt.at,
        ok: Boolean(attempt.sampled),
        reason: attempt.sampled ? null : attempt.reason ?? null,
        authFailed: attempt.authFailed ?? undefined,
      },
    };
  });

  // Accounts we have ever seen, whether or not any box holds one now. A parked
  // account is the case the human most often forgets, so it belongs in the view
  // rather than dropping out of it when it stops being attached to anything.
  const onBoxNow = new Set(boxRows.map((b) => b.account).filter(Boolean));
  const accountRows = [...lastGoodByOrg.values()].map((s) => ({
    account: s.org,
    label: labelFor(labels, s.org),
    used5h: s.used5h ?? null,
    used7d: s.used7d ?? null,
    resets5h: s.resets5h ?? null,
    resets7d: s.resets7d ?? null,
    lastGoodAt: s.at,
    onBox: boxRows.find((b) => b.account === s.org)?.host ?? null,
    // THE HEADLINE. For a parked account this is the whole point: when does it
    // become usable again. Derived from the last good reading, because nothing
    // can sample an account that is attached to nothing.
    availableAgainAt: onBoxNow.has(s.org) ? null : s.resets7d ?? null,
  })).sort((a, b) => (b.used7d ?? -1) - (a.used7d ?? -1));

  return {
    generatedAt: new Date(now).toISOString(),
    boxes: boxRows,
    accounts: accountRows,
    // The instrument is honest about its own footprint: each sample spends a
    // real request against the very budget it reports.
    cost: { callsLastPoll: boxRows.length, note: "one API call per sampled box per poll" },
  };
}
