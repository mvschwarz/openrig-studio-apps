// Terminal: what the page says in each state, what a read of the Studio's place means, and the agents view's tile rules. Pure, so
// the page and the tests share it. Copyright 2026 mvschwarz. Licensed under the Apache License, Version 2.0.
//
// What is set up comes from the Studio's own GET /api/studio/place, never from a probe, so "not set up" is never a guess:
// - `terminal`: the path of a shell as this machine's user, with that user's full rights (the Studio's own /terminal/, served from a
//   ttyd listener, tools/start-terminal.mjs in the SDK). Closing the page ends that shell; each visit starts a new one.
// - `agents`: { watch, type }, the paths of the team's agents' terminals, one per tile. A Studio serves them only behind a sign-in
//   (server hooks), so on a Studio reached only from this computer both are null and this page is the shell alone.
// - `team`: the team's shared terminal, opened when there is neither a terminal of your own nor the agents view.
//
// The agents view. Each agent's terminal is a tile, from the Studio's list at /api/agents/terminals. A tile watches (read only); Type
// is the person's click, and when that terminal is already open somewhere else the tile says so: Take over is a separate, explicit
// click. The page never sends anything to an agent itself. Closing the page closes only the views; the agents keep running. The tile
// set follows the list: a new terminal gets a tile, and one that left the list loses its tile unless it's pinned, typed in, or has the
// keyboard (for FOCUS_HOLD_S), in which case it stays, marked, saying why. Every change is said above the grid. A failed read of the
// list changes nothing (said above the grid); only a read list does. A typing tile never reconnects by itself: when its connection
// closes it goes back to Watch, saying why. The grid opens as many tiles as fit at a readable size, at most CEILING, and names the
// rest. A task view (#agents&view=qitem:<id>) shows the agents on one task, from OpenRig; a member without a view yet offers Add view
// (the person's click).

const esc = (v) =>
  String(v ?? "").replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c],
  );

export const LINE =
  "A full terminal on your machine, as your own user. What you run here runs for real.";
export const ENDS =
  "Closing this page ends this terminal and anything still running in it. To keep something running, start it in tmux or screen.";
export const SETUP = [
  'export STUDIO_TERMINAL_SOCKET="$HOME/.studio-terminals/shell.sock"',
  "node tools/start-terminal.mjs shell",
];
export const TEAM_LINE =
  "Your team's terminal, shared with anyone else who has it open. Typing here goes straight to your agents.";
export const TEAM_ENDS = "Closing this page leaves them running.";
export const AGENTS_LINE =
  "Your team's agents, live. What you type goes to the agent whose tile you're typing in.";
// A task view shows the agents on that task, who may include agents from another team.
export const TASK_LINE =
  "Agents on this task, live. What you type goes to the agent whose tile you're typing in.";
export const AGENTS_ENDS = "Closing this page closes only your view. The agents keep running.";
export const AGENTS_SIZE = "Opening a tile can change the size of an agent's terminal.";
export const HELP = "Contact the person who set up this machine using the channel you already use.";
export const FILES_ONLY = "Your access here is to files only, so Terminal isn't open to you.";
export const FILES_ONLY_HELP =
  "If you need a terminal, ask the person who set up this machine, using the channel you already use.";
export const REFUSED_HELP =
  "If this keeps happening, contact the person who set up this machine using the channel you already use.";

// How long the page waits for the place before saying it couldn't check, and how often it checks again while a view is open.
export const PLACE_MS = 8000;
export const CHECK_MS = 15000;
// The agents list costs the Studio a read of Herdr's list every time, so the page reads it slowly: on the CHECK_MS timer only while
// the page is visible, and on focus no sooner than LIST_MIN_MS after the last read. A terminal that changed reads it at once.
export const LIST_MIN_MS = 10000;
// How long Add view waits for OpenRig before saying it couldn't confirm.
export const ENSURE_MS = 20000;
// How long a tile that left the list stays while the person has the keyboard in it. Pinned and typed-in tiles stay without a limit.
export const FOCUS_HOLD_S = 12;
export const TILE_MODES = ["watch", "type", "takeover"];
export const MODES = ["shell", "agents"];
export const MODE_NAMES = { shell: "Your terminal", agents: "Agents" };

