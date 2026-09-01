# ROADMAP — what's done, what's next

Status snapshot as of the first field-test cycle. See [CONTEXT.md](CONTEXT.md) for the
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
- **Bootstrap ordering:** from zero, tool-craft leads (chopping needs an axe) — the
  classical punch-wood → tools → chop order.
- **Multi-leg flatten:** each chain's work-legs are separate look-ahead jobs, so
  `craft_wood_tools` makes *both* pickaxe and axe (fixes the dropped-axe loop-killer).

## 🔧 Now — make the loop complete *reliably* (the reliability push)

These are the difference between a run that completes and one that stalls. Do them in the
host skill library as **reviewed diffs** (see AGENTS.md).

1. **Starter-base semantics (the crafting table).**
   - Do **not** drop/deconstruct the table the bootstrap places — keep it placed.
   - **Reuse** an existing table/chest in reach instead of placing a duplicate.
   - Register the first placed table as a **protected** starter-base fixture.
2. **Tier-assert.** `ensureTool('stone_pickaxe')` must require the *stone* tier, not accept
   a held wooden pickaxe as satisfying the pickaxe *class*. So `craft_stone_gear` yields
   real stone tools, not a no-op.
3. **Perception / world-state layer** — the unifying fix. A compact, serializable,
   CPU-only snapshot:
   ```
   worldState = {
     conditions:   { inventory:{item:count}, health, food, pos },
     surroundings: { resources:{ <type>:{ count, nearestReachable, positions } },
                     threats:[...], structures:[ table/chest/furnace + pos ] }
   }
   ```
   Feed it to `plan()`/`worldFrom` (kills the stale-snapshot race) and to the chains
   (chop what's actually nearby; relocate toward perceived forest; reuse perceived tables).
   **Design it as Andy's future prompt context** — one layer serves planner + LLM.
4. **Toolchain recovery, not freeze.** `craftToolChain`/`ensureTool`/`chopTrees` must
   recover from a failed precondition (re-establish a lost table; gather more wood via
   perception; relocate to reachable trees) and only give up with a **specific typed
   reason** — never a silent stall.
5. **Robust resource search.** If no tree/ore is within reach, search a wider radius and
   **relocate** toward the nearest perceived resource before failing — don't die ~30 b out.

## ⏭️ Next — major milestones

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
- **Movement scarring / aesthetics:** bots should not leave dug-up trenches and floating
  pillars; tidy-travel + one-time cleanup of legacy scars.
- **Waiting between actions:** characterize where wall-clock actually goes (tick cadence,
  slow hand-dig, idle drop-scans) once the loop completes end-to-end.
- **Missing skills** for later chains: dedicated `cook` / `placeBed` / `placeDoor` / `fish`
  (currently piggyback the furnace-smelt / generic-place paths).
