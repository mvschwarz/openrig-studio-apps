#!/usr/bin/env node
// Starts the live rig state companion (live-state.mjs) as its own process, as provider.json declares it. A deployment that adds
// fields of its own to the floor's state replaces this file with a runner that passes options.extend to startLiveState.
// Copyright 2026 mvschwarz. Licensed under the Apache License, Version 2.0.
//
// Usage: node live-state-run.mjs --out <dir> [--rig <name>] [--interval <ms>] [--once]
import path from "node:path";
import { startLiveState } from "./live-state.mjs";

const argv = process.argv.slice(2);
const arg = (n, d) => {
  const i = argv.indexOf(n);
  return i > -1 && argv[i + 1] ? argv[i + 1] : d;
};
const out = arg("--out", "");
const rig = arg("--rig", "");
const interval = Number(arg("--interval", "10000"));
const once = argv.includes("--once");

const live = startLiveState(out, rig ? { rig } : {}, { interval: once ? 0 : interval });
await live.first;
if (!once)
  console.log(
    `live-state: ${path.resolve(out)} refreshed ${interval}ms after each refresh finishes`,
  );
