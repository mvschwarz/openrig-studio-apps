#!/usr/bin/env node
// Sampling one box's provider-account usage.
//
// THE ARCHITECTURAL RULE THIS FILE EXISTS TO ENFORCE: PULL THE READING, NOT THE
// TOKEN. Usage can only be read by authenticating AS the account, so the naive
// central dashboard ends up holding one OAuth token per account — a monitoring
// feature with the blast radius of a credential store. Instead the controller
// reaches into each box and runs the probe THERE, against the token that box
// already holds. Numbers come back; the secret never moves.
//
// It also composes with the network shape rather than fighting it: boxes have
// one-way ACLs and cannot initiate back, so the controller must pull anyway.
//
// Consequence worth stating: NOTHING IN THIS PROVIDER EVER READS, STORES OR
// TRANSPORTS A TOKEN. If a future change needs one here, that is a design
// change and not an implementation detail.
import { execFile } from "node:child_process";

// The remote reads its own token and asks the provider what it has spent. One
// request, smallest possible model, one output token — this call SPENDS the very
// budget it measures, which is why the caller must never poll on a hidden timer.
// BOXES DO NOT ALL HOLD THE TOKEN THE SAME WAY, and assuming they did nearly
// shipped an app that was useless on the box it was built for.
//
// This originally read ONE path — the studio-box secrets file — learned from the
// demo box. Checked against the box we actually ship: that path does not exist
// there, there is no secrets directory at all, and auth lives in the ordinary
// `~/.claude/.credentials.json`. The probe would have returned "no-token-file"
// forever, honestly and uselessly.
//
// That is the under-declaration failure in this project's own architecture note:
// a thing written on one machine encodes that machine's layout. So try the known
// sources in order and REPORT WHICH ONE ANSWERED — a reading whose provenance is
// unknown cannot be compared across boxes that differ.
const REMOTE_PROBE = String.raw`
SRC=""
# NOTE: use bare $VAR here, never the brace form. This script lives inside a JS
# template literal, and even String.raw interpolates a dollar-brace — so a shell
# brace expansion is eaten by JavaScript before bash ever sees it. Same class as
# backticks inside a quoted rig send: one language consuming another's syntax.
# (Writing this warning WITH the brace form in it is what broke the file once.)
TOK="$CLAUDE_CODE_OAUTH_TOKEN"
[ -n "$TOK" ] && SRC="env:CLAUDE_CODE_OAUTH_TOKEN"
if [ -z "$TOK" ] && [ -f "$HOME/.config/studio-box/secrets/claude-oauth-token" ]; then
  TOK=$(tr -d '\n' < "$HOME/.config/studio-box/secrets/claude-oauth-token" 2>/dev/null)
  [ -n "$TOK" ] && SRC="file:studio-box-secrets"
fi
if [ -z "$TOK" ] && [ -f "$HOME/.claude/.credentials.json" ]; then
  if command -v python3 >/dev/null 2>&1; then
    TOK=$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1])).get("claudeAiOauth",{}).get("accessToken",""))' "$HOME/.claude/.credentials.json" 2>/dev/null)
    [ -n "$TOK" ] && SRC="file:claude-credentials"
    # The credential describes ITSELF on disk: when it expires, the plan, the tier.
    # Free to read, no API call, and it is the ONLY thing available on an idle box
    # whose access token has already lapsed — which is most boxes, most of the time.
    META=$(python3 -c 'import json,sys,time
d=json.load(open(sys.argv[1])).get("claudeAiOauth",{})
ea=d.get("expiresAt") or 0
print(json.dumps({"expiresAt":ea,"expired":bool(ea and ea/1000<time.time()),
 "staleSeconds":int(time.time()-ea/1000) if ea and ea/1000<time.time() else 0,
 "plan":d.get("subscriptionType"),"tier":d.get("rateLimitTier"),
 "refreshable":bool(d.get("refreshToken"))}))' "$HOME/.claude/.credentials.json" 2>/dev/null)
  else
    echo '{"ok":false,"reason":"credentials-file-present-but-no-python3-to-read-it"}'; exit 0
  fi
fi
[ -z "$TOK" ] && { echo '{"ok":false,"reason":"no-token-source (tried env, secrets file, credentials file)"}'; exit 0; }
H=$(curl -s -D - -o /dev/null --max-time 25 https://api.anthropic.com/v1/messages \
  -H "authorization: Bearer $TOK" -H "anthropic-beta: oauth-2025-04-20" \
  -H "anthropic-version: 2023-06-01" -H "content-type: application/json" \
  -d '{"model":"claude-haiku-4-5-20251001","max_tokens":1,"messages":[{"role":"user","content":"hi"}]}' 2>/dev/null)
g(){ printf '%s' "$H" | grep -i "^$1:" | tr -d '\r' | awk '{print $2}' | head -1; }
STATUS=$(printf '%s' "$H" | head -1 | awk '{print $2}')
[ -z "$META" ] && META='{}'
# CODEX, and it costs nothing. Claude hides the account behind an API call; codex
# writes an id_token whose JWT claims already name the account and its plan. Decode
# it HERE and send back only the claims — the token never travels, same rule.
CODEX='{}'
if [ -f "$HOME/.codex/auth.json" ] && command -v python3 >/dev/null 2>&1; then
  CODEX=$(python3 -c 'import json,sys,base64
try:
    t=json.load(open(sys.argv[1])).get("tokens",{}).get("id_token","")
    b=t.split(".")[1]; b+="="*(-len(b)%4)
    c=json.loads(base64.urlsafe_b64decode(b))
    a=c.get("https://api.openai.com/auth",{}) or {}
    print(json.dumps({"email":c.get("email"),"plan":a.get("chatgpt_plan_type"),
      "accountId":a.get("chatgpt_account_id"),"until":a.get("chatgpt_subscription_active_until")}))
except Exception: print("{}")' "$HOME/.codex/auth.json" 2>/dev/null)
  [ -z "$CODEX" ] && CODEX='{}'
fi
printf '{"ok":true,"status":"%s","src":"%s","meta":%s,"codex":%s,"org":"%s","u5":"%s","u7":"%s","r5":"%s","r7":"%s"}\n' \
  "$STATUS" "$SRC" "$META" "$CODEX" "$(g anthropic-organization-id)" \
  "$(g anthropic-ratelimit-unified-5h-utilization)" "$(g anthropic-ratelimit-unified-7d-utilization)" \
  "$(g anthropic-ratelimit-unified-5h-reset)" "$(g anthropic-ratelimit-unified-7d-reset)"
`;

