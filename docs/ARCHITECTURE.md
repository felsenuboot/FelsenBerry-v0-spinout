# Execution Architecture — Andy planner + deterministic executor

**Task:** design the RUNTIME that sequences deterministic tool-chains with look-ahead
and interrupts, driven by a local-LLM (Andy) planner, built maximally on what already
exists. Research-first per Felix's directive.

**One-line answer:** almost everything Felix asked for **already exists** in three
codebases we own or have cloned — completion callbacks, the interrupt/reflex layer, the
travel primitive, the craft/smelt chains, the typed-failure substrate, and the
"LLM-sets-goal-once" interface. The **one genuinely new piece** is the *speculative
look-ahead planner* (compute the next job while the current one runs). No existing
LLM-agent framework (mindcraft, Voyager) has it — they are all strictly sequential and
block on the LLM between every step, which is exactly the downtime we are removing.

Chain *contents* (get_wood, craft_tools, …) are catalogued separately by **chains-dev** —
this doc is the runtime that runs them and does not re-catalogue them.

---

## PART A — FINDINGS (what already exists)

### A1. Completion detection & callbacks

**mindcraft-ce — it awaits the skill promise directly. This is the reliable signal.**
- `src/agent/action_manager.js:105` — `await actionFn()`. The executor literally awaits
  the skill's Promise, so it knows the exact instant a job finishes. It then returns a
  structured verdict `{ success, message, interrupted, timedout }`
  (`action_manager.js:125`).
- `src/agent/commands/index.js:226` — `await command.perform(agent, ...args)`; every
  skill command (`!collectBlocks`, `!craftRecipe`, `!smeltItem`, …) resolves to a result
  string on completion. Skill implementations are `async` and resolve when done.
- **The "job done → fire next" hook already exists**: `bot.emit('idle')` is emitted the
  moment an action finishes (`action_manager.js:121`), and the handler
  (`agent.js:493-502`) waits 1 s then calls `actions.resumeAction()`. That's the seam to
  hang a "pop next queued job" on.
- **Loop-guard**: `action_manager.js:64-81` kills runaway re-execution (>5 actions in
  <20 ms windows) — worth keeping the idea.

**Baritone — NO synchronous completion signal; the adapter already solved this.**
- `notificationOnPathComplete` is a desktop toast the headless box can't deliver
  (`SMOKE.md:259-261`). Baritone prints *nothing* on arrival.
- The adapter polls `msg #proc` for `No process in control`, requiring **two consecutive
  idle reads** so a gap between path segments isn't mistaken for done
  (`adapter.mjs:431-451`).
- Critical subtlety: "No process in control" fires on **give-up** exactly as on
  **arrival**. So every `/goto` is **graded against real position afterwards**
  (`verifyArrival`, `adapter.mjs:460-477`) — measured: a goto reported "done" in 15 s
  without the body moving (`adapter.mjs:44-45`, `SMOKE.md:290-292`).
- Net: `POST /goto {x,z,wait:true}` is an **awaitable travel primitive that returns a real
  `job.arrived` boolean** (`adapter.mjs:503-507, 934-939`). Same completion contract as a
  mineflayer skill promise. Position via waypoint-file parse; inventory via the `gui`
  screen dump (`adapter.mjs:793-816`).

### A2. The interrupt / reflex layer

**mindcraft modes = a working reflex layer, but WE ALREADY HAVE A BETTER ONE.**
- `src/agent/modes.js:24-304` — modes run every 300 ms tick (`agent.js:508-526`). Each
  declares `interrupts: ['all']` or `['action:followPlayer']`. Roster:
  `self_preservation` (fire/lava/drown/low-HP), `unstuck`, `cowardice` (flee hostiles
  ≤16), `self_defense` (fight ≤8), `hunting`, `item_collecting`, `torch_placing`,
  `elbow_room`, `idle_staring`, `cheat`.
