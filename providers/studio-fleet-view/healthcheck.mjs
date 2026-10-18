#!/usr/bin/env node
// The Fleet container's healthcheck: the Fleet provider's ready route, asked through the studio's port
// (providers/shared/healthcheck-core.mjs has the rules).
import { pathToFileURL } from "node:url";
import { checkProvider, runHealthcheck, LABELS as CORE } from "../shared/healthcheck-core.mjs";

export const PROVIDER = "@openrig/studio-fleet-view";
export const LABELS = { ready: "provider ready: the studio and the fleet provider are serving", ...CORE };
const opts = (o = {}) => ({ base: "http://127.0.0.1:9450", readyPath: "/api/fleet-view/ready", provider: PROVIDER, readyLabel: LABELS.ready, ...o });

export async function check(o = {}) { return checkProvider(opts(o)); }

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await runHealthcheck(opts({ base: process.env.FLEET_HEALTH_BASE || "http://127.0.0.1:9450" }));
}
