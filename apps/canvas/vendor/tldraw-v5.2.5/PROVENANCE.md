# tldraw-v5.2.5 — pinned prebuilt bundle (CANVAS surface)

Committed artifact, built ONCE offline on 2026-07-25 by visual-art-director@openrig-studio.
NO build step in this repo — that is the point. To rebuild (version bump only):

```
npm init -y && npm install tldraw@5.2.5 react@19.2.8 react-dom@19.2.8 esbuild
cat > entry.js <<'EOF'
import * as tldraw from "tldraw";
import * as React from "react";
import * as ReactDOMClient from "react-dom/client";
window.TldrawBundle = { tldraw, React, ReactDOMClient, version: "5.2.5" };
EOF
npx esbuild entry.js --bundle --minify --format=iife \
  --define:process.env.NODE_ENV='"production"' \
  --loader:.svg=dataurl --loader:.png=dataurl --loader:.woff2=dataurl \
  --outfile=tldraw-bundle.js
cp node_modules/tldraw/tldraw.css .
# fonts: the ONLY runtime CDN dependency in tldraw 5.2.5 — self-hosted here
for f in <the 16 names in fonts/>; do curl -O https://cdn.tldraw.com/5.2.5/fonts/$f.woff2; done
```

Contents: `tldraw-bundle.js` (1.9MB IIFE — tldraw + react + react-dom under
`window.TldrawBundle`; React exists ONLY inside this blob, surface glue stays vanilla),
`tldraw.css` (self-contained, data-URI cursors only), `fonts/` (16 woff2 — the surface
passes `assetUrls.fonts` overrides pointing here so the box never calls cdn.tldraw.com),
`LICENSE.md` (tldraw's own).

LICENSE STATUS (founder research 2026-07-25): dev/localhost use is unkeyed and fine;
PRODUCTION on an HTTPS non-localhost domain (bray.rigs.to) requires a license key —
noncommercial "hobby license" (approval + watermark) or the 100-day production trial.
Founder action before box deploy; flagged via dev-driver3. A version bump changes the
store schema — canvas.json docs migrate on next UI load; bump the dir name and the
`version` field together.
