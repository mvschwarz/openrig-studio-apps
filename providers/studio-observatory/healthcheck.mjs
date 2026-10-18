#!/usr/bin/env node
// The Observatory container's healthcheck: the Observatory provider's ready route, asked through the
// studio's port (providers/shared/healthcheck-core.mjs has the rules).
import { pathToFileURL } from "node:url";
import { checkProvider, runHealthcheck, LABELS as CORE } from "../shared/healthcheck-core.mjs";

export const PROVIDER = "@openrig/studio-observatory";
export const LABELS = { ready: "provider ready: the studio and the observatory provider are serving", ...CORE };
const opts = (o = {}) => ({ base: "http://127.0.0.1:9440", readyPath: "/api/observatory/ready", provider: PROVIDER, readyLabel: LABELS.ready, ...o });

export async function check(o = {}) { return checkProvider(opts(o)); }

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await runHealthcheck(opts({ base: process.env.OBSERVATORY_HEALTH_BASE || "http://127.0.0.1:9440" }));
}
