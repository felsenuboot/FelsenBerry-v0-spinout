# CONTEXT — the distilled project memory

Everything a fresh run (human or agent) needs to understand FelsenBerry before touching it.
This is the *why*; [ROADMAP.md](ROADMAP.md) is the *what next*; [AGENTS.md](AGENTS.md) is
the *how to work*.

## What this is

An autonomous Minecraft bot **engine**. The bots are the continuous field test; the engine
is the product. North star: **autonomous bots that build bases, live in Minecraft, and
cooperate** (build / live / cooperate). Scope is currently capped at the classical survival
loop up to **diamond gear, pre-Nether** — deliberately, to nail the well-understood loop
before adding Nether judgment.

## The thesis (do not lose this)

Deterministic-first. ~85 % of decision *rules* and ~97 % of *wall-clock* are pure threshold
logic that must run in-bot with **no LLM in the loop**. The LLM (a local, CPU-only Andy-4
via Ollama) is **sparse**: it picks the top goal at boundaries and handles novel/creative/
social calls. Everything else — eat/flee/torch/tool-swap/return/branch-spacing/deposit,
the whole tech-tree decomposition — is a number a program evaluates. This keeps the engine
fast and token-cheap.

## Key decisions (and why)

- **Look-ahead is the one novel piece.** Compute job N+1 while job N runs, so the slow LLM
  never stalls the bot. mindcraft and Voyager are strictly sequential (LLM between every
  action) — that block is the downtime we remove. Everything else is *reuse* of the
  existing bot fleet (priority ladder, skill library, guards) + thin *glue*.
- **One body, pathfinder-first; Baritone deferred behind `run(job)`.** The proven headless
  Baritone is a *separate* player (its own login) with no handoff to the skill body. Rather
  than solve that two-body problem first, v1 runs on one mineflayer body with
  mineflayer-pathfinder for travel; real Baritone swaps in later behind `deps.travel` with
  no caller change. Field tests repeatedly showed pathfinder is unreliable for medium hauls
  (~50 b timeouts) → Baritone-for-travel is the right next infra step.
- **Andy MUST run CPU-only (`num_gpu: 0`).** A dev machine crashed from GPU VRAM exhaustion
  when Ollama offloaded the model onto a saturated GPU. Every Ollama call passes
  `options:{num_gpu:0}`. Calls are sparse + bounded, so CPU latency is a non-issue and is
  hidden by look-ahead anyway. This is a hard, structural guardrail.
- **Structured perception, not GPU vision.** "The bot needs to see" = a compact structured
  world snapshot from `bot.findBlocks` / `bot.inventory` / `bot.entities` (CPU-only), *not*
  pixels. This snapshot feeds both the deterministic planner today and Andy's prompt later.
- **Full autonomy includes destruction.** Bots may break blocks/bases by design; the fix
  for accidental self-harm (e.g. eating your own base for wood) is a *smarter brain* +
  perception, **not** hard-blocking destructive skills. The one thing that stays guarded is
  an *accidental silent* bypass (a gather path that ignores the protection filter the rest
  of the engine respects) — that's a consistency bug, not a capability limit.

## Hard guardrails (never violate)

- **No cheating** — survival-legit only; no op/creative shortcuts as an end.
- **Andy is CPU-only** (`num_gpu:0`).
- **Test on a dedicated bot on an UNUSED port, spawned/positioned AWAY from base.** Never
  on a production port. Never gamble base infrastructure for a demo.
- **Hands off other players' bots** (on a shared server: other crews' bots are off-limits —
  no attacking, no interfering).
- **Collect all drops** — never leave item drops (rivals snipe in seconds).
- **Bot names:** short, funny, ≤16 chars, `[A-Za-z0-9_]`.
- **Shared-code changes are review-gated:** any edit to the host skill library ships as a
  reviewed diff; deploy is a careful **cherry-pick**, never a merge of a stale branch.

## The reference host (felcrew bot fleet)

FelsenBerry is dependency-injected and expects a host to provide:
- **skill library** — `chopTrees`, `mineLane`, `ensureTool`, `safeDescend`, `buildFloor`,
  `buildWall`, `frameStructure`, `buildStaircase`, `huntAnimals`, `farmCycle`,
  `tillFarmland`, `collectDrops`, `restock`, `depositToChest`, `produce` (typed failures:
  `no_pickaxe|no_wood|no_fuel|no_space|unreachable|unproduceable|partial|error`).
- **priority ladder** — a subsumption ladder (`agenda`) with rungs REFLEX → POSTURE →
  EAT_CRITICAL → DEPOSIT → EAT → TOOL → RESTOCK → LIGHT → PROJECT → IDLE, with latch +
  hysteresis; `setProject(spec)` is the goal interface; the PROJECT rung consumes the
  look-ahead queue.
- **travel** — `run(job)` routes travel legs to `deps.travel`; craft/mine/build to skills.
- **safety guards** — survival/panic/dangerscan/dig/reach/tool guards + a base-protection
  filter (`isProtected` / harvest-exclusion).

## Field-test findings (real bugs, do not re-discover)

The live from-empty runs proved the engine's *logic* and surfaced real *robustness* bugs:
1. **Axe-craft step was silently dropped** — the look-ahead ran only the first work-leg of
   a multi-leg chain, so `craft_wood_tools` made a pickaxe but never the axe, then the chop
   phase demanded an axe that didn't exist. *(Fixed: flatten each chain's legs into
   per-leg jobs.)*
2. **Crafting table dropped / not reused** — the bootstrap placed a table, then dropped it,
   so the next craft had none; and it did not reuse an existing table. The starter table
   must **persist, be reused, and be registered protected**.
3. **Tier-assert gap** — `ensureTool('stone_pickaxe')` returned "not needed" because a held
   *wooden* pickaxe satisfied the pickaxe *class*; the tool spec must assert the **tier**.
4. **Travel/reachability is the reliability wall** — the bot arms at the ~30 b minimum and,
   if no forest is right there, drifts / stalls instead of searching wider or relocating.
5. **Toolchains freeze instead of recover** — a failed leg (no table, no reachable tree)
   should *recover* (re-establish the precondition / relocate / retry) then fail with a
   *specific typed reason*, never freeze silently.
6. **Saved inventory per username** — reusing a bot name keeps its prior inventory; only
   death (drop) or deposit empties it. A clean from-zero test needs a genuinely empty bot.

The unifying root of 3/4/5 is **thin perception** — the engine decides with too little
world-awareness. Build the perception/world-state layer (see ROADMAP) and these collapse.
