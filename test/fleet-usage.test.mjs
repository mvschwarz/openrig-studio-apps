// The dashboard's one job is to be believable about numbers that decide whether
// someone rotates a box. These are the cases where being wrong is expensive.
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseProbe } from "../providers/studio-fleet/probe.mjs";
import { buildView } from "../providers/studio-fleet/fleet-state.mjs";

const probe = (o) => JSON.stringify({ ok: true, status: "200", org: "org-a", ...o });

test("a missing usage header never reads as zero percent used", () => {
  // Number("") is 0. If that reaches the screen, an EXHAUSTED account renders as
  // completely fresh — and this dashboard's whole purpose is stopping a rotation
  // INTO a spent account. Absent must stay absent.
  const r = parseProbe(probe({ status: "429", u5: "", u7: "", r5: "", r7: "" }));
  assert.equal(r.sampled, false, "an unreadable account must not be reported as sampled");
  assert.equal(r.used7d, undefined, "no usage number may be invented");
  assert.equal(r.reason, "at-or-over-limit");
});

test("a genuine zero percent still reads as zero", () => {
  // The positive control for the test above: a fix that rejects empty strings
  // must not also reject a real, freshly-reset account. Rejecting everything
  // would pass the test above and ship a dashboard that can never show a usable
  // account.
  const r = parseProbe(probe({ u5: "0", u7: "0", r5: "1785720000", r7: "1785900000" }));
  assert.equal(r.sampled, true);
  assert.equal(r.used7d, 0);
  assert.ok(r.resets7d, "a fresh account still reports its reset");
});

test("rate-limited responses that DO carry headers are read normally", () => {
  // Unverified in the field: whether a genuinely exhausted account returns its
  // headers on a 429. If it does, this is the path — and it must report 100,
  // not fall through to unsampled.
  const r = parseProbe(probe({ status: "429", u5: "1.0", u7: "1.0", r5: "1785720000", r7: "1785900000" }));
  assert.equal(r.sampled, true);
  assert.equal(r.used7d, 100);
});

test("the last good reading IS the reading, and a failed probe does not disturb it", () => {
  // Same property the old shape pinned, re-expressed: last-known is primary, not
  // a degraded substitute. A failed probe means the reading did not get younger.
  const samples = [
    { host: "box-b", sampled: true, org: "org-b", used7d: 97, resets7d: "2026-08-04T09:00:00Z", at: "2026-08-03T00:00:00Z" },
    { host: "box-b", sampled: false, org: "org-b", reason: "at-or-over-limit", at: "2026-08-03T01:00:00Z" },
  ];
  const b = buildView({ samples, boxes: ["box-b"] }).boxes[0];
  assert.equal(b.used7d, 97, "the reading survives a failed probe");
  assert.equal(b.readingFrom, "2026-08-03T00:00:00Z", "and carries the age of the reading, not of the attempt");
  assert.equal(b.hasReading, true);
  assert.equal(b.lastAttempt.ok, false, "the attempt is recorded separately");
  assert.equal(b.lastAttempt.reason, "at-or-over-limit", "and says why it could not be refreshed");
});

test("a box whose probe carried no account still keeps its own reading", () => {
  // THE LIVE 401 CASE. A failed probe often carries no org — matti's did — and
  // the earlier shape looked the last-good reading up BY ORG, so it lost the
  // box's own history exactly when it was needed and rendered every column as a
  // dash while a good reading sat in the store. Keyed on the box now.
  const samples = [
    { host: "box-d", sampled: true, org: "org-d", used5h: 4, used7d: 41, at: "2026-08-03T00:00:00Z" },
    { host: "box-d", sampled: false, reason: "auth-not-usable (http 401)", authFailed: true, at: "2026-08-03T01:00:00Z" },
  ];
  const b = buildView({ samples, boxes: ["box-d"] }).boxes[0];
  assert.equal(b.used7d, 41, "an org-less failure must not erase the box's reading");
  assert.equal(b.account, "org-d", "and the account is still known from the last good reading");
  assert.equal(b.lastAttempt.authFailed, true, "the stale credential is reported as its own fact");
});

test("a box that has never been read shows nothing rather than zero", () => {
  const v = buildView({ samples: [{ host: "box-c", sampled: false, reason: "unreachable: ssh timeout", at: "2026-08-03T01:00:00Z" }], boxes: ["box-c"] });
  const b = v.boxes[0];
  assert.equal(b.hasReading, false);
  assert.equal(b.used7d, null, "never read must show no number at all");
  assert.equal(b.readingFrom, null, "and no reading age to imply one exists");
  assert.equal(b.lastAttempt.ok, false);
});

