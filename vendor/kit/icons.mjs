// OpenRig UI kit: THE icon registry. Every icon on every page comes from here by name, so swapping the whole set means replacing this one
// file (and kit/icons/). A standardized icon set, implemented in a standard, repeatable way. No Unicode glyphs,
// PNGs, letters or one-off inline SVGs in page code.
//
// Three ways to place one, all from this registry: the <or-icon name="more"> element (kit/or-icon.mjs), icon() for HTML built as a
// string (server pages), and the same ICON_SVG + iconBody() for a framework that builds the <svg> itself (the Cloud app's React Icon).
//
// Source: Lucide (lucide-static 1.77.0, ISC; the Feather-derived icons MIT; kit/icons/LICENSE). Each body below is the path data of the
// file named beside it in kit/icons/, unchanged; the kit's sha test checks they still match. Drawn to the design system's ink and stroke:
// currentColor (the ink, or whatever colour the words around it have) at the --or-icon-stroke token (1.75; the attribute below is the
// same value, for a page without the tokens), on Lucide's 24 grid.
//
// Names say what the icon is FOR, not what it looks like, so a new set can redraw "more" without a page changing.
// An app's own rail icon is app-<the app's id> (app-calendar, app-mini-nle): an app.json's "icon" names it, and one drawing may serve two
// names (app-cutdown and cut are both scissors).
export const ICONS = Object.freeze({
  more: { file: "ellipsis.svg", body: '<circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/><circle cx="5" cy="12" r="1"/>' },   // a row's actions menu
  down: { file: "chevron-down.svg", body: '<path d="m6 9 6 6 6-6"/>' },   // a button or summary that opens a menu below it
  next: { file: "chevron-right.svg", body: '<path d="m9 18 6-6-6-6"/>' },   // a row that leads on to its own page
  back: { file: "arrow-left.svg", body: '<path d="m12 19-7-7 7-7"/><path d="M19 12H5"/>' },   // back to the list or page before
  forward: { file: "arrow-right.svg", body: '<path d="M5 12h14"/><path d="m12 5 7 7-7 7"/>' },   // on to another page: the arrow link's icon form
  check: { file: "check.svg", body: '<path d="M20 6 9 17l-5-5"/>' },   // done, sent, the current one
  info: { file: "info.svg", body: '<circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/>' },   // a tooltip's trigger
  menu: { file: "menu.svg", body: '<path d="M4 5h16"/><path d="M4 12h16"/><path d="M4 19h16"/>' },   // the phone menu, closed
  close: { file: "x.svg", body: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>' },   // the phone menu, open; close a panel
  home: { file: "house.svg", body: '<path d="M15 21v-8a1 1 0 0 0-1-1h-4a1 1 0 0 0-1 1v8"/><path d="M3 10a2 2 0 0 1 .709-1.528l7-6a2 2 0 0 1 2.582 0l7 6A2 2 0 0 1 21 10v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>' },   // the place's home page
  agents: { file: "bot.svg", body: '<path d="M12 8V4H8"/><rect width="16" height="12" x="4" y="8" rx="2"/><path d="M2 14h2"/><path d="M20 14h2"/><path d="M15 13v2"/><path d="M9 13v2"/>' },   // agents: connected assistants and rig agents
  people: { file: "users.svg", body: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><path d="M16 3.128a4 4 0 0 1 0 7.744"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><circle cx="9" cy="7" r="4"/>' },   // people on the network or workspace
  places: { file: "map-pin.svg", body: '<path d="M20 10c0 4.993-5.539 10.193-7.399 11.799a1 1 0 0 1-1.202 0C9.539 20.193 4 14.993 4 10a8 8 0 0 1 16 0"/><circle cx="12" cy="10" r="3"/>' },   // places: the computers and rigs agents live on
  work: { file: "list-checks.svg", body: '<path d="M13 5h8"/><path d="M13 12h8"/><path d="M13 19h8"/><path d="m3 17 2 2 4-4"/><path d="m3 7 2 2 4-4"/>' },   // work: requests and tasks
  "needs-you": { file: "bell.svg", body: '<path d="M10.268 21a2 2 0 0 0 3.464 0"/><path d="M3.262 15.326A1 1 0 0 0 4 17h16a1 1 0 0 0 .74-1.673C19.41 13.956 18 12.499 18 8A6 6 0 0 0 6 8c0 4.499-1.411 5.956-2.738 7.326"/>' },   // something waiting for you
  files: { file: "folder.svg", body: '<path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/>' },   // files
  apps: { file: "layout-grid.svg", body: '<rect width="7" height="7" x="3" y="3" rx="1"/><rect width="7" height="7" x="14" y="3" rx="1"/><rect width="7" height="7" x="14" y="14" rx="1"/><rect width="7" height="7" x="3" y="14" rx="1"/>' },   // apps
  machines: { file: "server.svg", body: '<rect width="20" height="8" x="2" y="2" rx="2" ry="2"/><rect width="20" height="8" x="2" y="14" rx="2" ry="2"/><line x1="6" x2="6.01" y1="6" y2="6"/><line x1="6" x2="6.01" y1="18" y2="18"/>' },   // machines: the computers a fleet runs on
  settings: { file: "settings.svg", body: '<path d="M9.671 4.136a2.34 2.34 0 0 1 4.659 0 2.34 2.34 0 0 0 3.319 1.915 2.34 2.34 0 0 1 2.33 4.033 2.34 2.34 0 0 0 0 3.831 2.34 2.34 0 0 1-2.33 4.033 2.34 2.34 0 0 0-3.319 1.915 2.34 2.34 0 0 1-4.659 0 2.34 2.34 0 0 0-3.32-1.915 2.34 2.34 0 0 1-2.33-4.033 2.34 2.34 0 0 0 0-3.831A2.34 2.34 0 0 1 6.35 6.051a2.34 2.34 0 0 0 3.319-1.915"/><circle cx="12" cy="12" r="3"/>' },   // settings
  plan: { file: "credit-card.svg", body: '<rect width="20" height="14" x="2" y="5" rx="2"/><line x1="2" x2="22" y1="10" y2="10"/><path d="M6 14h2"/>' },   // your plan and billing
  account: { file: "circle-user.svg", body: '<circle cx="12" cy="12" r="10"/><circle cx="12" cy="10" r="3"/><path d="M7 20.662V19a2 2 0 0 1 2-2h6a2 2 0 0 1 2 2v1.662"/>' },   // your account
  help: { file: "circle-help.svg", body: '<circle cx="12" cy="12" r="10"/><path d="M9 9.5a3 2.5 0 016 0c0 2-2 2-3 3.5"/><path d="M12 17h.01"/>' },   // help
  add: { file: "plus.svg", body: '<path d="M5 12h14"/><path d="M12 5v14"/>' },   // add something new
  search: { file: "search.svg", body: '<path d="m21 21-4.34-4.34"/><circle cx="11" cy="11" r="8"/>' },   // search
  copy: { file: "copy.svg", body: '<rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/>' },   // copy to the clipboard
  external: { file: "external-link.svg", body: '<path d="M15 3h6v6"/><path d="M10 14 21 3"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>' },   // opens another site
  terminal: { file: "terminal.svg", body: '<path d="M12 19h8"/><path d="m4 17 6-6-6-6"/>' },   // a terminal or command
  refresh: { file: "refresh-cw.svg", body: '<path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/><path d="M8 16H3v5"/>' },   // refresh or try again
  send: { file: "send.svg", body: '<path d="M14.536 21.686a.5.5 0 0 0 .937-.024l6.5-19a.496.496 0 0 0-.635-.635l-19 6.5a.5.5 0 0 0-.024.937l7.93 3.18a2 2 0 0 1 1.112 1.11z"/><path d="m21.854 2.147-10.94 10.939"/>' },   // send a request or message
  trash: { file: "trash-2.svg", body: '<path d="M10 11v6"/><path d="M14 11v6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M3 6h18"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>' },   // delete or remove
  edit: { file: "pencil.svg", body: '<path d="M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z"/><path d="m15 5 4 4"/>' },   // edit or rename
  pin: { file: "pin.svg", body: '<path d="M12 17v5"/><path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z"/>' },   // pin or keep at the top
  filter: { file: "funnel.svg", body: '<path d="M10 20a1 1 0 0 0 .553.895l2 1A1 1 0 0 0 14 21v-7a2 2 0 0 1 .517-1.341L21.74 4.67A1 1 0 0 0 21 3H3a1 1 0 0 0-.742 1.67l7.225 7.989A2 2 0 0 1 10 14z"/>' },   // filter a list
  play: { file: "play.svg", body: '<path d="M5 5a2 2 0 0 1 3.008-1.728l11.997 6.998a2 2 0 0 1 .003 3.458l-12 7A2 2 0 0 1 5 19z"/>' },   // start something: run an app, play a recording
  swap: { file: "arrow-left-right.svg", body: '<path d="M8 3 4 7l4 4"/><path d="M4 7h16"/><path d="m16 21 4-4-4-4"/><path d="M20 17H4"/>' },   // swap two things, or switch between them
  failed: { file: "circle-x.svg", body: '<circle cx="12" cy="12" r="10"/><path d="m15 9-6 6"/><path d="m9 9 6 6"/>' },   // it failed (always beside the words that say so)
  busy: { file: "loader-circle.svg", body: '<path d="M21 12a9 9 0 1 1-6.219-8.56"/>' },   // working on it (spin it only where motion is allowed)
  "check-circle": { file: "circle-check.svg", body: '<circle cx="12" cy="12" r="10"/><path d="m16 9-5.5 5.5L8 12"/>' },   // it passed or finished (beside the words that say so)
  "move-up": { file: "arrow-up.svg", body: '<path d="m5 12 7-7 7 7"/><path d="M12 19V5"/>' },   // move something up, or sort ascending
  "move-down": { file: "arrow-down.svg", body: '<path d="M12 5v14"/><path d="m19 12-7 7-7-7"/>' },   // move something down, or sort descending
  pause: { file: "pause.svg", body: '<rect x="14" y="3" width="5" height="18" rx="1"/><rect x="5" y="3" width="5" height="18" rx="1"/>' },   // pause playback or a run
  record: { file: "circle-dot.svg", body: '<circle cx="12" cy="12" r="1"/><circle cx="12" cy="12" r="10"/>' },   // record
  cut: { file: "scissors.svg", body: '<circle cx="6" cy="6" r="3"/><path d="M8.12 8.12 12 12"/><path d="M20 4 8.12 15.88"/><circle cx="6" cy="18" r="3"/><path d="M14.8 14.8 20 20"/>' },   // cut a clip or a selection
  lock: { file: "lock.svg", body: '<rect width="18" height="11" x="3" y="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>' },   // locked, or lock it
  sound: { file: "volume-2.svg", body: '<path d="M11 4.702a.705.705 0 0 0-1.203-.498L6.413 7.587A1.4 1.4 0 0 1 5.416 8H3a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h2.416a1.4 1.4 0 0 1 .997.413l3.383 3.384A.705.705 0 0 0 11 19.298z"/><path d="M16 9a5 5 0 0 1 0 6"/><path d="M19.364 18.364a9 9 0 0 0 0-12.728"/>' },   // sound on, volume
  "panel-toggle": { file: "panel-left.svg", body: '<rect width="18" height="18" x="3" y="3" rx="2"/><path d="M9 3v18"/>' },   // show or hide a side panel
  collapse: { file: "chevrons-left.svg", body: '<path d="m11 17-5-5 5-5"/><path d="m18 17-5-5 5-5"/>' },   // collapse a panel
  expand: { file: "chevrons-right.svg", body: '<path d="m6 17 5-5-5-5"/><path d="m13 17 5-5-5-5"/>' },   // expand a panel
  music: { file: "music.svg", body: '<path d="M21 16V3a1 1 0 0 0-1.28-.96l-10 2.917a1 1 0 0 0-.72.96V19"/><circle cx="18" cy="16" r="3"/><circle cx="6" cy="19" r="3"/>' },   // audio, a track
  image: { file: "image.svg", body: '<rect width="18" height="18" x="3" y="3" rx="2" ry="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21"/>' },   // an image
  film: { file: "film.svg", body: '<rect width="18" height="18" x="3" y="3" rx="2"/><path d="M7 3v18"/><path d="M3 7.5h4"/><path d="M3 12h18"/><path d="M3 16.5h4"/><path d="M17 3v18"/><path d="M17 7.5h4"/><path d="M17 16.5h4"/>' },   // a video
  upload: { file: "cloud-upload.svg", body: '<path d="M12 13v8"/><path d="M4 14.899A7 7 0 1 1 15.71 8h1.79a4.5 4.5 0 0 1 2.5 8.242"/><path d="m8 17 4-4 4 4"/>' },   // upload
  download: { file: "arrow-down-to-line.svg", body: '<path d="M12 17V3"/><path d="m6 11 6 6 6-6"/><path d="M19 21H5"/>' },   // download
  first: { file: "skip-back.svg", body: '<path d="M17.971 4.285A2 2 0 0 1 21 6v12a2 2 0 0 1-3.029 1.715l-9.997-5.998a2 2 0 0 1-.003-3.432z"/><path d="M3 20V4"/>' },   // go to the start
  last: { file: "skip-forward.svg", body: '<path d="M21 4v16"/><path d="M6.029 4.285A2 2 0 0 0 3 6v12a2 2 0 0 0 3.029 1.715l9.997-5.998a2 2 0 0 0 .003-3.432z"/>' },   // go to the end
  target: { file: "crosshair.svg", body: '<circle cx="12" cy="12" r="10"/><line x1="22" x2="18" y1="12" y2="12"/><line x1="6" x2="2" y1="12" y2="12"/><line x1="12" x2="12" y1="6" y2="2"/><line x1="12" x2="12" y1="22" y2="18"/>' },   // aim at, pick a point
  "app-calendar": { file: "calendar.svg", body: '<path d="M8 2v3"/><path d="M16 2v3"/><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18"/>' },   // app: Calendar
  "app-canvas": { file: "pen-tool.svg", body: '<path d="m18 13-.654-4.736a4 4 0 00-2.756-3.266l-9.163-2.9a2 2 0 00-2.017.493l-.82.819a2 2 0 00-.492 2.017l2.9 9.163a4 4 0 003.266 2.756L13 18"/><path d="M18.648 12.352a1.205 1.205 0 011.704 0l1.296 1.296a1.205 1.205 0 010 1.704l-6.296 6.296a1.205 1.205 0 01-1.704 0l-1.296-1.296a1.205 1.205 0 010-1.704z"/><path d="m3 3 6.586 6.586"/><circle cx="11" cy="11" r="2"/>' },   // app: Canvas
  "app-connections": { file: "plug.svg", body: '<path d="M12 22v-5"/><path d="M15 8V2"/><path d="M17 8a1 1 0 0 1 1 1v4a4 4 0 0 1-4 4h-4a4 4 0 0 1-4-4V9a1 1 0 0 1 1-1z"/><path d="M9 8V2"/>' },   // app: Connections
  "app-cutdown": { file: "scissors.svg", body: '<circle cx="6" cy="6" r="3"/><path d="M8.12 8.12 12 12"/><path d="M20 4 8.12 15.88"/><circle cx="6" cy="18" r="3"/><path d="M14.8 14.8 20 20"/>' },   // app: Cutdown (the same drawing as cut)
  "app-effects": { file: "sparkles.svg", body: '<path d="M11.017 2.814a1 1 0 0 1 1.966 0l1.051 5.558a2 2 0 0 0 1.594 1.594l5.558 1.051a1 1 0 0 1 0 1.966l-5.558 1.051a2 2 0 0 0-1.594 1.594l-1.051 5.558a1 1 0 0 1-1.966 0l-1.051-5.558a2 2 0 0 0-1.594-1.594l-5.558-1.051a1 1 0 0 1 0-1.966l5.558-1.051a2 2 0 0 0 1.594-1.594z"/><path d="M20 2v4"/><path d="M22 4h-4"/><circle cx="4" cy="20" r="2"/>' },   // app: Effects
  "app-factory": { file: "factory.svg", body: '<path d="M12 16h.01"/><path d="M16 16h.01"/><path d="M3 19a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V8.5a.5.5 0 0 0-.769-.422l-4.462 2.844A.5.5 0 0 1 15 10.5v-2a.5.5 0 0 0-.769-.422L9.77 10.922A.5.5 0 0 1 9 10.5V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2z"/><path d="M8 16h.01"/>' },   // app: Factory
  "app-feed": { file: "rss.svg", body: '<path d="M4 11a9 9 0 0 1 9 9"/><path d="M4 4a16 16 0 0 1 16 16"/><circle cx="5" cy="19" r="1"/>' },   // app: Feed
  "app-gallery": { file: "images.svg", body: '<path d="m22 11-1.296-1.296a2.4 2.4 0 0 0-3.408 0L11 16"/><path d="M4 8a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2"/><circle cx="13" cy="7" r="1" fill="currentColor"/><rect x="8" y="2" width="14" height="14" rx="2"/>' },   // app: Gallery
  "app-library": { file: "library.svg", body: '<path d="m16 6 4 14"/><path d="M12 6v14"/><path d="M8 8v12"/><path d="M4 4v16"/>' },   // app: Library
  "app-media-manager": { file: "folder-open.svg", body: '<path d="m6 14 1.5-2.9A2 2 0 0 1 9.24 10H20a2 2 0 0 1 1.94 2.5l-1.54 6a2 2 0 0 1-1.95 1.5H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H18a2 2 0 0 1 2 2v2"/>' },   // app: Media manager
  "app-media-review": { file: "clapperboard.svg", body: '<path d="m12.296 3.464 3.02 3.956"/><path d="M20.2 6 3 11l-.9-2.4c-.3-1.1.3-2.2 1.3-2.5l13.5-4c1.1-.3 2.2.3 2.5 1.3z"/><path d="M3 11h18v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><path d="m6.18 5.276 3.1 3.899"/>' },   // app: Media review
  "app-mini-nle": { file: "film.svg", body: '<rect width="18" height="18" x="3" y="3" rx="2"/><path d="M7 3v18"/><path d="M3 7.5h4"/><path d="M3 12h18"/><path d="M3 16.5h4"/><path d="M17 3v18"/><path d="M17 7.5h4"/><path d="M17 16.5h4"/>' },   // app: Mini NLE (the same drawing as film)
  "app-now": { file: "clock.svg", body: '<circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/>' },   // app: Now
  "app-observatory": { file: "telescope.svg", body: '<path d="m10.065 12.493-6.18 1.318a.934.934 0 0 1-1.108-.702l-.537-2.15a1.07 1.07 0 0 1 .691-1.265l13.504-4.44"/><path d="m13.56 11.747 4.332-.924"/><path d="m16 21-3.105-6.21"/><path d="M16.485 5.94a2 2 0 0 1 1.455-2.425l1.09-.272a1 1 0 0 1 1.212.727l1.515 6.06a1 1 0 0 1-.727 1.213l-1.09.272a2 2 0 0 1-2.425-1.455z"/><path d="m6.158 8.633 1.114 4.456"/><path d="m8 21 3.105-6.21"/><circle cx="12" cy="13" r="2"/>' },   // app: Observatory
  "app-operations": { file: "gauge.svg", body: '<path d="m12 14 4-4"/><path d="M3.34 19a10 10 0 1 1 17.32 0"/>' },   // app: Operations
  "app-provider-manager": { file: "key-round.svg", body: '<path d="M2.586 17.414A2 2 0 0 0 2 18.828V21a1 1 0 0 0 1 1h3a1 1 0 0 0 1-1v-1a1 1 0 0 1 1-1h1a1 1 0 0 0 1-1v-1a1 1 0 0 1 1-1h.172a2 2 0 0 0 1.414-.586l.814-.814a6.5 6.5 0 1 0-4-4z"/><circle cx="16.5" cy="7.5" r=".5" fill="currentColor"/>' },   // app: Provider manager
  "app-review": { file: "message-square-text.svg", body: '<path d="M22 17a2 2 0 0 1-2 2H6.828a2 2 0 0 0-1.414.586l-2.202 2.202A.71.71 0 0 1 2 21.286V5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2z"/><path d="M7 11h10"/><path d="M7 15h6"/><path d="M7 7h8"/>' },   // app: Review
  "app-rig-designer": { file: "drafting-compass.svg", body: '<path d="m12.99 6.74 1.93 3.44"/><path d="M19.136 12a10 10 0 0 1-14.271 0"/><path d="m21 21-2.16-3.84"/><path d="m3 21 8.02-14.26"/><circle cx="12" cy="5" r="2"/>' },   // app: Rig designer
  "app-scanner": { file: "scan-line.svg", body: '<path d="M3 7V5a2 2 0 0 1 2-2h2"/><path d="M17 3h2a2 2 0 0 1 2 2v2"/><path d="M21 17v2a2 2 0 0 1-2 2h-2"/><path d="M7 21H5a2 2 0 0 1-2-2v-2"/><path d="M7 12h10"/>' },   // app: Scanner
  "app-seats": { file: "armchair.svg", body: '<path d="M19 9V6a2 2 0 0 0-2-2H7a2 2 0 0 0-2 2v3"/><path d="M3 16a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-5a2 2 0 0 0-4 0v1.5a.5.5 0 0 1-.5.5h-9a.5.5 0 0 1-.5-.5V11a2 2 0 0 0-4 0z"/><path d="M5 18v2"/><path d="M19 18v2"/>' },   // app: Seats
  "app-steering": { file: "compass.svg", body: '<circle cx="12" cy="12" r="10"/><path d="m16.24 7.76-1.804 5.411a2 2 0 0 1-1.265 1.265L7.76 16.24l1.804-5.411a2 2 0 0 1 1.265-1.265z"/>' },   // app: Steering
  "app-tldraw": { file: "shapes.svg", body: '<path d="M8.3 10a.7.7 0 0 1-.626-1.079L11.4 3a.7.7 0 0 1 1.198-.043L16.3 8.9a.7.7 0 0 1-.572 1.1Z"/><rect x="3" y="14" width="7" height="7" rx="1"/><circle cx="17.5" cy="17.5" r="3.5"/>' },   // app: tldraw
  "app-traction": { file: "trending-up.svg", body: '<path d="M16 7h6v6"/><path d="m22 7-8.5 8.5-5-5L2 17"/>' },   // app: Traction
  "app-architect": { file: "blocks.svg", body: '<path d="M10 22V7a1 1 0 0 0-1-1H4a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-5a1 1 0 0 0-1-1H2"/><rect x="14" y="2" width="8" height="8" rx="1"/>' },   // app: Architect
  "app-build": { file: "hammer.svg", body: '<path d="m15 12-9.373 9.373a1 1 0 0 1-3.001-3L12 9"/><path d="m18 15 4-4"/><path d="m21.5 11.5-1.914-1.914A2 2 0 0 1 19 8.172v-.344a2 2 0 0 0-.586-1.414l-1.657-1.657A6 6 0 0 0 12.516 3H9l1.243 1.243A6 6 0 0 1 12 8.485V10l2 2h1.172a2 2 0 0 1 1.414.586L18.5 14.5"/>' },   // app: Build
  "app-hello": { file: "hand.svg", body: '<path d="M18 11V6a2 2 0 0 0-2-2a2 2 0 0 0-2 2"/><path d="M14 10V4a2 2 0 0 0-2-2a2 2 0 0 0-2 2v2"/><path d="M10 10.5V6a2 2 0 0 0-2-2a2 2 0 0 0-2 2v8"/><path d="M18 8a2 2 0 1 1 4 0v6a8 8 0 0 1-8 8h-2c-2.8 0-4.5-.86-5.99-2.34l-3.6-3.6a2 2 0 0 1 2.83-2.82L7 15"/>' },   // app: Hello (1.4.0)
  "app-projects": { file: "folder-kanban.svg", body: '<path d="M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.93a2 2 0 0 1-1.66-.9l-.82-1.2A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13c0 1.1.9 2 2 2Z"/><path d="M8 10v4"/><path d="M12 10v2"/><path d="M16 10v6"/>' },   // app: Workspace, 'Projects' (1.4.0)
});

// The <svg> attributes every icon shares, in DOM-property (React) spelling; icon() writes them as HTML attributes.
export const ICON_SVG = Object.freeze({ viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "1.75", strokeLinecap: "round", strokeLinejoin: "round" });

/** The inside of an icon's <svg> (for a framework that builds the <svg> element itself). Throws on a name the registry doesn't have. */
export function iconBody(name) {
  const it = Object.hasOwn(ICONS, name) ? ICONS[name] : undefined;   // own names only: never an inherited key such as "constructor"
  if (!it) throw new Error(`No icon named "${name}" in the kit (kit/icons.mjs)`);
  return it.body;
}

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const kebab = (k) => (k === "viewBox" ? k : k.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`));

/**
 * One icon as inline SVG markup. Hidden from assistive tech unless it has a label: an icon beside words adds nothing to their name, and an
 * icon alone on a control should get its name from the control (aria-label on the button), so `label` is for the rare icon that is itself
 * the information (a "current" check).
 * @param {string} name a key of ICONS
 * @param {{ size?: number, label?: string, className?: string }} [opts] size in px (default 16)
 */
export function icon(name, { size = 16, label = "", className = "or-icon" } = {}) {
  const attrs = Object.entries(ICON_SVG).map(([k, v]) => `${kebab(k)}="${v}"`).join(" ");
  const a11y = label ? `role="img" aria-label="${esc(label)}"` : 'aria-hidden="true"';
  return `<svg class="${esc(className)}" width="${size}" height="${size}" ${attrs} ${a11y} focusable="false">${iconBody(name)}</svg>`;
}
