# 🪨🫐 FelsenBerry

**An autonomous Minecraft bot engine — a sparse-LLM brain over a deterministic body.**

FelsenBerry is a focused, versioned engine component: the runtime that lets a Minecraft
bot **build bases, live (survive + progress), and cooperate** — mostly deterministically,
with a small language model making only the rare judgment calls. It is designed to be
adopted into [felcrew](https://github.com/felsenuboot/felcrew-mcp) as a standalone,
versioned software part.

New here? Read [CONTEXT.md](CONTEXT.md) (the distilled project memory) and
[AGENTS.md](AGENTS.md) (how to develop this, human or agent) before changing anything.

---

## The three pillars

> **autonomous Minecraft bots that can BUILD BASES, LIVE in Minecraft, and COOPERATE**

- **Build** — human-looking bases, farms, storage, mining shafts (parametric blueprints).
- **Live** — the classical survival progression (logs → tools → stone → iron → diamond,
  capped pre-Nether for now), plus food, hunting, farming, tool discipline, safety.
- **Cooperate** — shared-state coordination between bots (deterministic registries, not
  fragile natural-language chatter).

## The core thesis

Most of what *looks* like smart human play is not judgment — it is a stack of
**deterministic threshold rules** evaluated in priority order. Measured three ways
(a hand-written player playbook, an in-world chain audit, and a runtime analysis), the
split lands at roughly:

- **~85 % of the decision *rules* are deterministic thresholds**
- **~97 % of *wall-clock time* in a session is deterministic** — the reflex ladder fires
  thousands of times; genuine judgment fires a handful of times

So the LLM belongs **only at goal boundaries and creative/social boundaries** — *never*
inside the moment-to-moment loop. That is what makes the engine fast and token-cheap: a
free, local, CPU-only model (Andy-4 via Ollama) makes sparse, bounded, schema-constrained
picks; deterministic code does everything else.

## Architecture

Five layers — four already existed in the field-tested bot fleet, one is genuinely new:

```
 GOAL       Andy (local LLM)  — picks the PROJECT once, only at boundaries        [sparse]
              │  setProject(goal)
 PLAN       Speculative look-ahead planner  — deterministic HTN/GOAP decompose,   [NEW]
              │  compute job N+1 while job N runs → zero-gap job→job
 ARBITRATE  Priority ladder (agenda)  — eat/flee/deposit/tool/light preempt        [reuse]
              │  run(job)                the project, latch + hysteresis, resume
 EXECUTE    Uniform executor facade  run(job)→{ok,made,reason}                     [glue]
              │  travel → pathfinder/Baritone · craft/mine/build → skill library
 COMPLETE   await the skill promise → tell the planner → pop the look-ahead queue  [reuse]
```

**The novel piece is the speculative look-ahead planner.** No existing LLM-agent framework
(mindcraft, Voyager) has it — they are all strictly sequential and block on the LLM between
every action. That block *is* the downtime FelsenBerry removes: the planner computes the
next job *during* the current job, so the bot never waits on the brain.

`src/planner.js` is that runtime: the `run(deps, job)` executor facade + the deterministic
`plan(project, world)` + the 1-deep look-ahead queue. It is dependency-injected (no live
bot at load), so it drops onto any mineflayer-based skill library.

## Status

**Proven (live, on a real server, zero LLM, zero cheating):**
- The deterministic look-ahead drove a **from-empty bootstrap spine job→job on a real
  body** — barehanded hand-dig → wooden pickaxe **from nothing** → chop 3 oak (replanting
  saplings, collecting apples) → mine 16 cobblestone — with the next job firing on the
  completion tick, no re-planning gap.
- **Interrupts** (a tool-swap rung) preempt the project and **resume the same job**, queue
  intact, on the real ladder.
- **Safety held**: an *arm-when-clear* gate keeps the from-scratch bootstrap ≥30 blocks
  from base; a base-protection filter stops the hand-dig from ever touching protected logs.
  Damage audits came back clean.
- Look-ahead overlap + 0-gap timing proven in a 26-assertion harness (`node`, no server).

**In progress (see [ROADMAP.md](ROADMAP.md)):** completing the loop *reliably* — the field
test surfaced real bugs (a dropped axe-craft step, a dropped/duplicated crafting table,
a tier-assert gap, and travel/reachability robustness) that are the difference between a
run that completes and one that stalls. The unifying fix is a **perception/world-state
layer** so the bot can "see" its surroundings and know its own condition.

**Not started:** wiring the real Andy LLM at the goal boundary (currently a deterministic
stub), integrating headless Baritone for long-haul travel, and the Cooperate pillar.

## Integrating into felcrew

FelsenBerry is intentionally **small and dependency-injected**, not a fork of the full bot
repo. It expects a host to provide:
- a **travel** primitive (`deps.travel(to) → {arrived}`), e.g. mineflayer-pathfinder now,
  headless Baritone later — swappable behind the same interface;
- a **skill library** (`chopTrees`, `mineLane`, `ensureTool`, `buildFloor`, `produce`, …)
  resolving to awaitable, typed results;
- a **priority-ladder / interrupt** layer to own the project rung.

The reference host is the felcrew bot fleet (mineflayer + a deterministic skill library +
an `agenda` priority ladder). FelsenBerry is versioned so felcrew can pin and upgrade it.
The `docs/` design files reference that host's implementation by file:line — read them as
design intent, not as paths inside this repo.

## Repo layout

```
README.md            — this file
CONTEXT.md           — distilled project memory: decisions, guardrails, the "why"
AGENTS.md            — how to develop FelsenBerry (working agreements for humans + agents)
ROADMAP.md           — what's done, what's next, the field-test findings
package.json         — versioned component (semver)
src/planner.js       — the look-ahead runtime (facade + planner + 1-deep queue)
docs/ARCHITECTURE.md — the full execution-architecture design (reuse/glue/build)
docs/PLAYBOOK.md     — the human decision-tree: thresholds, tier spine, base lifecycle
docs/CHAINS.md       — the tool-chain library (classical progression, capped at diamond)
```

## License

MIT — see [LICENSE](LICENSE).
