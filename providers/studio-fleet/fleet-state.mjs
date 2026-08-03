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


// THE WEEKLY RESET IS THE ONE THING WE CAN KNOW EXACTLY, AND IT IS THE ANSWER
// THAT MATTERS MOST. Usage is a live number that needs a live credential; the
// reset is a SCHEDULE. Limits refresh weekly at the same day and time for a
// given account, so a single observed reset timestamp projects forward forever:
// add seven days until it lands in the future.
//
// That is what makes a parked account answerable. Nothing can sample an account
// attached to no box — but "when does it come back" was never a question about
// now. It is arithmetic on a fact from the past.
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

export function projectWeeklyReset(observedIso, now = Date.now()) {
  if (!observedIso) return null;
  const t = Date.parse(observedIso);
  if (!Number.isFinite(t)) return null;
  let next = t;
  while (next <= now) next += WEEK_MS;
  return new Date(next).toISOString();
}

// The recurring slot in words, because "Tuesdays 09:00 UTC" is what a person
// plans around, and it is stable even when the next date is not memorable.
export function weeklySlot(observedIso) {
  if (!observedIso) return null;
  const d = new Date(observedIso);
  if (Number.isNaN(d.getTime())) return null;
  const day = ["Sunday","Monday","Tuesday","Wednesday","Thursday","Friday","Saturday"][d.getUTCDay()];
  const hh = String(d.getUTCHours()).padStart(2, "0");
  const mm = String(d.getUTCMinutes()).padStart(2, "0");
  return `${day}s ${hh}:${mm} UTC`;
}

