// The dashboard's one job is to be believable about numbers that decide whether
// someone rotates a box. These are the cases where being wrong is expensive.
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseProbe } from "../providers/studio-fleet/probe.mjs";
import { buildView, projectWeeklyReset, weeklySlot, updateAccountOverride } from "../providers/studio-fleet/fleet-state.mjs";
import fs from "node:fs";

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
  // THE LIVE 401 CASE. A failed probe often carries no org — the one measured live did not — and
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
  // MEASURED ON A REAL BOX, first live probe: the box's cached OAuth access token
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

test("the probe never drives a command into a seat's pane", () => {
  // FOUNDER RULING, 2026-08-03, from a real incident: `/status` inside a Claude seat
  // opens a panel that BLOCKS the agent until someone presses Esc. A monitor that
  // types it PARKS the seat it was measuring, and does so invisibly — a parked seat
  // still reports sessionStatus running, because the daemon observes the session and
  // not what the TUI is showing. A monitoring tool that can park its subject is worse
  // than no monitoring.
  //
  // A comment cannot hold this: the tempting version of "get codex usage" is to type
  // something into a seat and read the pane. So it is a test.
  // COMMENTS ARE STRIPPED FIRST, and that is not tidiness. The warning explaining
  // why /status must never be typed into a seat CONTAINS the string "/status", so a
  // raw scan flags the very documentation of the property it is checking — a verifier
  // that misfires on the description of its own rule is worse than none, because it
  // fails toward looking-like-a-finding. Inspect code, never prose.
  // TWO comment syntaxes, because this file embeds a shell script in a JS template
  // literal and BOTH kinds of prose tripped this check while it was being written —
  // first a // warning containing "/status", then a # warning containing "rig send".
  // Twice, in the one test whose whole point is that prose is not code.
  const strip = (t) => t
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "")
    .replace(/^\s*#.*$/gm, "");
  const src = ["probe.mjs", "fleet-state.mjs"]
    .map((f) => strip(fs.readFileSync(new URL(`../providers/studio-fleet/${f}`, import.meta.url), "utf8")))
    .join("\n");

  assert.match(src, /execFile\("ssh"/, "positive control: the probe source was not read");
  assert.ok(!/\/\/|\/\*/.test(src.split("\n").find((l) => l.includes("execFile")) ?? ""),
    "positive control: comment stripping left code intact");
  for (const forbidden of ["send-keys", "capture-pane", "tmux", "rig send", "/status"]) {
    assert.ok(!src.includes(forbidden),
      `${forbidden} addresses a live seat; sampling is per-HOST and must never touch a pane`);
  }
});

test("sampling is one reading per host, not one per seat", () => {
  // Same ruling, the other half. Every seat on a box authenticates from the same
  // token file, so a second seat cannot report a different account or utilisation —
  // fanning out buys nothing and spends the very budget this dashboard protects.
  // Pinned as behaviour: many samples for one host collapse to exactly one row.
  const samples = [
    { host: "box-a", sampled: true, org: "org-a", used7d: 10, at: "2026-08-03T00:00:00Z" },
    { host: "box-a", sampled: true, org: "org-a", used7d: 12, at: "2026-08-03T01:00:00Z" },
    { host: "box-a", sampled: true, org: "org-a", used7d: 14, at: "2026-08-03T02:00:00Z" },
  ];
  const v = buildView({ samples, boxes: ["box-a"] });
  assert.equal(v.boxes.length, 1, "a host is one row however many times it was sampled");
  assert.equal(v.boxes[0].used7d, 14, "and the newest good reading is the reading");
  assert.equal(v.cost.callsLastPoll, 1, "one host, one real API call — the cost the poll reports");
});

test("an idle machine reads as idle, not as a broken credential", () => {
  // A 401 has two very different causes. If the credential on disk says it has
  // already expired, nobody has used the machine since it lapsed — the next real
  // use refreshes it. That is the ordinary resting state of a machine you are not
  // working on, and calling it an auth failure sends someone to fix nothing.
  const r = parseProbe(JSON.stringify({
    ok: true, status: "401", src: "file:claude-credentials",
    meta: { expired: true, staleSeconds: 10800, expiresAt: 1785742933499,
            plan: "max", tier: "default_claude_max_20x", refreshable: true },
  }));
  assert.equal(r.sampled, false, "no usage number was read, and none may be invented");
  assert.equal(r.idle, true);
  assert.match(r.reason, /idle/);
  assert.doesNotMatch(r.reason, /auth-not-usable/, "an idle machine is not an auth failure");
  assert.equal(r.plan, "max", "the plan is on disk and costs no API call to report");
  assert.equal(r.tier, "default_claude_max_20x");
});

test("a 401 with a VALID credential is still a real auth failure", () => {
  // The positive control for the test above. Reporting every 401 as "idle" would
  // hide a genuinely rejected credential, which is the failure worth waking up for.
  const r = parseProbe(JSON.stringify({
    ok: true, status: "401", src: "file:claude-credentials",
    meta: { expired: false, staleSeconds: 0, plan: "max" },
  }));
  assert.equal(r.idle, undefined, "a live credential rejected by the server is not idleness");
  assert.equal(r.authFailed, true);
  assert.match(r.reason, /auth-not-usable/);
});

test("the codex account is read even when the claude credential has lapsed", () => {
  // Two providers live on one machine and they fail independently. A lapsed Claude
  // credential says nothing about the codex account beside it, so a machine that
  // cannot be sampled for usage can still answer the question that matters most
  // day to day: WHICH ACCOUNT IS THIS MACHINE ON.
  const r = parseProbe(JSON.stringify({
    ok: true, status: "401", src: "file:claude-credentials",
    meta: { expired: true, staleSeconds: 7200, plan: "max" },
    codex: { email: "someone@example.com", plan: "pro",
             accountId: "acct-1", until: "2026-08-25T15:57:45+00:00" },
  }));
  assert.equal(r.idle, true, "the claude side is still idle");
  assert.equal(r.codex.email, "someone@example.com", "and the codex account is still known");
  assert.equal(r.codex.plan, "pro");
});

test("a machine with no codex account reports none rather than an empty shape", () => {
  // Positive control: an empty object must not render as an account with a blank
  // email, which would read on the dashboard as a real account nobody can identify.
  const r = parseProbe(JSON.stringify({
    ok: true, status: "200", u5: "0.1", u7: "0.2", codex: {},
  }));
  assert.equal(r.sampled, true);
  assert.equal(r.codex, null, "absent must stay absent, here as everywhere");
});

test("a weekly reset observed once projects forward forever", () => {
  // THE THING THAT MAKES A PARKED ACCOUNT ANSWERABLE. Limits refresh weekly at
  // the same day and time, so one observed reset is a schedule, not a snapshot.
  // "When is it safe to switch back" is then arithmetic on a past fact, and needs
  // no live credential — which is the whole problem with sampling an idle account.
  const observed = "2026-08-05T03:00:00.000Z";              // a Wednesday
  const twoWeeksLater = Date.parse("2026-08-17T00:00:00Z");
  assert.equal(projectWeeklyReset(observed, twoWeeksLater), "2026-08-19T03:00:00.000Z");
  assert.equal(projectWeeklyReset(observed, Date.parse("2026-08-04T00:00:00Z")), observed,
    "a reset still in the future is already the answer");
  assert.equal(weeklySlot(observed), "Wednesdays 03:00 UTC", "the recurring slot is what a person plans around");
  assert.equal(projectWeeklyReset(null), null, "no observation, no projection — never a guess");
});

test("a reading the reset has overtaken is retired, not carried forward", () => {
  // An account measured at 97% BEFORE its reset is not 97% now. The limit
  // refreshed. But we did not measure the new value, so the honest report is
  // "presumed clear, unmeasured" — not 0%, and not a stale 97%.
  const samples = [{ host: "box-a", sampled: true, org: "acct-1", used7d: 97,
                     resets7d: "2026-08-04T03:00:00.000Z", at: "2026-08-03T00:00:00.000Z" }];
  const v = buildView({ samples, boxes: [], now: Date.parse("2026-08-06T00:00:00Z") });
  const a = v.accounts[0];
  assert.equal(a.readingSupersededByReset, true);
  // The weekly refresh is a SCHEDULE, not a measurement, so the capacity it
  // restores is knowable with certainty and is reported as 100. What is not
  // knowable is how much has been spent since, which is why the source says
  // presumed and never claims to be a reading.
  assert.equal(a.capacityLeft, 100, "a passed reset restores the capacity");
  assert.equal(a.capacitySource, "presumed", "and never presents itself as measured");
  assert.equal(a.justReset, true, "so the surface can highlight it");
  assert.match(a.state, /full capacity, presumed/);
  assert.equal(a.nextResetAt, "2026-08-11T03:00:00.000Z", "and the next refill is still known exactly");
});

test("capacity is reported as room LEFT, because that is the decision", () => {
  const samples = [{ host: "box-a", sampled: true, org: "acct-1", used7d: 97,
                     resets7d: "2026-08-09T03:00:00.000Z", at: "2026-08-03T00:00:00.000Z" }];
  const v = buildView({ samples, boxes: ["box-a"], now: Date.parse("2026-08-03T06:00:00Z") });
  const a = v.accounts[0];
  assert.equal(a.capacityLeft, 3, "97% used is 3% left — same fact, decision-shaped");
  assert.equal(a.state, "nearly spent");
  assert.equal(a.resetsWeeklyAt, "Sundays 03:00 UTC");
});

test("the account you can switch TO comes first, not the one running out", () => {
  // The provider warns you about the account you are ON, loudly and in time. The
  // question nobody answers is which account quietly refilled while you were not
  // looking — so the list leads with capacity, and a nearly-spent account sorts
  // last where it belongs.
  const samples = [
    { host: "box-a", sampled: true, org: "spent",  used7d: 96, at: "2026-08-03T00:00:00Z",
      resets7d: "2026-08-09T03:00:00.000Z" },
    { host: "box-b", sampled: true, org: "onbox",  used7d: 10, at: "2026-08-03T00:00:00Z",
      resets7d: "2026-08-09T03:00:00.000Z" },
    { host: "box-c", sampled: true, org: "parked", used7d: 4,  at: "2026-08-02T00:00:00Z",
      resets7d: "2026-08-09T03:00:00.000Z" },
  ];
  // box-c is gone from the fleet, so "parked" is attached to nothing.
  const v = buildView({ samples, boxes: ["box-a", "box-b"], now: Date.parse("2026-08-03T06:00:00Z") });

  assert.equal(v.accounts[0].account, "parked", "a free, unattached account leads the list");
  assert.equal(v.accounts[0].readyToSwitchTo, true);
  assert.equal(v.accounts.at(-1).account, "spent", "and the nearly-spent one sorts last");
  assert.equal(v.accounts.find((a) => a.account === "onbox").readyToSwitchTo, false,
    "an account already driving a machine is not a switch target");
});

test("an account keeps its host mapping even when its usage cannot be read", () => {
  // Half the value is the mapping alone. An account observed on a machine whose
  // credential could not be sampled is still known to be THERE, and that must not
  // fall out of the view just because no number came back with it.
  const samples = [
    { host: "box-a", sampled: true,  org: "acct-1", used7d: 20, at: "2026-08-01T00:00:00Z" },
    { host: "box-a", sampled: false, org: "acct-1", reason: "idle", at: "2026-08-03T09:00:00Z" },
  ];
  const v = buildView({ samples, boxes: ["box-a"], now: Date.parse("2026-08-03T10:00:00Z") });
  const a = v.accounts[0];
  assert.equal(a.lastSeenOnHost, "box-a", "the mapping survives an unreadable sample");
  assert.equal(a.lastSeenAt, "2026-08-03T09:00:00Z", "and it is the LATEST sighting, not the last good read");
});

test("identity survives a machine that could not be sampled", () => {
  // Plan and account are read off disk, so they do not depend on the usage call
  // succeeding. Tying them to the last GOOD sample blanks the account name on
  // exactly the machines that could not be sampled — which is when you most want
  // to know what they are running.
  const samples = [
    { host: "box-a", sampled: true, org: "acct-1", used7d: 20, at: "2026-08-01T00:00:00Z" },
    { host: "box-a", sampled: false, idle: true, reason: "idle", plan: "max",
      codex: { email: "someone@example.com", plan: "pro" }, at: "2026-08-03T09:00:00Z" },
  ];
  const b = buildView({ samples, boxes: ["box-a"], now: Date.parse("2026-08-03T10:00:00Z") }).boxes[0];
  assert.equal(b.plan, "max", "the plan came from the newest observation, not the last good one");
  assert.equal(b.codex.email, "someone@example.com");
  assert.equal(b.used7d, 20, "and the usage reading is still the last good one");
});

test("an account spread across machines says so, because the pool is shared", () => {
  // Capacity belongs to the ACCOUNT, not the machine. One account on three
  // machines drains three times as fast, and no per-machine view shows that —
  // you would have to hold the whole fleet in your head to notice. Splitting
  // accounts across machines is the entire reason for rotating them.
  const samples = [{ host: "box-a", sampled: true, org: "shared", used7d: 38, at: "2026-08-03T00:00:00Z" }];
  const v = buildView({
    samples, boxes: ["box-a", "box-b", "box-c"],
    overrides: { assignments: {
      "box-a": { claude: "shared" }, "box-b": { claude: "shared" }, "box-c": { claude: "shared" },
    } },
  });
  const a = v.accounts.find((x) => x.account === "shared");
  assert.equal(a.sharedBy, 3, "three machines are drawing on one pool");
  assert.deepEqual(a.machines, ["box-a", "box-b", "box-c"]);
  assert.equal(a.capacityLeft, 62, "and it is one capacity, not three");
});

test("the source column always says where the number came from", () => {
  // Regression: capacity, its source and the reset override were decided in two
  // places, and the later one silently overwrote the first with undefined — so the
  // source read blank on exactly the rows that had a real number in them. A number
  // whose provenance is missing is worse than no number, because it still invites
  // a decision.
  const measured = buildView({
    samples: [{ host: "b", sampled: true, org: "a1", used7d: 38, at: "2026-08-03T00:00:00Z" }],
    boxes: ["b"], now: Date.parse("2026-08-03T06:00:00Z"),
  }).accounts[0];
  assert.equal(measured.capacityLeft, 62);
  assert.equal(measured.capacitySource, "measured");

  const typed = buildView({
    samples: [{ host: "b", sampled: true, org: "a1", used7d: 38, at: "2026-08-03T00:00:00Z" }],
    boxes: ["b"], now: Date.parse("2026-08-03T06:00:00Z"),
    overrides: { accounts: { a1: { capacityLeft: 90, capacitySetAt: "2026-08-03T05:00:00Z" } } },
  }).accounts[0];
  assert.equal(typed.capacityLeft, 90, "a newer typed value wins");
  assert.equal(typed.capacitySource, "typed", "and says so");
});

test("an operator can add a parked codex account with its weekly reset", () => {
  const v = buildView({
    samples: [],
    boxes: ["build-vm"],
    now: Date.parse("2026-08-03T23:00:00Z"),
    overrides: {
      accounts: {
        "operator@fixture.invalid": {
          provider: "codex",
          label: "operator@fixture.invalid",
          capacityLeft: 100,
          capacitySetAt: "2026-08-03T23:00:00Z",
          resetsWeeklyAt: "2026-08-09T04:09:00Z",
        },
      },
    },
  });

  const account = v.accounts.find((a) => a.account === "operator@fixture.invalid");
  assert.ok(account, "an override-only codex account must appear before its first host sample");
  assert.equal(account.provider, "codex");
  assert.equal(account.capacityLeft, 100);
  assert.equal(account.resetsWeeklyAt, "Sundays 04:09 UTC");
  assert.equal(account.nextResetAt, "2026-08-09T04:09:00.000Z");
});

test("the account editor persists a provider and UTC weekly reset anchor", () => {
  const updated = updateAccountOverride({}, {
    provider: "codex",
    label: "operator@fixture.invalid",
    capacityLeft: 100,
    resetsWeeklyAt: "2026-08-09T04:09:00Z",
  }, "2026-08-03T23:00:00.000Z");

  assert.deepEqual(updated, {
    provider: "codex",
    label: "operator@fixture.invalid",
    capacityLeft: 100,
    capacitySetAt: "2026-08-03T23:00:00.000Z",
    resetsWeeklyAt: "2026-08-09T04:09:00.000Z",
  });
  assert.throws(() => updateAccountOverride({}, { resetsWeeklyAt: "next Sunday" }), /ISO timestamp/);
});

test("the provider manager exposes an editable codex reset field", () => {
  const html = fs.readFileSync(new URL("../apps/provider-manager/app/provider-manager.html", import.meta.url), "utf8");
  assert.match(html, /data-field="resetsWeeklyAt"/, "the reset column must be editable rather than display-only");
});

test("an override-only Claude account remains visible while parked", () => {
  const v = buildView({
    samples: [],
    boxes: ["build-vm"],
    labels: { "org-fixture": "operator@fixture.invalid" },
    overrides: {
      accounts: {
        "org-fixture": {
          provider: "claude",
          label: "operator@fixture.invalid",
          capacityLeft: 100,
          capacitySetAt: "2026-08-03T23:00:00.000Z",
          resetsWeeklyAt: "2026-08-10T23:12:00.000Z",
        },
      },
    },
    now: Date.parse("2026-08-04T00:00:00.000Z"),
  });

  const account = v.accounts.find((a) => a.account === "org-fixture");
  assert.ok(account, "a known Claude account must not disappear when no machine currently exposes it");
  assert.equal(account.provider, "claude");
  assert.equal(account.label, "operator@fixture.invalid");
  assert.equal(account.capacityLeft, 100);
  assert.deepEqual(account.machines, []);
  assert.equal(account.readyToSwitchTo, true);
});

test("machine display names do not replace operational host aliases", () => {
  const v = buildView({
    samples: [],
    boxes: ["vps-fixture-01"],
    boxLabels: { "vps-fixture-01": "Demo Box" },
  });

  assert.equal(v.boxes[0].host, "vps-fixture-01", "routing keeps the canonical operational alias");
  assert.equal(v.boxes[0].displayName, "Demo Box", "the human-facing inventory gets a stable name");
});

test("the provider manager renders a machine label and retains its host key", () => {
  const html = fs.readFileSync(new URL("../apps/provider-manager/app/provider-manager.html", import.meta.url), "utf8");
  assert.match(html, /b\.displayName/, "the visible machine name should come from the inventory label");
  assert.match(html, /machine-key/, "the operational alias should remain visible for debugging and routing");
});

test("machine account selectors cannot mix Claude and Codex accounts", () => {
  const html = fs.readFileSync(new URL("../apps/provider-manager/app/provider-manager.html", import.meta.url), "utf8");
  assert.match(html, /accounts\.filter\(a => a\.provider === provider\)/,
    "each selector must contain only accounts from the provider it changes");
  assert.match(html, /opts\(b\.claudeAccount, 'claude'\)/);
  assert.match(html, /opts\(b\.codexAccount, 'codex'\)/);
});
