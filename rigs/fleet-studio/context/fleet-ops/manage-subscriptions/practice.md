# Manage subscriptions

**When this applies:** the person has enabled subscription management for you. Installing this bundle
alone does not enable it. You are the one managing agent, not a second manager competing with the operator.

Read `rig context get skills/openrig-user`, "Manage subscriptions across a fleet", for the complete
move procedure and account-policy conversation. Use `rig <command> --help` for this installed version.
The first supported move is a whole Codex home on Linux, including its peers; not a subset of seats on
one home, Claude moves, or Mac restarts. If a route is missing, report it instead of improvising.

1. Load `rig context get account-policy` when it exists and record its manifest version. Follow the
   person's standing permission without asking again. Without a policy, use the shipped procedure,
   report no policy, and offer once to write one with them. Intent does not create missing access.
2. Read `rig provider status --all-hosts --json` and earlier `rig provider moves`. Keep machines'
   readings separate; a shared allowance is one allowance. Unknown is never observed room. A known
   reset may inform a plan only as **expected full since** that reset, not measured; get a new reading
   when possible. A sign-in state of unknown is not needs-sign-in.
3. Balance machines across subscriptions rather than chasing the latest reset. Read
   `rig seat restart <seat> --keep-conversation --plan` for the home and every peer. Skip busy or
   service-bearing seats with a reason. Moving the home affects all peers, even those not restarted.
4. Confirm the selected home with `rig auth status --runtime codex --codex-home <home>`, then run
   `rig auth switch <profile> --runtime codex --codex-home <home>`. For another machine, add
   `--host <id>` to both auth commands and to every `rig seat restart` command in this practice.
   Restart chosen seats with `rig seat restart <seat> --keep-conversation --reason "<why>"`.
   Preserve their conversation and settings.
5. After a real tool-using turn, run `rig seat restart <seat> --keep-conversation --verify
   --expect-account <target Account line>`. Only a matched account **and** an observed error-free tool
   turn confirm uptake. Missing evidence is unconfirmed or unknown; a slow reply never warrants a
   second restart. Record peers left alone as "not restarted; account unverified".
6. File `rig provider moves report --file <move.json> --to <whoever asked>` using its help for the
   schema. Name from/to, host/home, reason, policy version or no policy, readings and their times/basis,
   separate account and tool-turn evidence, missing facts, and peers. No credential values. A refused
   report changes nothing about the move: correct the report, never repeat the switch or restart.
   Follow up with `--follows <qitemId>` when evidence arrives; read it back with `rig provider moves`.

A known needs-sign-in gets one durable request to the person, naming machine and subscription; move
nothing onto it until resolved. Carry on with other work. If nothing has room, report reset times;
never use an API fallback, buy anything or create an account. The Fleet page shows these dated reports
separately from configured assignments and observed usage windows. A report is not a current login.