export function buildView({ samples, boxes, labels = {}, now = Date.now(), overrides = {} }) {
  // Operator-supplied facts, kept separate from samples all the way through so a
  // typed number is never silently presented as something we measured.
  const ovAccounts = overrides.accounts || {};
  const ovAssign = overrides.assignments || {};
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
  // Account -> where it was last seen and when. Distinct from the last GOOD
  // reading: an account can be observed on a machine without its usage being
  // readable, and that observation is still the mapping this tool is for.
  const lastHostByOrg = new Map();
  const lastSeenByOrg = new Map();
  for (const s of samples) {
    if (!s.host) continue;
    lastAttemptByBox.set(s.host, s);
    if (s.sampled) {
      lastGoodByBox.set(s.host, s);
      if (s.org) lastGoodByOrg.set(s.org, s);
    }
    if (s.org) { lastHostByOrg.set(s.org, s.host); lastSeenByOrg.set(s.org, s.at); }
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
      // Identity and plan come from whichever observation is NEWEST, good or not.
      // They are read off disk and do not depend on the usage call succeeding, so
      // tying them to the last GOOD sample would blank the account name on exactly
      // the machines that could not be sampled — which is when you most want to
      // know what they are running.
      plan: attempt?.plan ?? good?.plan ?? null,
      tier: attempt?.tier ?? good?.tier ?? null,
      codex: attempt?.codex ?? good?.codex ?? null,
      // An operator assignment is the authority on which account a machine is on.
      // The probe reports what it FOUND; the operator is who put it there, and
      // right after a switch the probe has not looked again yet.
      claudeAccount: ovAssign[host]?.claude ?? good?.org ?? attempt?.org ?? null,
      codexAccount: ovAssign[host]?.codex ?? (attempt?.codex ?? good?.codex)?.email ?? null,
      idle: attempt?.idle ?? undefined,
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

  // CODEX ACCOUNTS ARE ACCOUNTS TOO. They are identified by email rather than by
  // an opaque id, they are read off disk rather than measured, and they carry no
  // usage figure — but they are still a thing you assign to a machine and still a
  // thing you need to see the capacity of. Leaving them out meant the dropdown for
  // one of the two providers had nothing to choose from.
  const codexSeen = new Map();
  for (const s2 of samples) {
    const c = s2.codex;
    if (c?.email && !codexSeen.has(c.email)) codexSeen.set(c.email, { ...c, host: s2.host, at: s2.at });
  }
  const codexRows = [...codexSeen.values()].map((c) => {
    const ov = ovAccounts[c.email] || {};
    const onBox = boxRows.find((b) => b.codexAccount === c.email)?.host ?? null;
    const cap = ov.capacityLeft === undefined ? null : ov.capacityLeft;
    return {
      account: c.email,
      provider: "codex",
      label: ov.label || c.email,
      plan: c.plan ?? null,
      capacityLeft: cap,
      // Typed or nothing: no probe reads a codex usage figure today, so claiming
      // anything else here would be inventing a measurement.
      capacitySource: cap === null ? "none" : "typed",
      capacitySetAt: ov.capacitySetAt ?? null,
      resetsWeeklyAt: ov.resetsWeeklyAt ?? null,
      nextResetAt: null,
      onBox,
      lastSeenOnHost: onBox ?? c.host ?? null,
      lastSeenAt: c.at ?? null,
      subscriptionUntil: c.subscriptionUntil ?? null,
      state: cap === null ? "not measured — usage unreadable for this provider"
           : cap <= 5 ? "nearly spent" : cap <= 25 ? "running low" : "has room",
      readyToSwitchTo: !onBox && (cap ?? 0) >= 50,
    };
  });
  const accountRows = [...lastGoodByOrg.values()].map((s) => ({
    account: s.org,
    provider: "claude",
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

    // WHAT YOU ACTUALLY DECIDE ON: how much room is left, and when it refills.
    // `used` and `left` are the same fact, but the decision is "can I send work
    // here", so the view states it that way round.
    capacityLeft: s.used7d === null || s.used7d === undefined ? null : Math.max(0, 100 - s.used7d),
    resetsWeeklyAt: weeklySlot(s.resets7d),
    nextResetAt: projectWeeklyReset(s.resets7d, now),

    // A reading taken BEFORE its own reset has been overtaken by it. The limit
    // refreshed, so an old 97% no longer describes this account — but we did not
    // measure the new value and must not invent one. Say the reading is spent,
    // say why, and let a fresh sample replace it.
    readingSupersededByReset: Boolean(
      s.resets7d && Date.parse(s.resets7d) <= now && Date.parse(s.at) < Date.parse(s.resets7d),
    ),
  })).map((a) => ({
    ...a,
    // WHEN THIS ACCOUNT WAS LAST IN USE, and on what. Half the value of this tool
    // is the mapping alone: which account is on which machine, and when it last
    // drove anything. That answer needs no live credential at all.
    lastSeenOnHost: a.onBox ?? lastHostByOrg.get(a.account) ?? null,
    lastSeenAt: lastSeenByOrg.get(a.account) ?? a.lastGoodAt ?? null,

    // A MEASUREMENT BEATS A TYPED VALUE, but only when it is NEWER. Otherwise an
    // operator correcting a stale number gets overwritten by the stale number on
    // the next render, which makes the field feel broken and teaches people not
    // to trust it. Typed values are LABELLED as typed rather than blended in — a
    // number whose provenance is unknown cannot be read at a glance, which is the
    // whole purpose of this surface.
    ...(() => {
      const ov = ovAccounts[a.account] || {};
      const typedAt = ov.capacitySetAt ? Date.parse(ov.capacitySetAt) : null;
      const measuredAt = a.lastGoodAt ? Date.parse(a.lastGoodAt) : null;
      const typedWins = ov.capacityLeft !== undefined && ov.capacityLeft !== null &&
        (measuredAt === null || (typedAt !== null && typedAt >= measuredAt));
      return {
        label: ov.label || a.label,
        capacityLeft: typedWins ? ov.capacityLeft : a.capacityLeft,
        capacitySource: typedWins ? "typed" : (a.capacityLeft === null ? "none" : "measured"),
        capacitySetAt: typedWins ? ov.capacitySetAt : null,
      };
    })(),

    // A PASSED RESET RESTORES THE CAPACITY, and the surface says 100 rather than
    // "unknown". The weekly refresh is the one thing here we can be certain of —
    // it is a schedule, not a measurement — so reporting nothing would hide the
    // very answer this tool exists to give. What is NOT certain is how much has
    // been spent since, so the source stays "presumed" and never claims to be a
    // reading. An operator who has used it since can type over the top.
    capacityLeft: a.readingSupersededByReset ? 100 : a.capacityLeft,
    capacitySource: a.readingSupersededByReset ? "presumed" : a.capacitySource,
    justReset: a.readingSupersededByReset || undefined,
    state: a.readingSupersededByReset ? "reset — full capacity, presumed"
         : a.capacityLeft === null ? "never measured"
         : a.capacityLeft <= 5 ? "nearly spent"
         : a.capacityLeft <= 25 ? "running low" : "has room",

    // THE QUESTION THIS TOOL EXISTS TO ANSWER: which account can I switch TO.
    // Not which is nearly spent — the provider already warns about that one,
    // loudly and in time. The unanswered question is which account quietly
    // refilled while nobody was looking.
    readyToSwitchTo: !a.onBox && (a.readingSupersededByReset || (a.capacityLeft ?? 0) >= 50),
  })).sort((x, y) => {
    // Most capacity FIRST. Sorting by nearest-to-empty puts the accounts you
    // cannot use at the top and buries the one you are actually looking for.
    if (x.readyToSwitchTo !== y.readyToSwitchTo) return x.readyToSwitchTo ? -1 : 1;
    const cap = (a) => a.readingSupersededByReset ? 100 : (a.capacityLeft ?? -1);
    return cap(y) - cap(x);
  }).concat(codexRows.sort((x, y) => (y.capacityLeft ?? -1) - (x.capacityLeft ?? -1)));

  return {
    generatedAt: new Date(now).toISOString(),
    boxes: boxRows,
    accounts: accountRows,
    // The instrument is honest about its own footprint: each sample spends a
    // real request against the very budget it reports.
    cost: { callsLastPoll: boxRows.length, note: "one API call per sampled box per poll" },
  };
}