- **Preemption mechanism** (reusable idea): a mode calls `execute()` (`modes.js:306`) →
  `actions.runAction()` → `_executeAction` → `await this.stop()` → `requestInterrupt()`
  (`agent.js:238-244`) sets `bot.interrupt_code=true` and stops pathfinder/pvp/digging.
  Interruption is **cooperative**: generated code is rewritten so every `;` becomes
  `; if(bot.interrupt_code) return;` (`coder.js:168`); built-in skills poll the flag.
- **Eat-when-hungry and flee-monsters that Felix wants ALREADY EXIST**: flee =
  `cowardice` mode; eat = the `mineflayer-auto-eat` plugin, not even a mode
  (`agent.js:195-200`, `autoEat.enableAuto()`, minHunger 14). **We do not build these.**
- Resume after interrupt: mostly **re-prompts the LLM** (`modes.js:317-329`,
  `should_reprompt`) rather than auto-resuming; only a single stored `resume_func`
  (`action_manager.js:44-59`) re-runs one interrupted action on idle.

**Our `agenda.js` is the interrupt layer we should build on — it subsumes modes and costs
zero tokens.** `agenda.js` is a **10-rung priority ladder** (subsumption architecture),
evaluated top-down, first-fire-wins, every 2 s, **fully deterministic / zero-LLM**:
- `P0a REFLEX` (yield to `survival.js`), `P0b POSTURE` (danger), `P1a EAT_CRITICAL`,
  `P1b DEPOSIT` (freeSlots≤2), `P1c EAT` (food≤17), `P1d TOOL` (missing/dur≤15%),
  `P1e RESTOCK`, `P1f LIGHT` (dark+carrying torches), `P2 PROJECT` (the assigned goal),
  `P3 IDLE`.
- Arbitration: higher preempts (reflex instantly, others after a 2-tick debounce);
  owner **latches** until `clear()` holds; per-rung **dual thresholds = hysteresis** to
  stop eat/mine/eat oscillation; lower never steals.
- It **explicitly subsumes `idleguard`** — "exactly ONE deliberative loop may exist," two
  fight over goals and produce GoalChanged loops (`agenda.js` header).
- Supporting reflex guards already exist: `survival.js`, `panicguard.js`, `dangerscan.js`,
  `digguard.js`, `reachguard.js`, `toolguard.js`.

→ **The agenda IS our modes-equivalent + interrupts + resume, deterministic and
token-free. mindcraft modes are a design reference only; we do not port them.**

### A3. Look-ahead / speculative planning — DOES NOT EXIST ANYWHERE

- **mindcraft:** strictly sequential. `self_prompter.js:65-83` — prompt LLM → execute →
  cooldown → prompt again. `handleMessage` (`agent.js:322-384`) is a sequential
  prompt→command→result loop. The LLM is on the critical path **between every action** —
  the exact latency Felix wants hidden.
- **Voyager** (arxiv 2305.16291): iterative prompting = generate code → execute → feed
  back errors → refine, then automatic-curriculum picks the next task **after** the
  current one verifies. Also sequential; no overlap of planning with execution.
- **Conclusion:** speculative "plan the next job while the current runs" is **the novel
  glue we build**. It is not in mindcraft or Voyager.
- **Pattern fit** (game-AI planning literature): the deterministic decomposition of a goal
  into an ordered primitive list is a **GOAP/HTN** job (goal → chain of primitives,
  computable locally, no LLM), and the reactive arbiter over it is **subsumption /
  utility** — which is exactly what `agenda.js` already is. So look-ahead = precompute the
  **next** HTN decomposition (or next project) during the awaited current-job promise.
  Because decomposition is deterministic, the common-path look-ahead needs **no LLM at
  all**; the LLM is only for goal-selection and novel failures.

### A4. How Andy drives decisions (prompt → action)

- `agent.js:259 handleMessage` → `prompter.promptConvo(history)` (`:325`) → `containsCommand(res)`
  regex `/!(\w+)(?:\(…\))?/` (`commands/index.js:29,334`) → `executeCommand` (`:367`) →
  result appended to history (`:372`).
