# CHAINS.md — Tool-Chain Library (classical progression, capped at diamond)

**What this is.** Named, reusable macros so a CHEAP/SMALL model puppets the bot by
SELECTING a chain by name (+ minimal params) instead of reasoning every primitive step.
**Scope (pinned by Felix): the classical progression, CAP AT DIAMOND — no Nether.**
The tool/armor tier ladder up to full diamond gear, the food/living loops (hunt→cook,
farm wheat→bread, apples, optional fishing), and base/house building.

**Every chain is a COMPOSITION over two substrates. This is the core rule.**

| Substrate | Is | Does | Cannot |
|---|---|---|---|
| **`[BARITONE]`** travel | the Baritone sidecar, HTTP `127.0.0.1:3109` (`adapter.mjs`) | A→B travel (`POST /goto`), quota ore-mining in a remote zone (`POST /mine`) | craft, smelt, build/place, geofence around base, per-block inventory logic |
| **`[SKILL]`** work | mineflayer skills — `skills.js` / `producer.js` / `farmskills.js` (and mindcraft-ce) | craft, smelt/cook, build/place, equip, farm, gather-in-place, torch, drop-sweep | efficient long-haul pathing (its A* times out on long/vertical hauls — that's why travel is Baritone's) |

> **Substrate assignment is not optional.** Any "go to X / go to base / go mine at Y" leg
> routes through **Baritone `POST /goto`**, never `mcp__minecraft__move-to-position`. The
> raw MCP move primitive is fine for *discovery* (this doc's work-primitive evidence was
> gathered that way) but a **codified travel leg MUST name Baritone.** Work done *at* the
> spot (craft/smelt/build/farm/place) routes through the `[SKILL]` layer. Each chain reads
> as: `[BARITONE] travel to the spot` → `[SKILL] do the work there`.

Aligns to arch-research's composition facade `run(job)` → Baritone for travel, skills for
work. The cheap model emits chain names; `run(job)` dispatches each step to its substrate.

---

## Baritone travel/mine substrate — the exact surface (from SMOKE.md + adapter.mjs)

HTTP on `127.0.0.1:3109`. Verified in-world 2026-09-01 (bot GrubenGuenther, SMOKE.md).

- `POST /goto {x, z}` or `{x, y, z}`, `+ {wait:true, waitMs, timeoutMs, break?}` →
  `{ok, job}`; **`job.arrived` is HONEST** (graded against real position, `dist≤4`⇒true;
  returns `failed, N blocks short` rather than lying). Omit `y` for an XZ goal (the right
  default for long-haul — an exact-block goal often has no legal no-break path). `break`
  defaults **false** (legit travel, `allowBreak` off); `break:true` is fence-gated (both
  ends must clear `GOTO_BREAK_MIN_DIST` from base).
- `POST /mine {block, quota, wait:true}` → full loop **find→path→break→pick-up→quota**
  (verified: `#mine 3 dirt` clean end-to-end). **Fence-gated**: refuses unless the body is
  already far from base (Baritone has NO geofence and will tunnel back to the nearest
  cached ore — so you `POST /goto` OUT to a remote zone first). **Needs the right pickaxe
  in inventory** (bare-handed on stone-tier ore breaks it for no drop and loops forever).
- `POST /halt`, `POST /stop-client`, `POST /set {name,value}`, `GET /pos`,
  `GET /inventory` (read-only screen scrape — no stack counts), `POST /say`, `POST /launch`.
- Completion edge: adapter polls `#proc` for `No process in control` AND grades position.
- **Aesthetics doctrine (SMOKE.md §6):** keep `allowBreak false` by default; pre-seed
  `allowOnlyExposedOres true` + `backfill true`; never `/mine` within ~150 blocks of base.

> **⚠ Open integration question for arch-research (flagged, not resolved here).** The
> Baritone sidecar is its OWN HeadlessMC client/body (GrubenGuenther); the `[SKILL]` work
> layer is a mineflayer body (this session drove KackboonKevin). A chain that says
> "Baritone travels, skills work *there*" assumes ONE body does both legs. Whether that's
> one body hosting both, or two coordinated bodies with a handoff, is the facade's call.
> The chains below are written substrate-first so they hold under either resolution, but
> the hand-off point is real and must be designed. This is the top thing `run(job)` owns.

