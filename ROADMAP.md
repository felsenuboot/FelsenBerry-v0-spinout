# ROADMAP — what's done, what's next

Status snapshot after the first field-test + fix cycle. See [CONTEXT.md](CONTEXT.md) for the
findings behind these items.

## ✅ Done — proven

- **Look-ahead runtime** (`src/planner.js`): `run(deps,job)` facade + deterministic
  `plan(project,world)` + 1-deep look-ahead queue. Offline harness: 26/26 assertions —
  every next job planned during the current one, ~0-gap, interrupt preempt/resume with the
  queue intact.
- **Live, from-empty, zero-LLM:** barehanded hand-dig → wooden pickaxe from nothing →
  chop 3 oak (replant saplings, collect apples) → mine 16 cobblestone, job→job on a real
  server. Interrupts preempt + resume on the real ladder.
- **Safety:** arm-when-clear (defer bootstrap until ≥30 b from base) + base-protection
  gather filter. Clean damage audits (0 base blocks touched).
- **Bootstrap ordering + multi-leg flatten:** from zero, tool-craft leads and each chain's
  work-legs are separate jobs, so `craft_wood_tools` makes *both* pickaxe and axe (fixes
  the dropped-axe loop-killer).

## 🧪 Implemented, awaiting live-verify (the reliability push)

The full field-test bug batch is **fixed in code** — mock-verified (lookahead 26/26,
perception 20/20) and **review-gated** (shared host code; deploy = careful cherry-pick, not
a branch merge). What remains is **one batch live-verify** on a fresh empty bot once a server
is up: empty → pickaxe → axe → chop → mine → **real stone tools**, self-healing throughout.

- **Perception / world-state layer** (`src/perception.js`) — CPU-only `worldState(bot)`:
  `{ conditions:{inventory,health,food,pos}, surroundings:{resources,structures,threats} }`,
  with `nearestReachable` per resource. Wired into the planner's `worldFrom` so the plan
  sees a fresh snapshot (kills the stale-snapshot "nothing_to_do" race). Built as **Andy's
  future prompt context** — one layer serves planner + LLM.
- **Starter-base table** — opt-in `keepTable` leaves the bootstrap table **placed**
  (default off = fleet unchanged); the next craft **reuses** the in-reach table; a runtime
  `digguard.protect()` registers it as a protected starter fixture. *(Durable
  `protected.json` mirroring still to do — belt-and-suspenders; the loop completes without it.)*
- **Tier-assert** — `ensureTool('stone_pickaxe')` now requires the *stone* tier (a held
  wooden pickaxe no longer satisfies it), so `craft_stone_gear` yields real stone tools.
- **Toolchain recovery, not freeze** — `chopTrees` and `craftToolChain`'s gather now
  **relocate toward perceived wood and retry** (bounded ≤4 hops) instead of stalling, then
  fail with a **specific typed reason**. Kills the "no axe, could not acquire" and "no tree
  within 64" freezes. This is also the robust-resource-search fix.

## ⏭️ Next — major milestones

- **Batch live-verify** (blocked on a running server) — the gating step above.
- **Wire the real Andy LLM** at the goal boundary (currently a deterministic stub): local
  Ollama, **CPU-only (`num_gpu:0`)**, schema-constrained output + validate + deterministic
  fallback, fires **only** at job boundaries (look-ahead hides its latency). Andy consumes
  the perception snapshot as context. Flag-gated.
- **Integrate headless Baritone for travel.** Swap it in behind `deps.travel` for long-haul
  travel + remote ore-mining (pathfinder is unreliable past ~50 b — proven repeatedly).
  Design the one-body-vs-two-body handoff (Baritone is a separate client today).
- **Extend the spine past stone:** iron (mine @Y≈16 → smelt → iron gear) and diamond
  (@Y≈−59), to the pre-Nether cap. Depends on reliable travel-to-depth.
- **The COOPERATE pillar** (untested): multi-bot coordination on deterministic shared state
  (depot/base registries, leases) rather than natural-language chatter (which collapses at
  scale — cf. mindcraft's own MineCollab benchmark).

## 🗒️ Backlog / open questions

- **One-body vs two-body** for Baritone: run it inside the mineflayer process, or two
  coordinated bodies with a state handoff? Decides the travel integration.
- **Durable table protection:** mirror the runtime `digguard.protect()` into a persistent
  `protected.json` / basekeeping registration so it survives restarts.
- **Movement scarring / aesthetics:** bots should not leave dug-up trenches and floating
  pillars; tidy-travel + one-time cleanup of legacy scars.
- **Waiting between actions:** characterize where wall-clock actually goes (tick cadence,
  slow hand-dig, idle drop-scans) once the loop completes end-to-end.
- **Missing skills** for later chains: dedicated `cook` / `placeBed` / `placeDoor` / `fish`
  (currently piggyback the furnace-smelt / generic-place paths).