- `self_prompter.js:66` feeds `"You are self-prompting with the goal '<X>'. Your next
  response MUST contain a command !commandName. Respond:"` — this is the self-drive prompt.
- `!newAction` → `coder.generateCode` (`coder.js:31-114`): LLM writes JS, staged into a
  locked-down SES compartment (`coder.js:189-201`), executed, up to 5 retries on
  lint/exec error.
- **Andy plugs in at `promptConvo`/`promptCoding` (the `Prompter`)** — swap the model
  backend to local Ollama. The `!commandName(args)` string is where LLM output becomes an
  action. **But** we drive it from the agenda's PROJECT rung, not mindcraft's sequential
  self-prompt loop (that loop is the anti-pattern).

### A5. Failure handling

- **mindcraft:** skill returns false / throws → `_executeAction` catch
  (`action_manager.js:126-149`) returns `{success:false, message: err+stack}`; that text
  lands in history (`agent.js:372`); the self-prompt loop **re-prompts the LLM** to decide
  retry/alternative. `coder.js:43-113` retries *codegen* 5× on lint/exec errors. **No
  deterministic fallback** — everything is "re-ask the LLM," i.e. LLM on the critical path.
- **Our `producer.js` is the right substrate for deterministic fallback:** it returns
  **typed failure codes** — VERIFIED against source (2026-09-01), the real set is
  `no_pickaxe | no_wood | no_fuel | no_space | unreachable | unproduceable | partial |
  error` (NOT the `no_coal_nearby`/`craft_failed` in producer.js's own stale header
  comment). Result shape is `{ok, made, how, steps[], reason}`. "A code to branch on, not
  a message string," with partial-success (`{ok:true, made:8}` of 16, reason `partial`)
  and **one-shot, no internal retry** (the ladder owns retry cadence + backoff). That is
  exactly what a deterministic fallback table consumes.

### A6. Capability composition (who does what)

| Capability | Provider | Interface / completion |
|---|---|---|
| Long-haul travel + ore-mine roam | **Baritone** `adapter.mjs` | `POST /goto {wait}`→`job.arrived`; `/mine`, `/halt`, `/pos`, `/inventory`; safety-fenced. NO crafting (`SMOKE.md:252`). HTTP 127.0.0.1:3109 |
| Short/local movement | mineflayer-pathfinder + `goto2.patch.js` | awaited promise |
| Craft / smelt / build / gather chains | our `skills.js` (`craftToolChain`:1768), `producer.js` (`produce`, typed failures) | awaited promise, typed result |
| Mid-level skill library (reference/borrow) | mindcraft `library/skills.js` (`collectBlocks`, `craftRecipe`, `smeltItem`, `placeHere`, `goToBed`…) | awaited promise |
| Reflex/interrupt arbiter | our `agenda.js` (+ survival/panic/dig/reach/tool guards) | 2 s deterministic ladder |
| Goal interface | `agenda.setProject()` | LLM sets once, zero tokens after |
| Bot process + HTTP control | our `runner.js` | `POST /eval`, skills injected |

**Baritone's gap** (no crafting, no geofence, no inventory API, tunnels bare 1×2) is
covered by mineflayer/skills.js and by the adapter's own fence
(`adapter.mjs:171-182, 942-971`). Use Baritone **only** as the `travel`/`mine-roam`
primitive; never for anything it can't grade.

---

## PART B — PROPOSED EXECUTION ARCHITECTURE

Five layers; four already exist, one is new.