**WHEN vs HOW split:** PLAYER_PLAYBOOK.md owns the WHEN (thresholds, tier ladder, depths,
food/base triggers). This file owns the HOW (the concrete substrate compositions).

Classification per step: **DET** = pure-deterministic (cheap model just fires it);
**JUDGMENT** = model supplies a param / makes a call.

---

# PART A — THE TIER SPINE (capped at diamond)

Playbook §1.3a ladder: wood → stone → iron (@Y≈16) → **diamond (@Y≈−59) = CAP**.
Armor is folded in at each tier as materials allow. **No goal past full diamond gear.**

### A0. `bootstrap_first_wood` — the TRUE DAG ROOT for a from-scratch bot
**Chicken-and-egg (confirmed live by engine-v1):** `chopTrees` HARD-REQUIRES an axe —
`skills.js:2938` calls `ctx.ensureTool('axe')` up front and THROWS `tool_missing` if it
can't get one. But an axe needs wood, and wood comes from chopTrees → **deadlock from a
zero-inventory bootstrap.** The only zero-bootstrap wood path in the engine is
`craftToolChain`'s **one sanctioned hand-on-log** (`skills.js:1738`) — the classical
"punch a tree by hand to make your first tools" step.
- `[BARITONE] POST /goto {tree_xz, wait:true}` — travel to stand **within reach of a log**.
  *This is a hard requirement, not a nicety:* the hand-dig needs the body at a log inside
  the `MAX_ABOVE=10` vertical reach band, and `goto2`/`ashfinder` repeatedly dropped the
  bot in dips **~15–21 blocks short** of a reachable log. **Another concrete travel=Baritone
  data point** — Baritone's honest `job.arrived` grading is what makes this leg reliable.
- `[SKILL] craft_wood_tools` via `craftToolChain`'s sanctioned hand-dig → a few logs by
  hand → planks/sticks/table → **first axe (+ pickaxe)**. (DET given a reachable log.)
- **Success:** a `wooden_axe` exists. **Then and only then** A1 `get_wood` runs efficiently.
- **Classical order:** punch wood → wood tools → bulk-chop. A0 = punch wood + wood tools;
  A1 = bulk-chop.

### A1. `get_wood(quota=?, species=any)` — VALIDATED (work legs in-world)
Bulk-gather logs. **PRECONDITION: an axe in inventory** — `chopTrees` throws `tool_missing`
without one, so run A0 first on a from-scratch bot (the real DAG entry is A0, not this).
- `[BARITONE] POST /goto {tree_xz, wait:true}` — travel to a tree stand (JUDGMENT: which
  stand; avoid base infra). Same reach-band caveat as A0 → Baritone, not `move-to-position`.
- `[SKILL] chopTrees` — flood-fills the whole connected tree bottom-up, **sweeps all
  drops, replants saplings**. (DET, *given the axe precondition holds*.) *Also yields the
  occasional apple drop → feeds B-Food.*
- **Success:** `oak_log`(species) count ≥ quota. *Evidence: MCP-primitive proof 0→3 logs.*
- **Overlap/why-skill:** raw `dig-block` loses drops if not foot-adjacent; `chopTrees`
  doesn't. Use the skill, never hand-rolled digging.

### A2. `craft_basics` — VALIDATED
logs → planks → sticks → crafting_table (placed).
- `[SKILL]` `craft-item oak_planks` → `stick` → `crafting_table` → place it (`ensureTool`
  and the internal `craftToolChain` compute the real per-species plank+stick bill). (DET
  except the table-placement cell = JUDGMENT: air-over-solid, open ground, `look-at` first.)
- **Success:** table block verified via `get-block-info`. *Evidence: table placed
  (-1,111,4), verified.*
- **No travel leg** — done in place.

### A3. `craft_wood_tools` — VALIDATED
- `[SKILL] ensureTool pickaxe` + `ensureTool axe` (tier auto = best affordable = wooden
  here; table in reach). (DET.)
- **Success:** wooden_pickaxe/axe +1. *Evidence: crafted both with the placed table.*

