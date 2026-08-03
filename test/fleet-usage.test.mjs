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

test("a failed sample falls back to the last good one and says so", () => {
  const samples = [
    { host: "box-b", sampled: true, org: "org-b", used7d: 97, resets7d: "2026-08-04T09:00:00Z", at: "2026-08-03T00:00:00Z" },
    { host: "box-b", sampled: false, org: "org-b", reason: "at-or-over-limit", at: "2026-08-03T01:00:00Z" },
  ];
  const v = buildView({ samples, boxes: ["box-b"] });
  const b = v.boxes[0];
  assert.equal(b.state, "stale-but-last-known", "staleness is information, not an error");
  assert.equal(b.used7d, 97, "the last good reading survives a failed probe");
  assert.equal(b.reason, "at-or-over-limit", "and it says why it could not be refreshed");
});

test("an unreachable box invents nothing", () => {
  const v = buildView({ samples: [{ host: "box-c", sampled: false, reason: "unreachable: ssh timeout", at: "2026-08-03T01:00:00Z" }], boxes: ["box-c"] });
  assert.equal(v.boxes[0].state, "unsampled");
  assert.equal(v.boxes[0].used7d, null, "an unreachable box must show no number at all");
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