```
            ┌─────────────────────────────────────────────────────────┐
 GOAL       │  ANDY (local LLM)  — sets the PROJECT once; re-engaged   │
 (rare,     │  only on project-complete or unrecoverable failure       │
  slow)     └───────────────┬─────────────────────────────────────────┘
                            │ agenda.setProject(goal)          [EXISTS]
            ┌───────────────▼─────────────────────────────────────────┐
 PLAN       │  SPECULATIVE PLANNER  (NEW GLUE)                          │
 (fast,     │  • deterministic HTN/GOAP decomposition of the project   │
 overlaps   │    into an ordered job list (tech-tree rules, no LLM)     │
 execution) │  • 1-deep LOOK-AHEAD queue: compute next job at current  │
            │    job START, so it's ready at current job's COMPLETION  │
            │  • failure → typed-code FALLBACK TABLE (producer codes)  │
            │  • only calls Andy when a rule/fallback is missing        │
            └───────────────┬─────────────────────────────────────────┘
                            │ next job (already computed)
            ┌───────────────▼─────────────────────────────────────────┐
 ARBITRATE  │  AGENDA priority ladder (P0..P3)         [EXISTS: agenda.js]
 (2s, det.) │  interrupts: eat / flee / deposit / tool / light preempt │
            │  the PROJECT rung with latch + hysteresis; resume after  │
            └───────────────┬─────────────────────────────────────────┘
                            │ run(job)
            ┌───────────────▼─────────────────────────────────────────┐
 EXECUTE    │  UNIFORM EXECUTOR FACADE  (thin GLUE)                     │
            │  run(job) -> Promise<{ok, made, reason}>                  │
            │   travel/mine → Baritone adapter HTTP   [EXISTS adapter]  │
            │   craft/smelt/build/gather → skills.js/producer [EXISTS]  │
            └───────────────┬─────────────────────────────────────────┘
                            │ await promise  (completion callback)
            ┌───────────────▼─────────────────────────────────────────┐
 COMPLETE   │  await skill promise  |  Baritone poll-#proc + grade pos │
            │  on resolve → tell PLANNER "done" → pop look-ahead queue  │
            └─────────────────────────────────────────────────────────┘
```

**How it hides LLM latency (the core requirement):**
1. Andy sets a project once (`setProject`) — slow, but one-time.
2. The **deterministic** planner decomposes it into an ordered job list with **no LLM
   latency at all** (tech-tree rules: e.g. `logs→planks→table→pickaxe→stone→…`). The
   common path never touches Andy.
3. When job *N* **starts**, the planner has already staged job *N+1* in the look-ahead
   queue. On job *N*'s completion callback, *N+1* fires **immediately** — zero gap.
4. The LLM is invoked **only** for (a) picking the next *project* and (b) re-planning when
   the deterministic fallback table is exhausted. Both are fired at a job *boundary* with
   a full job's duration to resolve behind — so even Andy's slow local latency is hidden.

**Interrupts:** already handled by the agenda ladder — eat (P1c/auto-eat), flee
(P0/survival + panicguard), deposit-when-full (P1b), tool-swap (P1d), lighting (P1f) all
**preempt the PROJECT rung**, latch until cleared, then the project resumes. We add nothing
here except making the PROJECT rung *consume the look-ahead queue* instead of recomputing.

**Failure fallback:** executor returns a typed `reason` (producer.js contract, real codes
above). The planner maps it deterministically: `no_fuel → splice a make-charcoal job
(smelt logs) or Baritone /mine coal_ore`; `no_wood → Baritone /goto another forest biome`;
`no_pickaxe → splice a craft_pickaxe job ahead`; `unreachable → Baritone /goto closer /
re-roam`; `no_space → deposit-to-base job first`. Only when the table has no entry does it
ask Andy to re-plan.

**Completion contract (uniform):** every job is a `Promise<{ok, made, reason}>`. skills.js
already resolves this way; the Baritone facade wraps `/goto {wait}` + `verifyArrival` into
the same shape. One `await` per job; on resolve, notify the planner and pop the queue.

---

## PART C — BUILD PLAN: reuse / glue / build-new

### REUSE — already exists, do NOT rebuild
- **Interrupt/reflex + resume layer** → `agenda.js` (10-rung ladder, hysteresis, latch,
  anti-flap). Already does eat/flee/deposit/tool/light. Subsumes idleguard.
- **Survival reflexes** → `survival.js`, `panicguard.js`, `dangerscan.js`, `digguard.js`,
  `reachguard.js`, `toolguard.js`.