const plainPath = (p) =>
  typeof p === "string" &&
  p.length <= 200 &&
  /^(\/[A-Za-z0-9._~-]+)+\/?$/.test(p) &&
  !p.split("/").some((x) => x === "." || x === "..");

/** place.terminal when it is a plain path on this Studio ("/terminal/"), else null: never another host, a query or a climb. */
export const terminalOf = (place) => (plainPath(place?.terminal) ? place.terminal : null);

/** place.agents as { watch, type } when watch is a plain path on this Studio (type may be null: watch only), else null. */
export function agentsOf(place) {
  const a = place?.agents;
  if (!a || typeof a !== "object" || !plainPath(a.watch)) return null;
  return { watch: a.watch, type: plainPath(a.type) ? a.type : null };
}

/** The team's shared terminal, opened only when there is no terminal of your own and no agents view: a plain /team/ path, else null. */
export const teamOf = (place) =>
  !terminalOf(place) &&
  !agentsOf(place) &&
  plainPath(place?.team) &&
  /^\/team\//.test(place.team + "/")
    ? place.team
    : null;

/** place.account when it is an https address (the "Sign in again" link), else null. */
export const accountOf = (place) =>
  typeof place?.account === "string" && /^https:\/\/[^\s"'<>]+$/.test(place.account)
    ? place.account
    : null;

/** The SDK's own reason a terminal isn't available (place.terminals.terminal.reason), when it gives one. */
export const reasonOf = (place) =>
  typeof place?.terminals?.terminal?.reason === "string"
    ? place.terminals.terminal.reason.slice(0, 300)
    : null;

// The task the agents view shows, from the page's address (#agents&view=qitem:<id>), or null. Only a qitem view, of an id's shape.
const QITEM_VIEW = /^qitem:[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/;
export function viewOf(hash) {
  const h = String(hash || "")
    .replace(/^#/, "")
    .split("&");
  if (h[0] !== "agents") return null;
  const p = h.slice(1).find((x) => x.startsWith("view="));
  let v;
  try {
    v = p ? decodeURIComponent(p.slice(5)) : null;
  } catch {
    return null;
  }
  return v && QITEM_VIEW.test(v) ? v : null;
}
export const asksAgents = (hash) => /^#?agents(&|$)/.test(String(hash || ""));
// An embedded agents view (#agents&only=agents) never falls back to a shell.
export const agentsOnly = (hash) =>
  asksAgents(hash) && String(hash).replace(/^#/, "").split("&").includes("only=agents");

/** What the place offers this page: { shell, agents } (the shell is your terminal or, failing that, the team's). */
export const availOf = (place, hash = "") => ({
  shell: !agentsOnly(hash) && (!!terminalOf(place) || !!teamOf(place)),
  agents: !!agentsOf(place),
});

/**
 * A read of the place -> "open" | "notset" | "unread" | "refused". r = { status, body, signInEnded?, set? }: set is whether the mode
 * the page opens is in the place (when absent, whether a terminal is). A 401, or a 403 a sign-in front end marks with its
 * x-openrig-front-door header, is the sign-in refused; any other answer that isn't 200 is unread, never "off".
 */
export function stateOf(r) {
  if (r?.signInEnded) return "refused";
  if (r?.status !== 200) return "unread";
  const set = r.set ?? !!(terminalOf(r.body) || teamOf(r.body));
  return set ? "open" : "notset";
}

/** Which mode opens: the one asked for (#agents, else the shell) when it's set up, else the other one that is. avail = { shell, agents }. */
export function modeFor(asked, avail) {
  const want = asked === "agents" ? "agents" : "shell",
    other = want === "agents" ? "shell" : "agents";
  return avail?.[want] ? want : avail?.[other] ? other : want;
}

const button = (act, label, cls = "or-btn btn primary", extra = "") =>
  `<button type="button" class="${cls}" data-act="${act}"${extra}>${esc(label)}</button>`;
const chip = (act, label, on, extra = "") =>
  button(act, label, `or-btn small chip${on ? " on" : ""}`, ` aria-pressed="${on}"${extra}`);
// The switch between the two, only when both are set up.
const switchHtml = (mode, both) =>
  !both
    ? ""
    : `<p class="modes" role="group" aria-label="Show">${MODES.map((m) => chip("mode", MODE_NAMES[m], m === mode, ` data-mode="${m}"`)).join("")}</p>`;

/** The words, and the one action, for each state, for the shell (mode "shell") or the agents view (mode "agents"). */
export function stateHtml(
  state,
  {
    reason = null,
    account = null,
    mode = "shell",
    both = false,
    inTask = false,
    team = false,
    local = false,
    filesOnly = false,
  } = {},
) {
  const A = mode === "agents";
  const box = (cls, lead, rest = "") =>
    `<section class="next${cls ? ` ${cls}` : ""}" id="tstate" data-state="${state}" data-mode="${A ? "agents" : "shell"}"><p class="lead">${esc(lead)}</p>${rest}</section>`;
  switch (state) {
    case "checking":
      return `<p class="cover" id="tstate" data-state="checking">${A ? "Checking your agents' view…" : "Checking your terminal…"}</p>`;
    case "notset":
      // A files-only guest (the place's workspace is "files") gets no terminals by design: it IS set up, just not for them, so they're
      // told that, not "isn't set up yet".
      if (filesOnly)
        return box(
          "",
          FILES_ONLY,
          `<p class="meta">${esc(FILES_ONLY_HELP)}</p>` +
            button("retry", "Check again", "or-btn btn"),
        );
      if (A)
        return box(
          "",
          "The agents view isn't set up yet.",
          `<p class="meta">When it is, your team's agents open here, side by side.</p>` +
            button("retry", "Check again", "or-btn btn"),
        );
      // Only a local Studio (the place says profile "local") is one the person set up themselves, so only there does the card show
      // how to start the listener. Anywhere else the person can't run that, and is told who can.
      if (!local)
        return box(
          "",
          "Terminal isn't set up yet.",
          `<p class="meta">When it is, a terminal on your machine opens here. ${esc(HELP)}</p>` +
            button("retry", "Check again", "or-btn btn"),
        );
      return box(
        "",
        "Terminal isn't set up yet.",
        `<p class="meta">${esc(reason || "Nothing is serving this Studio's /terminal/ yet.")}</p>` +
          `<p class="meta">To run the listener yourself instead (it needs <code>ttyd</code>), run these from the Studio SDK's folder, then start the Studio from a shell with the same variable set:</p>` +
          `<pre>${esc(SETUP.join("\n"))}</pre>` +
          button("retry", "Check again", "or-btn btn"),
      );
    case "refused": {
      const again = account
        ? `<a class="or-btn btn primary" href="${esc(account)}" target="_top" rel="noopener">Sign in again</a>`
        : button("signin", "Sign in again");
      const help = `<p class="meta">${esc(REFUSED_HELP)}</p>`;
      return A
        ? box(
            "warn",
            "Studio didn't accept your sign-in, so your agents' view was closed.",
            `<p class="meta">Sign in again to open it. Your agents kept running.</p>${again}${help}`,
          )
        : box(
            "warn",
            "Studio didn't accept your sign-in, so your terminal was closed.",
            `<p class="meta">Sign in again to open a new one.</p>${again}${help}`,
          );
    }
    case "hidden":
      // Hidden by this deployment's own control (window.studioTerminal.setHidden): every view stays connected, only not shown.
      return box(
        "",
        A ? "Your agents' view is hidden for now." : "Your terminal is hidden for now.",
        `<p class="meta">${A ? "Your agents keep running. Their tiles come back when you show it again." : "It's still connected, and comes back as it was when you show it again."}</p>`,
      );
    case "open":
      // The team terminal is shared and outlives this page, unlike a terminal of your own.
      if (team && !A)
        return `<div id="tstate" data-state="open" data-mode="shell" data-view="team"><p class="say-line">${esc(TEAM_LINE)}</p><p class="meta">${esc(TEAM_ENDS)}</p></div>`;
      return `<div id="tstate" data-state="open" data-mode="${A ? "agents" : "shell"}">${switchHtml(A ? "agents" : "shell", both)}<p class="say-line">${esc(A ? (inTask ? TASK_LINE : AGENTS_LINE) : LINE)}</p><p class="meta">${esc(A ? `${AGENTS_ENDS} ${AGENTS_SIZE}` : ENDS)}</p></div>`;
    default:
      return box(
        "warn",
        A
          ? "Couldn't check whether your agents' view is set up."
          : "Couldn't check whether your terminal is set up.",
        `<p class="meta">This doesn't mean it's off: the check didn't answer. Try again in a moment.</p>${button("retry", "Try again")}`,
      );
  }
}

// ---- the agents view ----

const TERMINAL_ID = /^term_[0-9a-f]{1,64}$/;
const SESSION = /^[A-Za-z0-9._-]+@[A-Za-z0-9._-]+$/;
export const VIEW_KINDS = ["following", "fixed"];
const viewKind = (v) =>
  v && VIEW_KINDS.includes(v.kind) && typeof v.name === "string" && v.name
    ? { kind: v.kind, name: v.name }
    : null;

/**
 * The Studio's list of agent terminals (GET /api/agents/terminals): read = 200 with a terminals array (an empty one means none);
 * anything else is unreadable, never "none". An entry with a terminal id is a tile; a member named with no terminal yet is kept as a
 * tile that says so, never hidden; an entry whose id isn't a terminal id is dropped. A task view's answer (task + members) is read by
 * taskOf. key: the tile's identity (the terminal id, or seat:<seat> while it has none). name: the agent's session (seat@rig) when
 * given, else its seat.
 */
export function terminalsOf(r) {
  if (r?.status === 503 && r.body?.code === "task_views_unsupported")
    return { read: false, terminals: [], unsupported: true };
  // The Studio's own answer for a task this workspace doesn't know (a typo, or a task that's gone): said, never "just now".
  if (r?.status === 404 && r.body?.code === "view_not_found")
    return { read: false, terminals: [], notFound: true };
  if (
    r?.status === 200 &&
    r.body?.task &&
    typeof r.body.task === "object" &&
    Array.isArray(r.body.members)
  )
    return taskOf(r.body);
  if (r?.status !== 200 || !Array.isArray(r.body?.terminals)) return { read: false, terminals: [] };
  const out = [];
  for (const t of r.body.terminals) {
    if (!t || typeof t !== "object") continue;
    const seat = typeof t.seat === "string" && t.seat ? t.seat : null,
      name = typeof t.session === "string" && SESSION.test(t.session) ? t.session : seat;
    if (t.terminal_id == null || t.status === "not-provisioned") {
      if (seat)
        out.push({
          id: null,
          key: `seat:${seat}`,
          seat,
          name,
          state: t.state ?? null,
          unavailable: true,
        });
      continue;
    }
    if (!TERMINAL_ID.test(String(t.terminal_id))) continue;
    const id = String(t.terminal_id);
    out.push({ id, key: id, seat: seat ?? id, name: name ?? id, state: t.state ?? null });
  }
  // A name two terminals share is left out by the Studio (it can't tell them apart) and named in ambiguous: shown as a tile with
  // no frame, never silently missing.
  const names = Array.isArray(r.body.ambiguous) ? r.body.ambiguous : [];
  for (const n of names)
    if (typeof n === "string" && n && !out.some((x) => x.seat === n))
      out.push({
        id: null,
        key: `ambiguous:${n}`,
        seat: n,
        name: n,
        state: null,
        unavailable: true,
        ambiguous: true,
      });
  // What kind of view this list is, when the Studio says: one that follows the work or a saved layout. Absent, no claim.
  const view = viewKind(r.body.viewDescriptor);
  return view ? { read: true, terminals: out, view } : { read: true, terminals: out };
}

// A task view's list: OpenRig's members of that task. A member's terminal is a tile only when OpenRig has VERIFIED it (terminal_id,
// with readOnly when it says so); otherwise the member is a tile with no frame saying why. The member's key (hostId, nodeId) is what
// Add view sends, and the plan is the preview it came from (OpenRig refuses Add view against a changed task).
const AVAIL = ["available", "missing", "stopped", "hosted", "unresolved"],
  VSTATUS = ["not-provisioned", "verified", "unconfirmed"];
const unreadMember = (m) => !m || typeof m !== "object" || typeof m.seat !== "string" || !m.seat;
export const MEMBERS_UNREAD = "some of its agents couldn't be read";
function taskOf(b) {
  const out = [],
    seen = new Set(),
    bad = b.members.some(unreadMember),
    complete = b.task.complete === true && !bad,
    canEnsure = b.ensure === true && complete;
  for (const m of b.members) {
    if (unreadMember(m)) continue;
    const name = typeof m.session === "string" && SESSION.test(m.session) ? m.session : m.seat;
    const key =
      m.key &&
      typeof m.key.hostId === "string" &&
      m.key.hostId &&
      typeof m.key.nodeId === "string" &&
      m.key.nodeId
        ? { hostId: m.key.hostId, nodeId: m.key.nodeId }
        : null;
    const availability = AVAIL.includes(m.availability) ? m.availability : "unresolved",
      viewer = VSTATUS.includes(m.viewerStatus) ? m.viewerStatus : "unconfirmed";
    if (
      availability === "available" &&
      viewer === "verified" &&
      TERMINAL_ID.test(String(m.terminal_id))
    ) {
      const id = String(m.terminal_id);
      if (seen.has(id)) continue;
      seen.add(id);
      out.push({
        id,
        key: id,
        seat: m.seat,
        name,
        state: m.state ?? null,
        readOnly: m.readOnly === true,
        member: key,
      });
      continue;
    }
    const why =
      availability !== "available" ? availability : viewer === "verified" ? "unconfirmed" : viewer;
    out.push({
      id: null,
      key: `seat:${m.seat}`,
      seat: m.seat,
      name,
      state: m.state ?? null,
      unavailable: true,
      why,
      member: key,
      ensure: canEnsure && !!key && availability === "available" && why !== "unresolved",
      // One OpenRig would add a view for once the task is read in full: said, with no button.
      held:
        !canEnsure &&
        b.ensure === true &&
        !complete &&
        !!key &&
        availability === "available" &&
        why !== "unresolved",
    });
  }
  const view = viewKind(b.viewDescriptor);
  const issues = [
    ...(Array.isArray(b.task.issues)
      ? b.task.issues.filter((x) => typeof x === "string" && x).map(String)
      : []),
    ...(bad ? [MEMBERS_UNREAD] : []),
  ];
  return {
    read: true,
    terminals: out,
    ...(view ? { view } : {}),
    task: { name: typeof b.task.name === "string" ? b.task.name : "", complete, issues },
    plan: typeof b.plan === "string" && b.plan ? b.plan : null,
    ensure: b.ensure === true,
  };
}
// What a member with no terminal here says: why, in plain words.
export const MEMBER_WORDS = {
  "not-provisioned": "Not available in the terminal view yet.",
  unconfirmed: "OpenRig couldn't confirm this agent's view yet.",
  stopped: "Not running.",
  missing: "Not running in a terminal.",
  hosted: "Works outside a terminal, so there's nothing to show here.",
  unresolved: "On another machine, or not found here.",
};
export const TASK_VIEWS_UNSUPPORTED =
  "Task views aren't available on this machine yet. All your agents are in the agents view.";
export const TASK_NOT_FOUND =
  "This task isn't known to this workspace, so there are no agents to show for it.";
export const TASK_INCOMPLETE =
  "Some agents on this task may be missing from this list, because the whole task couldn't be read.";
export const ADD_VIEW_HELD = "You can add a view once the full list can be read.";
export const WATCH_ONLY = "You can't type here.";
export const READ_ONLY_BACK = "This view is now watch only, so this tile is back to watching.";

// A task member with no viewer of its own yet can still be watched through the Studio's ordinary list, which usually has that
// agent's terminal: it opens by the ordinary route (fromBox), because a task route only accepts OpenRig's verified viewer.
export function withBoxTerminals(res, box) {
  if (!res?.read || !res.task || !box?.read) return res;
  const byName = new Map(box.terminals.filter((t) => t.id).map((t) => [t.name, t])),
    used = new Set(res.terminals.filter((t) => t.id).map((t) => t.id));
  return {
    ...res,
    terminals: res.terminals.map((t) => {
      if (t.id || !VSTATUS.includes(t.why)) return t;
      const b = byName.get(t.name);
      if (!b || used.has(b.id)) return t;
      used.add(b.id);
      return {
        id: b.id,
        key: b.id,
        seat: t.seat,
        name: t.name,
        state: b.state ?? t.state,
        readOnly: false,
        member: t.member,
        fromBox: true,
      };
    }),
  };
}
/** Add view's answer -> what the tile says, and next: "list" (read the task again) or "stay". */
export function ensureResult(r) {
  if (r?.status === 200 && r.body?.ok === true)
    return { note: r.body.created ? "View added." : "View found.", next: "list" };
  const code = r?.body?.code;
  if (r?.status === 409 || code === "preview_changed")
    return { note: "This task changed. Try again.", next: "list" };
  if (code === "viewer_unconfirmed")
    return { note: "OpenRig couldn't confirm this agent's view.", next: "list" };
  if (code === "viewer_unavailable")
    return { note: "This agent has no terminal to show here right now.", next: "list" };
  if (code === "viewer_not_provisioned")
    return { note: "The view wasn't added. Try again.", next: "list" };
  if (
    code === "viewer_unsupported" ||
    code === "view_not_found" ||
    code === "view_required" ||
    r?.status === 404
  )
    return { note: "This machine's OpenRig can't add a view here yet.", next: "stay" };
  if (r?.status === 403 || r?.status === 401)
    return { note: "Add view was refused. Sign in again if your sign-in ended.", next: "stay" };
  // No answer, or one that isn't readable: whether the view was added isn't known, so the task is read again.
  return { note: "Couldn't confirm whether the view was added. Checking again.", next: "list" };
}

/**
 * A tile's frame: the Studio's watch or type path with the terminal id (and, for type, the mode) as arguments; null for anything not
 * allowed. In a task view the task goes first. The other two are ttyd's own page options: no "leave this page?" prompt when a tile
 * switches mode, and no reconnect by itself (the page decides what a closed tile does).
 */
export function tileUrl(paths, id, mode = "watch", view = null) {
  if (
    !paths ||
    !TERMINAL_ID.test(String(id)) ||
    !TILE_MODES.includes(mode) ||
    (view != null && !QITEM_VIEW.test(view))
  )
    return null;
  const v = view ? `arg=${encodeURIComponent(view)}&` : "";
  if (mode === "watch")
    return `${paths.watch}?${v}arg=${encodeURIComponent(id)}&disableReconnect=true&disableLeaveAlert=true`;
  return paths.type
    ? `${paths.type}?${v}arg=${encodeURIComponent(id)}&arg=${mode}&disableReconnect=true&disableLeaveAlert=true`
    : null;
}
// What ttyd's page shows over a terminal whose connection closed: the page sees it and decides what the tile does.
export const CLOSE_WORDS = ["Connection Closed", "Press ⏎ to Reconnect", "Reconnecting..."];
/** Why a tile's connection closed, from the last lines it showed: "inuse" | "takenover" | "changed" | "ended" | null. */
export function closeReasonOf(lines) {
  const s = (lines || []).map(String).join("\n");
  if (/in use elsewhere|already has an attached client/i.test(s)) return "inuse";
  if (/taken over/i.test(s)) return "takenover";
  if (/isn't open in this workspace now|not found|this terminal changed/i.test(s)) return "changed";
  if (/terminal\.closed|terminal ended|has ended/i.test(s)) return "ended";
  return null;
}

// How many tiles open at once: as many as fit at a readable size (about 80 by 24 of an agent's terminal), never more than CEILING.
// null when the grid has no size (hidden).
export const TILE_W = 600,
  TILE_H = 380,
  GAP = 8,
  CEILING = 8;
export function capFor(w, h) {
  if (!(w > 0 && h > 0)) return null;
  const across = Math.max(1, Math.floor((w + GAP) / (TILE_W + GAP))),
    down = Math.max(1, Math.floor((h + GAP) / (TILE_H + GAP)));
  return Math.min(CEILING, across * down);
}
/** The line above the grid: the read warning, the view's kind, the latest change, and "+N more" with the button it controls. */
export function barHtml({
  view = null,
  notes = [],
  hidden = [],
  override = false,
  unread = false,
  shown = 0,
  task = null,
} = {}) {
  const row = (cls, inner) => `<span class="bar-line ${cls}">${inner}</span>`,
    rows = [];
  if (unread) rows.push(row("warn", esc(TERMINALS_STALE)));
  if (task && !task.complete)
    rows.push(
      `<span class="bar-line warn" data-issues="${esc((task.issues || []).join(" | "))}">${esc(TASK_INCOMPLETE)}</span>`,
    );
  if (view)
    rows.push(
      row(
        "view",
        esc(
          view.kind === "following"
            ? `Following “${view.name}”: agents join and leave this view as the work changes.`
            : `Saved layout “${view.name}”: the same agents until someone changes it.`,
        ),
      ),
    );
  if (notes.length) rows.push(row("notes", notes.map(esc).join(" ")));
  const more = hidden.length
    ? `<span>+${hidden.length} more: ${hidden.map(esc).join(", ")}.${override ? ` At most ${CEILING} at once.` : ""}</span>`
    : "";
  if (hidden.length)
    rows.push(
      row(
        "more",
        more +
          (override
            ? button("fewer", "Show fewer", "or-btn small chip")
            : button("more", "Show them", "or-btn small chip")),
      ),
    );
  else if (override)
    rows.push(
      row(
        "more",
        `<span>Showing all ${shown}.</span>${button("fewer", "Show fewer", "or-btn small chip")}`,
      ),
    );
  return rows.join("");
}
export const joinedNote = (seat) => `${seat} joined.`;
export const leftNote = (seat, inTask = false) =>
  `${seat} left this ${inTask ? "task" : "list"}, so its tile was closed. The agent keeps running.`;
const STATE_WORDS = {
  working: "working",
  idle: "idle",
  blocked: "waiting",
  stalled: "stuck",
  down: "not running",
};
export const stateWord = (s) => STATE_WORDS[s] || "state not known";
/**
 * A tile's head: the agent, its state, what the tile does now, and the person's buttons (Watch / Type / Take over, Pin). The state is
 * shown only when it's known; the Studio's own list normally gives one, so a missing one is said (a task view's members come with
 * none). kept: why a tile that left the list is still here ("pinned", "typing", "using"); note: a one-off line in place of what the
 * tile does.
 */
export function tileHeadHtml(
  t,
  {
    mode = "watch",
    pinned = false,
    gone = false,
    kept = null,
    note = null,
    canType = false,
    inTask = false,
    adding = false,
    stateExpected = !inTask,
  } = {},
) {
  const key = t.key ?? t.id;
  const st = STATE_WORDS[t.state]
    ? ` <span class="st">${esc(STATE_WORDS[t.state])}</span>`
    : stateExpected
      ? ` <span class="st warn">${esc(stateWord(null))}</span>`
      : "";
  const b = (act, label, on = false) => chip(act, label, on, ` data-id="${esc(key)}"`);
  const left = gone
    ? ` <span class="st warn">no longer in this ${inTask ? "task" : "list"}${KEPT[kept] ? `. ${esc(KEPT[kept])}` : ""}</span>`
    : "";
  const nm = esc(t.name ?? t.seat);
  if (t.unavailable)
    return (
      `<div class="tile-head" data-id="${esc(key)}"><span class="nm">${nm}</span>${st}` +
      `${left} <span class="meta">${esc(note || (t.ambiguous ? AMBIGUOUS : MEMBER_WORDS[t.why] || NOT_PROVISIONED))}${t.held && !gone ? ` ${esc(ADD_VIEW_HELD)}` : ""}</span>` +
      `<span class="acts">${t.ensure && !gone ? (adding ? `<button type="button" class="or-btn small chip" disabled>Adding view…</button>` : b("ensure", "Add view")) : ""}${b("pin", pinned ? "Pinned" : "Pin", pinned)}</span></div>`
    );
  const doing =
    note ||
    (t.changed
      ? CHANGED
      : mode === "watch"
        ? t.readOnly
          ? `You're watching. ${WATCH_ONLY}`
          : "You're watching"
        : mode === "takeover"
          ? "You took over"
          : "You're typing");
  return (
    `<div class="tile-head" data-id="${esc(t.id)}"><span class="nm">${nm}</span>${st}` +
    `${left} <span class="meta">${esc(doing)}</span>` +
    `<span class="acts">${b("watch", "Watch", mode === "watch")}${canType && !gone && !t.readOnly ? b("type", "Type", mode === "type") + b("takeover", "Take over", mode === "takeover") : ""}${b("pin", pinned ? "Pinned" : "Pin", pinned)}</span></div>`
  );
}
/** The empty or unread grid; its optional link is this Studio's own team route, never another origin or a guessed address. */
export function gridStateHtml(state, { team = null } = {}) {
  const path = plainPath(team) && /^\/team\//.test(team + "/") ? team : null;
  const words = state === "unread" ? TERMINALS_UNREAD : TERMINALS_NONE;
  return `<p class="terminal-empty" role="status"><strong>${esc(words)}</strong>${path ? `<a class="or-btn btn" href="${esc(path)}" target="_blank" rel="noopener">All terminals <or-icon name="external"></or-icon></a>` : ""}</p>`;
}
export const TERMINALS_UNREAD = "Couldn't read the agents' terminals just now.";
export const TERMINALS_NONE = "No agent terminals to show here yet";
export const TERMINALS_STALE =
  "Couldn't reach your agents just now, so these may be out of date. Trying again.";
export const NOT_PROVISIONED = "Not available in the terminal view yet.";
export const CHANGED = "This agent's terminal restarted; reloading.";
export const AMBIGUOUS =
  "Two terminals have this name, so neither is shown. Ask your team to tell them apart.";
export const KEPT = {
  pinned: "Kept because you pinned it.",
  typing: "Kept while you're typing in it.",
  using: `Kept for ${FOCUS_HOLD_S} seconds while you're using it.`,
};
export const CLOSED_BACK = "The connection closed, so this tile is back to watching.";
export const IN_USE_BACK =
  "In use elsewhere, so this tile is back to watching. Take over to type here.";
export const TAKEN_BACK =
  "Taken over in another window, so this tile is back to watching. Take over to type here again.";
export const ENDED = "This agent's terminal ended.";
export const CLOSED_WATCH = "The connection closed. Watch to try again.";
/** A tile's connection closed: what it says, and what it does next ("watch", "list" or "stay"). */
export function afterClose(reason, mode) {
  if (reason === "changed") return { note: CHANGED, next: "list" };
  if (reason === "ended") return { note: ENDED, next: "stay" };
  if (mode === "watch") return { note: CLOSED_WATCH, next: "stay" };
  return {
    note: reason === "inuse" ? IN_USE_BACK : reason === "takenover" ? TAKEN_BACK : CLOSED_BACK,
    next: "watch",
  };
}

// A Watch tile shorter than the agent's own terminal sits at the bottom of the agent's screen, so an agent with little on screen looks
// empty. When every row at the bottom is blank and there's text above, show the text; when the bottom has text again, follow it again,
// unless the person scrolled since.
export function keepTextInView(term, st = {}) {
  const b = term?.buffer?.active;
  if (!b || !term.rows) return st;
  const has = (r) => !!(b.getLine(r)?.translateToString(true) || "").trim();
  let bottom = false;
  for (let r = b.baseY; r < b.baseY + term.rows; r++)
    if (has(r)) {
      bottom = true;
      break;
    }
  if (bottom) {
    if (st.moved) {
      if (b.viewportY === st.at) term.scrollToBottom();
      st.moved = false;
    }
    return st;
  }
  if (b.viewportY !== b.baseY) return st;
  for (let r = b.baseY - 1; r >= 0; r--)
    if (has(r)) {
      term.scrollToLine(Math.max(0, r - term.rows + 1));
      st.moved = true;
      st.at = b.viewportY;
      break;
    }
  return st;
}