### A4. `get_stone(quota=?) → craft_stone_gear` — VALIDATED
Mine cobble → stone tools + weapons (+ shield).
- `[BARITONE] POST /goto` to exposed stone / a shallow cut (often a no-op near base). Deep
  strip is NOT needed for stone — surface/shallow stone suffices.
- `[SKILL] mineLane stone quota:N` — **vein-follow + drop-verify** (re-mines/re-collects
  until drops are actually in inventory → this is the fix for the drop-loss gap). (DET.)
- `[SKILL] ensureTool` for `stone_pickaxe`, `stone_axe`, `stone_sword`; craft a `shield`
  (needs 1 iron — defer to A6 if no iron yet). (DET.)
- **Success:** cobblestone ≥ N; stone tools +1 each. *Evidence: 3 stone→cobble; stone_pickaxe crafted.*
- **WHEN:** playbook — do this the moment wooden tools exist; upgrade eagerly.

### A5. `make_furnace` + `armor_leather?` — VALIDATED (furnace)
- `[SKILL]` craft `furnace` (8 cobble, table in reach) → equip → `look-at` → place. (DET
  except cell = JUDGMENT.) **Check BASE.md first** — reuse a base furnace, don't spam new
  ones (basekeeping.js / no-duplicate-infra lease).
- Early leather armor (optional, pre-iron): `[SKILL] huntAnimals cow` (see A-Food) →
  craft leather pieces. Low priority; iron armor (A6) is the real armor tier.
- **Success:** furnace verified. *Evidence: furnace placed & verified (-2,111,4) and (-7,85,28).*

### A6. `get_iron → smelt → craft_iron_gear` (tools + weapons + ARMOR) — VALIDATED (mine+smelt)
Iron at **Y≈16** (playbook §2.9). Full iron kit: pickaxe, sword, axe, shovel, **helmet /
chestplate / leggings / boots** (needs 24 iron for full armor + tools).
- `[BARITONE] POST /goto {remote_xz, wait:true}` — travel OUT to a mining zone clear of
  base (fence requires it before `/mine`).
- `[SKILL] safeDescend toY:16` — 45° staircase down (not pillar-drop; stops at lava/voids;
  torches as it goes) to bring the body to the iron band. *(Baritone `/mine` can also
  self-descend, but `safeDescend` gives a controlled, re-usable shaft — playbook §2.8.)*