// Number("") is 0, not NaN — so a MISSING header would parse as "0% used". On
// this dashboard that is the worst possible lie: an exhausted account whose
// headers did not come back would read as completely fresh, and the one thing
// this app exists to prevent is rotating a box INTO an account that is already
// spent. Absent must stay absent all the way to the screen.
// The two providers on a machine are independent: a lapsed Claude credential says
// nothing about the codex account sitting beside it, so this is read out separately
// and attached to every result shape.
const codexOf = (d) => {
  const c = d.codex || {};
  return c.email ? { email: c.email, plan: c.plan || null, accountId: c.accountId || null,
                     subscriptionUntil: c.until || null } : null;
};

const num = (v) => {
  if (v === null || v === undefined || String(v).trim() === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
const ts = (v) => {
  const n = num(v);
  return n !== null && n > 0 ? new Date(n * 1000).toISOString() : null;
};

// KNOWN-UNKNOWN, recorded here because this is where it bites. Near-limit is
// PROVEN to return the full header set — 99% was read this way on a live box.
// A genuinely EXHAUSTED account has never been probed. The expectation is that
// it returns 429 and that 429 still carries rate-limit headers, since telling a
// caller when to retry is what those headers are for — but that is unverified,
// and it is the case that matters most.
//
// So this does not depend on the answer. Any response we cannot parse usage from
// degrades to "unsampled" with a reason, and the caller falls back to the last
// good sample. Worst case the dashboard is slightly stale; it is never blind,
// and the reset time — the thing that is actually needed — survives either way.
export function parseProbe(raw) {
  let d;
  try { d = JSON.parse(String(raw).trim().split("\n").filter(Boolean).pop() || "{}"); }
  catch { return { sampled: false, reason: "probe-output-unparseable" }; }
  if (!d.ok) return { sampled: false, reason: d.reason || "probe-failed" };

  const u7 = num(d.u7), u5 = num(d.u5);
  if (u7 === null && u5 === null) {
    // COULD-NOT-AUTHENTICATE AND ACCOUNT-IS-SPENT ARE DIFFERENT FACTS, and
    // collapsing them is the failure this app exists to prevent in the other
    // direction. Measured on a real box: a cached OAuth access token expires on
    // the order of an hour, and the probe reads it from disk without refreshing,
    // so a perfectly healthy account 401s routinely. If that rendered the same
    // as at-or-over-limit, the reading would argue for rotating AWAY from an
    // account with full headroom.
    //
    // The probe deliberately does NOT refresh it: refreshing writes the box's
    // credential state, and this thing reads. The box's own agent refreshes on
    // next use, so the honest report is "stale here, not spent there".
    const auth = d.status === "401" || d.status === "403";
  // A 401 has TWO very different causes and the dashboard must not merge them.
  // If the credential on disk says it expired, this box is simply IDLE — nobody
  // has used it since the token lapsed, and the next real use refreshes it. That
  // is not a broken box and not a spent account; it is the ordinary resting state
  // of a machine you are not currently working on. Saying "auth failed" there
  // sends someone to fix something that is not wrong.
  const m = d.meta || {};
  const hours = (n) => n >= 3600 ? `${Math.round(n / 3600)}h` : `${Math.max(1, Math.round(n / 60))}m`;
  if (auth && m.expired) {
    return { sampled: false, reason: `idle — credential lapsed ${hours(m.staleSeconds)} ago; a real use refreshes it`,
      idle: true, credentialExpiredAt: m.expiresAt ? new Date(m.expiresAt).toISOString() : null,
      plan: m.plan || null, tier: m.tier || null, tokenSource: d.src || null,
      codex: codexOf(d), org: d.org || null, httpStatus: d.status || null };
  }
    return {
      sampled: false,
      reason: d.status === "429" ? "at-or-over-limit"
        : auth ? `auth-not-usable (http ${d.status}) — cached token stale or rejected; the box refreshes on next use`
        : `no-usage-headers (http ${d.status || "?"})`,
    codex: codexOf(d),
      // Named separately from the prose so a surface can branch on it without
      // parsing a sentence.
      authFailed: auth || undefined,
      org: d.org || null,
      httpStatus: d.status || null,
    };
  }
  return {
    sampled: true,
    org: d.org || null,
    httpStatus: d.status || null,
    // WHERE the token came from. Boxes differ, and a reading you cannot
    // attribute to a source cannot be compared against one from another box.
    tokenSource: d.src || null, plan: (d.meta||{}).plan || null, tier: (d.meta||{}).tier || null,
    codex: codexOf(d),
    used5h: u5 === null ? null : Math.round(u5 * 100),
    used7d: u7 === null ? null : Math.round(u7 * 100),
    resets5h: ts(d.r5),
    resets7d: ts(d.r7),
  };
}

// The controller reaches IN. `host` is an ssh target the operator already has —
// this deliberately does not manage credentials, hosts files or tunnels; if ssh
// to that name does not already work, that is a provisioning fact to report, not
// something for a dashboard to paper over.
//
// ── THE UNIT OF SAMPLING IS THE HOST, NOT THE SEAT. Founder ruling, 2026-08-03.
//
// Sample ONE reading per harness per host, and never fan out across the agents
// running on it. Every seat on a box authenticates from the same token file — its
// login shell cats the same secret — so a second seat cannot report a different
// account or a different utilisation. Polling five agents on one host buys nothing
// and spends five times the budget this dashboard exists to protect.
//
// This function honours that STRUCTURALLY rather than by discipline: it opens one
// ssh, runs one probe against the box's own credential, and never addresses a seat
// at all. Keep it that way.
//
// IF A FUTURE READING GENUINELY NEEDS A SEAT — and codex is the live candidate,
// because its usage figure goes stale and appears to need triggered activity before
// it refreshes — then the founder's rule says WHICH seat: an IDLE one. A review
// agent, or anything quiet for a long time. NEVER an orchestrator and never an
// implementer; those are the seats doing the work you are trying to protect.
//
// AND WHATEVER YOU DO, DO NOT DRIVE A COMMAND INTO A SEAT'S PANE. `/status` inside a
// Claude seat opens a panel that BLOCKS the agent until someone presses Esc, so a
// monitor that types it parks the very seat it was measuring — silently, because a
// parked seat still reports sessionStatus running: the daemon observes the session,
// not what the TUI is displaying. A monitoring tool that can park its subject is
// worse than no monitoring. A read-only-SOUNDING command can have a WRITE-like
// effect on a TUI; the test is whether the pane is left accepting input, not what
// the verb is called. (Distinct from `claude auth status --json`, which is a
// harmless subprocess and never touches a pane — do not conflate the two.)
export function probeBox(host, { timeoutMs = 45000 } = {}) {
  return new Promise((resolve) => {
    const started = Date.now();
    execFile("ssh",
      ["-o", "ConnectTimeout=10", "-o", "BatchMode=yes", host, "bash -s"],
      { timeout: timeoutMs, maxBuffer: 1 << 20, input: undefined },
      (err, stdout, stderr) => {
        const took = Date.now() - started;
        if (err && !String(stdout).trim()) {
          return resolve({
            host, sampled: false, tookMs: took,
            reason: `unreachable: ${String(stderr || err.message).trim().split("\n")[0]}`,
          });
        }
        resolve({ host, tookMs: took, ...parseProbe(stdout) });
      },
    ).stdin?.end(REMOTE_PROBE);
  });
}

export const _internals = { REMOTE_PROBE };
