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
  const latestByBox = new Map();
  const lastGoodByOrg = new Map();
  for (const s of samples) {
    if (s.host) latestByBox.set(s.host, s);
    if (s.sampled && s.org) lastGoodByOrg.set(s.org, s);
  }

  const boxRows = boxes.map((host) => {
    const s = latestByBox.get(host);
    if (!s) return { host, state: "never-sampled", account: null, label: null, reason: null,
      used5h: null, used7d: null, resets5h: null, resets7d: null, readingFrom: null, lastSeen: null };
    const good = s.sampled ? s : (s.org ? lastGoodByOrg.get(s.org) : null);
    return {
      host,
      account: s.org || good?.org || null,
      label: labelFor(labels, s.org || good?.org),
      // Fresh reading, or an honest fallback that says which it is. A dashboard
      // that shows a number without saying how old it is invites someone to act
      // on it as if it were current.
      state: s.sampled ? "sampled" : (good ? "stale-but-last-known" : "unsampled"),
      reason: s.sampled ? null : s.reason || null,
      used5h: (s.sampled ? s : good)?.used5h ?? null,
      used7d: (s.sampled ? s : good)?.used7d ?? null,
      resets5h: (s.sampled ? s : good)?.resets5h ?? null,
      resets7d: (s.sampled ? s : good)?.resets7d ?? null,
      readingFrom: s.sampled ? s.at : good?.at ?? null,
      lastSeen: s.at,
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