- `[BARITONE] POST /mine {block:"iron_ore", quota:N, wait:true}` — path→break→**pick-up**→
  quota. **Precondition: a stone+ pickaxe already in inventory** (hand it via A4 first —
  Baritone can't craft). (DET given pickaxe + remote position.)
  - *Alt if staying on the mineflayer body:* `[SKILL] mineLane iron_ore quota:N` (deepslate
    aliases + drop-verify). Pick one substrate for the mining leg per the facade.
- `[BARITONE] POST /goto {base_furnace_xz}` → return to base to process (playbook §2.2).
- `[SKILL]` smelt raw_iron at the furnace (loop until input consumed AND all outputs taken
  — the raw `smelt-item` returns after the FIRST output). `[SKILL] ensureTool` iron tier
  for each tool; craft the 4 armor pieces. (DET given ingots + fuel.)
- **Success:** iron_ingot +N; iron tools/armor crafted. *Evidence: 2 raw_iron mined
  adjacent + swept; smelted → iron_ingot 1→2 (2nd stranded in furnace = the poll-loop point).*
- **WHEN:** playbook line 5 — secure iron pick+sword+armor before chasing diamond.

### A7. `get_diamond → craft_diamond_gear` = **CAP** — SPEC (not driven this session)
Diamond at **Y≈−59** (deepslate; playbook §2.1/§2.9). Needs an **iron pickaxe** (A6).
- `[BARITONE] POST /goto {remote_xz, wait:true}` — OUT to a mining zone far from base.
- `[SKILL] safeDescend toY:-59` — controlled staircase to the deepslate diamond layer
  (kit = 'deep' below y0; stops at lava — critical this deep). (JUDGMENT: lava/void
  handling is the risk surface; escalate on a stop.)
- `[BARITONE] POST /mine {block:"diamond_ore", quota:N, wait:true}` — **iron pickaxe
  required in inventory** (stone can't mine diamond → drops nothing → infinite loop, the
  exact SMOKE.md no-tools failure). Pair with `allowOnlyExposedOres true` for aesthetics.
- `[BARITONE] POST /goto {base_xz}` → home.
- `[SKILL]` craft diamond pickaxe, sword, axe, shovel, + 4 armor pieces (needs 24 diamond
  for full armor+tools; a human settles for pick+sword+armor first — playbook).
- **Success:** diamond gear crafted. **Then STOP** — do NOT derive any goal past this
  (no diamond-pick→obsidian→Nether, no enchant-grind end-game; playbook ⛔ PRE-NETHER CAP).
- **Class:** mining/craft DET given the pickaxe; **descent safety + lava is the JUDGMENT**.

---

# PART B — FOOD / LIVING (parallel to the spine, sustaining play)

Playbook §2.5 (food) + §1.3b. Runs whenever hunger/food-store thresholds fire.

### B1. `hunt_and_cook(species=cow|pig|chicken, quota=?)` — hunting as its own chain
- `[BARITONE] POST /goto {herd_xz}` — travel to where animals are (JUDGMENT: find a herd;
  `find-entity`/scan picks the spot). *Often a short hop; big roams use Baritone.*
- `[SKILL] huntAnimals {species, count}` — attack on the weapon cooldown, **collect all
  drops, NEVER targets players**. (DET given the herd; **weapon should be best sword** —
  `ensureTool sword` first.)
- `[BARITONE] POST /goto {base_furnace_xz}` — home to cook (or place a campfire in place).
- `[SKILL]` cook raw meat in the furnace/campfire (smelt raw_beef→cooked_beef; same
  poll-until-done loop as A6 smelting). (DET.)
- **Success:** cooked_* count up. **Overlap:** `huntAnimals` exists; the cook leg is the
  furnace-smelt work primitive (no dedicated `cook` skill — see GAP-C).

### B2. `farm_wheat → bread` — VALIDATED PATH (skill exists)
- `[BARITONE] POST /goto {farm_xz}` — travel to the field (base farm plot from BASE.md).
- `[SKILL] farmCycle` — ONE pass: harvest ripe crops, sweep drops, replant empties
  (re-tilling reverted soil), **optionally bake bread at a wheat threshold**, optionally
  deposit. A no-ripe pass is a fast no-op (safe to fire repeatedly). (DET.)
- `[SKILL] tillFarmland` / `harvestGrass` — to CREATE a field / gather seeds the first time. (JUDGMENT: field siting.)
- **Success:** wheat/bread count up; empties replanted. **WHEN:** playbook — passive food;
  fire on a timer or when food store low.

### B3. `get_apples` — folded into A1
- Apples drop from oak leaf decay while running `[SKILL] chopTrees` (A1). No separate
  travel/work leg — it's a byproduct. Success: `apple` count rises during wood runs.

### B4. `fish` (OPTIONAL, low priority)
- `[BARITONE] POST /goto {water_xz}` → `[SKILL]` equip fishing_rod, use-on-water, collect.
  Include only if a cheap fishing work-primitive exists; **not required for the loop.**
  (Currently no dedicated fishing skill → deferred; see GAP-C.)

---

# PART C — BASE / HOUSE BUILDING

Playbook §3 (base lifecycle) + §3.5 (build blueprints). "How to build a house" as a chain.

### C1. `build_house` (walls + roof + door + light + bed) — VALIDATED PRIMITIVE (placement)
The composition of the engine's build skills into a real shelter.
- `[BARITONE] POST /goto {build_anchor_xz}` — travel to the (flat, clear) build site.
  (JUDGMENT: site selection — playbook §3.2 base-siting: flat, near water/wood, not on the plaza.)
- `[SKILL] buildFloor {from,to,material}` — lay the footprint. (DET given the rectangle.)
- `[SKILL] frameStructure {origin,w,l,h,door:true,roof:true}` — log corner posts + plank
  infill on the perimeter, a **real doorway gap, flat roof, interior floor**. This IS the
  "looks like a human built it" primitive (idempotent, verifies every block, restocks from
  a supply chest). (DET given dimensions.)
- `[SKILL]` place a **door** in the gap, place **torches** inside+out (light ≥ the
  mob-spawn threshold, playbook §2.6/§3.3), place a **bed** (craft from 3 wool + 3 planks;
  wool from `huntAnimals sheep` or shearing). (DET; door/bed placement cells = light JUDGMENT.)
- **Success:** every intended cell reads back correct (block-by-block verify pass);
  enclosed, lit, a bed to set spawn. *Evidence: placement primitive proven — 2×2 cobble
  wall face, 3 blocks placed (stack via `down`, cantilever via neighbor-face) all verified.*
- **Overlap:** `buildWall`/`buildFloor`/`frameStructure`/`buildSchematic`/`buildStaircase`
  already do idempotent, verified, human-looking placement. The chain = sequence them +
  door/light/bed. **Never hand-roll `place-block` for a real build.**

### C2. `build_staircase` / shaft — helper for A6/A7 descents
- `[SKILL] buildStaircase toY` — human-looking real stair blocks + torches + optional rail
  (the built counterpart to `safeDescend`'s raw dig). Use for a permanent base→mine shaft.

---

## Cheap-model orchestration interface (two-substrate)

The cheap model emits a **chain name + minimal params**; the deterministic `run(job)`
executor owns everything below:

```
{ "chain": "get_iron", "args": { "quota": 24 } }
{ "chain": "build_house", "args": { "origin": [x,y,z], "w": 7, "l": 5, "h": 3 } }
```

`run(job)` per step:
1. **Precondition gate** — auto-insert prerequisite chains along the fixed DAG. The real
   root for a zero-inventory bot is the **hand-dig bootstrap**, NOT `chopTrees` (which
   throws `tool_missing` with no axe — confirmed live):
   `bootstrap_first_wood (hand-dig → wood tools) → get_wood(bulk-chop) → craft_basics →
   {get_stone→stone_gear, make_furnace} → get_iron(→iron_gear) →
   get_diamond(→diamond_gear=CAP)`; food/farm/build hang off it. (e.g. `get_wood` with no
   axe auto-runs `bootstrap_first_wood` first; `get_iron` with no stone pickaxe auto-runs
   `craft_stone_gear`; Baritone `/mine` with no pickaxe is a hard precondition — hand it
   one via a `[SKILL]` leg.)
2. **Dispatch each step to its substrate** — `[BARITONE]` legs → `POST /goto|/mine`
   (block on `wait:true`, read the honest `job.arrived`); `[SKILL]` legs → the mineflayer
   skill. This tagging IS the facade.
3. **Success check** — inventory/`get-block-info` delta, or `job.arrived`.
4. **Escalate to the model ONLY on failure** — a Baritone `arrived:false` / `/mine` loop /
   a build-verify miss hands back the specific failure so the model supplies the one
   missing judgment. Successes stay out of context.

**The JUDGMENT surface the cheap model actually pays for (everything else is DET):**
- **Target/site selection** — which tree/herd/vein/build-site, avoiding base infra.
- **Remote-zone choice for `/mine`** — Baritone has no geofence; the model (or a fixed
  zone list like FEL-BT-1) must place the body far from base first.
- **Descent safety** — lava/void on the way to Y≈16 / Y≈−59 (the diamond leg's real risk).
- **Quotas & tier targets** — numbers, and "stop at diamond."

**Emit skill/endpoint names, don't re-implement.** Travel legs → Baritone endpoints;
work legs → these exact skills: `chopTrees, mineLane, ensureTool, safeDescend, buildStaircase,
buildFloor, buildWall, frameStructure, buildSchematic, huntAnimals, farmCycle, tillFarmland,
harvestGrass, produce, collectDrops, restock, depositToChest`. `skills.js` (via `S.define` +
`validate` + `kit`/`tool` auto-provision + drop-verify) IS the work executor.

Chain → substrate map (quick reference):

| Chain | Travel `[BARITONE]` | Work `[SKILL]` |
|---|---|---|
| bootstrap_first_wood (DAG root) | /goto to a reachable log (reach band) | craftToolChain hand-dig → first axe |
| get_wood (needs axe) | /goto tree | chopTrees |
| craft_basics / wood/stone/iron/diamond tools | — | ensureTool (+craftToolChain) |
| get_stone | /goto (shallow) | mineLane stone |
| make_furnace | — (reuse base infra) | craft+place furnace |
| get_iron | /goto remote + /mine iron_ore | safeDescend, smelt |
| get_diamond (CAP) | /goto remote + /mine diamond_ore | safeDescend, craft |
| hunt_and_cook | /goto herd, /goto furnace | huntAnimals, smelt-cook |
| farm_wheat→bread | /goto farm | farmCycle (tillFarmland/harvestGrass) |
| build_house | /goto site | buildFloor, frameStructure, torch, door, bed |

---

## GAPS — what the chain library must add on top of the substrates

- **GAP-INT (top): one-body-vs-two-body handoff is unresolved.** Baritone (GrubenGuenther,
  HeadlessMC) and the `[SKILL]` layer (mineflayer) are different bodies. The
  travel→work handoff needs a designed mechanism (one body hosting both, or two bodies with
  a rendezvous). Owned by arch-research's `run(job)`; every composition above depends on it.
- **GAP-1 — drop collection on the WORK layer.** Raw `dig-block` only auto-collects when the
  drop lands ~1 block away (proven: 3 coal_ore mined into a cave wall → 0 collected). SOLVED
  by using `mineLane` (drop-verify) / `collectDrops` for any mineflayer digging, and by
  Baritone `/mine` (which picks up + honors a quota). **Never hand-roll `dig-block` for gathering.**
- **GAP-2 — never hand a buried-ore coordinate to `move-to-position`.** The mineflayer A*
  can't dig and times out (proven: 25 s timeout to iron through rock; stuck on a 3-block
  cliff, no auto-pillar-up). All travel-to-depth goes through Baritone `/goto` + `safeDescend`.
- **GAP-3 — Baritone has no geofence and needs a pickaxe.** `/mine` will tunnel to the
  nearest cached ore (even under the plaza) → the chain MUST `/goto` to a remote zone first
  and keep `allowBreak false` at base; and MUST ensure the correct-tier pickaxe is in
  inventory before `/mine` (stone for iron, iron for diamond).
- **GAP-4 — smelt/cook returns after the first output.** Batch smelting strands the rest in
  the furnace; there's no take-from-container primitive. The smelt/cook work leg must
  loop/poll until input consumed AND all outputs pulled.
- **GAP-5 — placement quirks.** `place-block` auto-picks the first placeable item (equip the
  target block first) and fails "no reference block" in tight spaces (needs open ground +
  `look-at`). All handled inside `frameStructure`/`buildWall`; don't hand-roll builds.
- **GAP-C — missing work skills for the food/build loop.** No dedicated `cook`, `fish`,
  `placeBed`, or `placeDoor` skill was found — cooking currently piggybacks the furnace
  smelt path; bed/door/torch placement piggybacks generic place-block. These are the
  concrete `[SKILL]`-layer additions `build_house`/`hunt_and_cook` need to be one-call chains.

---

## Evidence log (WORK-substrate, KackboonKevin via MCP, 2026-09-01)

Work primitives driven & verified in-world (travel legs are SPEC'd to Baritone per SMOKE.md,
not re-driven this session — Baritone is a separate client):
- get_wood: oak_log 0→3 (tree 0,110,-2). craft_basics: 3 logs→12 planks, table placed
  (-1,111,4) verified. wood_tools: wooden pickaxe+axe crafted. get_stone: 3 stone→cobble
  (drops swept). stone_tools: stone_pickaxe crafted. make_furnace: furnace placed & verified
  (-2,111,4) and (-7,85,28). get_iron: raw_iron 0→2 (mined adjacent, swept by stepping on
  cell). smelt: 2 raw_iron+1 coal → iron_ingot 1→2 (2nd stranded → poll-loop point).
  get_coal: 3 coal_ore mined but DROPS LOST (wall-mined over cave → the GAP-1 proof).
  build: 2×2 cobble wall face, 3 placements all verified (stack `down`, cantilever `north`).
- Pathing (why travel must be Baritone): mineflayer move-to buried iron timed out (25 s);
  y85→y111 climb needed 4 chunked calls and still stranded the bot at a 3-block pit wall.
- Baritone travel/mine evidence: SMOKE.md — `/goto` 40/80 blocks PASS (honest arrival
  grading, `failed N short` when no path), `/mine 3 dirt` full loop PASS, `/stop` ~1 tick.