test("a parked account still reports when it frees up", () => {
  // THE headline. An account attached to no box cannot be sampled by anyone, so
  // this answer has to come from the last good reading — which is why it works
  // without the controller ever holding that account's token.
  const samples = [
    { host: "box-a", sampled: true, org: "org-old", used7d: 99, resets7d: "2026-08-05T03:00:00Z", at: "2026-08-02T10:00:00Z" },
    { host: "box-a", sampled: true, org: "org-new", used7d: 2, resets7d: "2026-08-09T03:00:00Z", at: "2026-08-03T01:00:00Z" },
  ];
  const v = buildView({ samples, boxes: ["box-a"] });
  const parked = v.accounts.find((a) => a.account === "org-old");
  assert.equal(parked.onBox, null, "it is on no box any more");
  assert.equal(parked.availableAgainAt, "2026-08-05T03:00:00Z", "and we still know when it comes back");
  const live = v.accounts.find((a) => a.account === "org-new");
  assert.equal(live.availableAgainAt, null, "an account in use is not waiting to become available");
});

test("the instrument reports its own cost", () => {
  const v = buildView({ samples: [], boxes: ["a", "b", "c"] });
  assert.equal(v.cost.callsLastPoll, 3, "sampling spends the budget it measures; say so");
});

test("the remote script carries no shell brace-expansion", async () => {
  // NOT a style rule. The probe script lives inside a JS template literal, and
  // even String.raw interpolates a dollar-brace — so shell syntax like
  // $ {VAR:-default} (no space, spelled apart here on purpose) is consumed by
  // JavaScript before bash ever sees it. It does not misbehave at run time; the
  // MODULE fails to parse, which took the whole suite down when I introduced it.
  //
  // Committed rather than checked once, because a control that is not re-runnable
  // is a status line. Written with a constructed regex so this assertion cannot
  // trip over its own pattern the way the warning comment above it once did.
  const { _internals } = await import("../providers/studio-fleet/probe.mjs");
  const braceExpansion = new RegExp("\\$" + "\\{[^}]*\\}");
  assert.ok(_internals.REMOTE_PROBE.includes("$HOME"), "positive control: the script was not read");
  assert.doesNotMatch(_internals.REMOTE_PROBE, braceExpansion,
    "a dollar-brace here is eaten by the JS template literal before bash sees it");
});

test("a reading says which token source produced it", () => {
  // Boxes do not hold the token the same way — measured: the demo box uses a
  // studio-box secrets file, the box we actually ship has no secrets directory
  // at all and authenticates through the ordinary claude credentials file. A
  // reading you cannot attribute to a source cannot be compared across boxes.
  const r = parseProbe(probe({ src: "file:claude-credentials", u5: "0.12", u7: "0.4" }));
  assert.equal(r.sampled, true);
  assert.equal(r.tokenSource, "file:claude-credentials");
});

test("a box with no token anywhere degrades honestly and names what was tried", () => {
  // The failure that would have shipped: one hardcoded path, absent on the very
  // box this app exists for, reporting nothing forever. Degrading is correct —
  // degrading WITHOUT saying what was looked for is not actionable.
  const r = parseProbe(JSON.stringify({ ok: false, reason: "no-token-source (tried env, studio-box secrets, claude credentials)" }));
  assert.equal(r.sampled, false, "no token must never read as a sample");
  assert.match(r.reason, /tried/, "the refusal must name where it looked");
});

test("a rejected credential is not reported as a spent account", () => {
  // MEASURED ON A REAL BOX, first live probe: matti's cached OAuth access token
  // had expired minutes earlier (refresh token still valid, scopes correct), so
  // the probe got 401. If that renders like at-or-over-limit, the dashboard
  // argues for rotating AWAY from an account with full headroom — the same
  // class of expensive lie as a missing header reading as 0%, pointing the
  // other way.
  const r = parseProbe(JSON.stringify({ ok: true, status: "401", src: "file:claude-credentials" }));
  assert.equal(r.sampled, false);
  assert.equal(r.authFailed, true, "an auth failure must be branchable without parsing prose");
  assert.doesNotMatch(r.reason, /limit/, "must not read as an exhausted account");

  const spent = parseProbe(JSON.stringify({ ok: true, status: "429", u5: "", u7: "" }));
  assert.equal(spent.reason, "at-or-over-limit", "positive control: a real 429 still reads as spent");
  assert.equal(spent.authFailed, undefined, "a spent account is not an auth failure");
});