- **Travel / mine-roam primitive** → `baritone/adapter.mjs` (`/goto {wait}`→arrived,
  `/mine`, `/halt`, `/pos`, `/inventory`, fenced, graded). Awaitable, honest verdicts.
- **Craft/smelt/build/gather chains + typed failures** → `skills.js` (`craftToolChain`),
  `producer.js` (`produce`). *(catalogued by chains-dev — reference, don't duplicate.)*
- **Goal interface** → `agenda.setProject()` (LLM sets once, ladder runs it token-free).
- **Local movement** → mineflayer-pathfinder + `goto2.patch.js`.
- **Bot process/control** → `runner.js` HTTP API + skills injection.
- **Completion-await pattern** → mindcraft `action_manager.js:105` (await the promise);
  Baritone `verifyArrival` (poll #proc + grade). Adopt the *pattern*, we already have both.
- **Andy prompt→command shape** → mindcraft `Prompter`/`self_prompter`/`coder` as
  *reference* for wiring Ollama; the `!cmd(args)` grammar.
- **(Optional borrow)** mindcraft `library/skills.js` skill impls if a chain is missing —
  but we largely have our own.

### GLUE — small, connects existing pieces
1. **Uniform executor facade** `run(job) → Promise<{ok,made,reason}>`: routes
   `travel|mine` to the Baritone adapter (HTTP client, wrap `/goto{wait}`+arrival into the
   promise shape) and `craft|smelt|build|gather` to skills.js/producer.js; normalizes the
   result/typed-reason. (~a thin module; runner.js + agenda already call skills.)
2. **Completion → next wiring:** on job-promise resolve, notify the planner and pop the
   look-ahead queue. Extend the agenda **PROJECT rung** to *consume a precomputed job*
   instead of recomputing each cycle.
3. **Failure → fallback table:** map producer.js typed codes → alternative jobs. A static
   table + a lookup; LLM only on a miss.

### BUILD NEW — the genuinely novel part (no framework has it)
1. **Speculative look-ahead planner + 1-deep queue.** Deterministic HTN/GOAP decomposition
   of the standing project into an ordered job list; compute job *N+1* at job *N*'s start;
   stage it so completion fires it with zero gap. **This is the core of Felix's ask** and
   the piece mindcraft/Voyager lack (both block on the LLM between steps).
2. **Andy planner integration (sparse):** wire local Ollama as the `Prompter` backend, but
   invoke it **only** at job boundaries for (a) next-project selection and (b) fallback
   re-plan when the deterministic table misses. Reference shape = mindcraft Prompter; we do
   **not** adopt its sequential self-prompt loop.
3. **The novelty gate:** the "is this common-path (deterministic) or novel (ask Andy)?"
   decision — keeps Andy off the critical path for everything the tech-tree rules cover.

### Reinvention flags (things to NOT do)
- **Do NOT rebuild an interrupt/modes system** — `agenda.js` already is one, and it's
  token-free; mindcraft modes would be a *downgrade* (per-tick, LLM-reprompt on resume).
- **Do NOT adopt mindcraft's `self_prompter` sequential loop** — it puts the LLM between
  every action; that is precisely the downtime we're eliminating.
- **Do NOT rebuild completion detection** — skills already resolve promises; Baritone is
  already polled-and-graded by the adapter.
- **Do NOT re-implement eat/flee** — auto-eat plugin + cowardice/agenda already cover them.
- **Do NOT use Baritone for anything it can't grade** (crafting, near-base work, exact
  inventory counts) — it has no crafting and no geofence.

---

## Sources
- Local: `mindcraft-ce/src/agent/{action_manager,modes,agent,coder,self_prompter}.js`,
  `commands/index.js` (line refs inline); `baritone/{adapter.mjs,SMOKE.md}`;
  `bots/{agenda.js,producer.js,skills.js,runner.js}`.
- Voyager: https://arxiv.org/abs/2305.16291 , https://github.com/MineDojo/Voyager
- Planning patterns: https://www.davideaversa.it/blog/choosing-behavior-tree-goap-planning/ ,
  https://tonogameconsultants.com/game-ai-planning/
