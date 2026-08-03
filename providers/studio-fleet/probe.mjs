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
const REMOTE_PROBE = String.raw`
TOK=$(cat "$HOME/.config/studio-box/secrets/claude-oauth-token" 2>/dev/null | tr -d '\n')
[ -z "$TOK" ] && { echo '{"ok":false,"reason":"no-token-file"}'; exit 0; }
H=$(curl -s -D - -o /dev/null --max-time 25 https://api.anthropic.com/v1/messages \
  -H "authorization: Bearer $TOK" -H "anthropic-beta: oauth-2025-04-20" \
  -H "anthropic-version: 2023-06-01" -H "content-type: application/json" \
  -d '{"model":"claude-haiku-4-5-20251001","max_tokens":1,"messages":[{"role":"user","content":"hi"}]}' 2>/dev/null)
g(){ printf '%s' "$H" | grep -i "^$1:" | tr -d '\r' | awk '{print $2}' | head -1; }
STATUS=$(printf '%s' "$H" | head -1 | awk '{print $2}')
printf '{"ok":true,"status":"%s","org":"%s","u5":"%s","u7":"%s","r5":"%s","r7":"%s"}\n' \
  "$STATUS" "$(g anthropic-organization-id)" \
  "$(g anthropic-ratelimit-unified-5h-utilization)" "$(g anthropic-ratelimit-unified-7d-utilization)" \
  "$(g anthropic-ratelimit-unified-5h-reset)" "$(g anthropic-ratelimit-unified-7d-reset)"
`;

// Number("") is 0, not NaN — so a MISSING header would parse as "0% used". On
// this dashboard that is the worst possible lie: an exhausted account whose
// headers did not come back would read as completely fresh, and the one thing
// this app exists to prevent is rotating a box INTO an account that is already
// spent. Absent must stay absent all the way to the screen.
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
    return {
      sampled: false,
      reason: d.status === "429" ? "at-or-over-limit" : `no-usage-headers (http ${d.status || "?"})`,
      org: d.org || null,
      httpStatus: d.status || null,
    };
  }
  return {
    sampled: true,
    org: d.org || null,
    httpStatus: d.status || null,
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
