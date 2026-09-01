# PLAYER_PLAYBOOK — the human mental model, as a decision tree

**Purpose.** This is the *layer above* the low-level tool-chains (`CHAINS.md`) and
above the runtime plumbing (planner/interrupts/callbacks). It answers the question a
good human answers implicitly every few seconds: **given my situation, what do I do
next, and why?** It is written on paper, deliberately unbiased by "what's easy to
script," then mapped back to the engine at the end.

**Central thesis (Felix's).** Most of what looks like "smart human play" is not
judgment — it is a stack of **deterministic threshold rules** evaluated in priority
order. The LLM is needed only for a small set of genuinely open choices. Section 4
does the honest accounting: by rule-count the split is roughly **~85% deterministic
thresholds / ~15% judgment**, and by *wall-clock time in a normal session* it's more
like **97% deterministic** — judgment fires rarely.

All thresholds below are for **Java Edition 1.18+** (the mob-spawn light rule and the
diamond Y-level both changed at 1.18; getting these wrong silently is a classic bot
bug). Numbers are cited in Section 5.

---

## 1. The core decision loop

A human runs this loop continuously. Model it as a **priority ladder**: evaluate
top-to-bottom, execute the first branch that fires, then re-evaluate from the top. The
top of the ladder is *reflexive safety* (interrupts that pre-empt whatever you're
doing); the bottom is *goal pursuit* (what you'd do if nothing is wrong). This ordering
is the whole game — a bot that mines diamonds while starving is not "focused," it's
broken.

```
EVERY TICK-GROUP (~4 Hz is plenty), from the top:

┌─ P0  SURVIVAL REFLEX  (pre-empts everything, including combat) ─────────────┐
│  health < 6 (3 hearts)  AND  taking damage      → DISENGAGE: wall up / flee │
│  in lava / on fire / drowning (air < 6)         → escape element NOW        │
│  falling into a drop > 3 high ahead             → stop, re-path             │
│  health < 6  AND  safe                           → wait & heal (see food)   │
├─ P1  IMMEDIATE THREAT  ────────────────────────────────────────────────────┤
│  hostile within 4 blocks                         → FIGHT if geared & hp>10  │
│                                                     else FLEE toward light  │
│  night + exposed on surface + mobs present       → retreat to base/wall up  │
│  creeper within 4 blocks                         → back off ≥5, then decide │
├─ P2  BODY MAINTENANCE  ────────────────────────────────────────────────────┤
│  hunger ≤ 6                                       → EAT now (can't sprint!) │
│  hunger ≤ 17  AND  health < max  AND  have food   → EAT (unlock regen)      │
│  no food at all  AND  hunger ≤ 10                 → goal := acquire food     │
├─ P3  KIT INTEGRITY  ───────────────────────────────────────────────────────┤
│  active tool durability < 10%                     → swap to spare / craft    │
│  active tool BROKEN mid-job                       → replacing it IS the job  │
│  no pickaxe at all while mining                   → abort to craft one       │
│  better tier of the current tool is craftable     → upgrade, then continue  │
├─ P4  LOGISTICS PRESSURE  ──────────────────────────────────────────────────┤
│  free inventory slots < 4                         → return to base, deposit  │
│  carrying valuables (ore/diamond) + far from base → consider early return   │
│  night falling (t≈12000) AND goal not urgent      → head home to sleep/smelt │
├─ P5  ENVIRONMENT DISCIPLINE  (cheap, do inline) ───────────────────────────┤
│  block-light where I stand/mine == 0             → place a torch            │
│  torch-cadence counter ≥ N since last torch       → place a torch            │
│  open item drop within pickup range               → grab it (rivals snipe)  │
├─ P6  GOAL PURSUIT  (the "what am I here for" layer) ────────────────────────┤
│  execute current GOAL's next chain step                                     │
│  (mine_lane / get_wood / smelt / build / haul-to-depot / farm / explore)    │
└─ P7  IDLE  (should almost never be reached) ───────────────────────────────┘
   pick next goal from the goal stack (see §1.3); never truly idle
```

### 1.1 Why priority-ladder and not a flat state machine
The same situation ("I'm in a cave") maps to totally different actions depending on
*orthogonal* axes — hunger, durability, inventory, light, time-of-day, threats. A flat
FSM explodes combinatorially. The ladder collapses it: each axis is one guard, and the
**first firing guard wins**. Humans do exactly this — a scary noise overrides hunger,
hunger overrides tidiness, tidiness overrides "keep mining."

### 1.2 The four "situation" inputs every branch reads
A branch condition is always some threshold over these:

| Axis | Cheap sensors | Typical thresholds used above |
|---|---|---|
| **Self** | health, hunger, saturation, air, on-fire, active-tool dur%, free slots | hp<6, hunger≤6/≤17, dur<10%, slots<4 |
| **World-local** | block-light here, nearby hostiles (dist), lava/gap ahead, drops nearby | light==0, hostile<4, creeper<4 |
| **World-global** | time-of-day, distance-to-base, biome/Y-level | t>12000 (dusk), Y for ore target |
| **Goal** | current goal, its progress, its resource target | goal-specific |

### 1.3 Goal arbitration (P6/P7 — the "what should I even be doing" question)
Below the reflex ladder sits a **goal stack**. A human doesn't re-derive their life
purpose each tick; they carry a current objective and a rough backlog. The engine
should too. Goal selection is *mostly* deterministic — a **needs-based priority order**,
like Maslow for a Minecraft bot:

```
1. SECURE THE NIGHT      no bed / no walls / no light at base   → build shelter
2. TOOL FLOOR            below stone-tier tools                  → get_wood→craft
3. FOOD SECURITY         < ~1 day of food in stock              → hunt/farm/cook
4. LIGHT & SAFETY STOCK  < ~16 torches carried                  → make coal+sticks
5. TIER PROGRESSION      not yet at the tier cap                 → advance the SPINE ↓
6. ASSIGNED / STANDING   the base plan, cooperation tasks, depot → do the work
7. OPPORTUNISTIC         surplus time                           → explore/expand base
```

Everything above line 6 is a **prerequisite gate**: you don't chase diamonds (line 5/6)
if you have no food (line 3) — you'd just die and drop them. This is the same logic as
the reflex ladder, one time-scale up. It is deterministic. **The only genuinely
open call here is line 7 and ties within line 6** — see §4.

#### 1.3a The TIER SPINE (line 5 expanded — ordered ladder, capped at diamond)
Line 5 is not a vague "progress" — it's a fixed, ordered ladder. Each rung's trigger is
"the previous rung is satisfied and this one isn't." **Advance one rung at a time; stop
at the cap.**

```
logs  →  crafting table  →  WOOD tools  →  STONE tools + weapons  →  armor
      →  IRON gear (tools+armor+sword)  →  DIAMOND gear (tools+armor+sword)  →  STOP
```

| Rung | Satisfied when | Next action |
|---|---|---|
| Logs | ≥ enough logs for the next craft | chop trees (§2.x / tree farm) |
| Crafting table | table placed at base | craft one |
| Wood tools | wood pick+axe+shovel(+sword) in kit | craft from planks/sticks |
| Stone tier | stone pick+axe+sword, better than wood | mine cobble → craft |
| Armor | at least leather/iron torso+legs (survivability) | hunt/smelt → craft |
| Iron gear | iron pick+sword+armor secured | mine iron @Y≈16 → smelt → craft |
| Diamond gear | diamond pick+sword+armor | mine diamond @Y≈−59 → craft |
| **CAP** | diamond gear complete | **STOP — do not plan past this (see cap)** |

> **⛔ PRE-NETHER CAP (current scope).** The spine **ends at full diamond gear**. Do
> **NOT** set or auto-derive any goal beyond it — specifically **no diamond-pickaxe →
> obsidian → flint&steel → Nether-portal → Nether** chain, no blaze/potion/enchanting
> end-game, no beds-as-explosive nether tricks. Once diamond gear is complete, line 5 is
> **done** and the bot falls through to line 6 (assigned/base work) and line 7
> (opportunistic: base expansion, farms, aesthetics, cooperation). This cap is a scope
> decision, not a game rule — it keeps the engine from wandering toward the Nether before
> we're ready to design that phase. When we lift it, this is the single place to edit.

#### 1.3b The LIVING loops (parallel to the spine, not after it)
The tier spine is the *progression* axis; alongside it run the *sustaining* activities a
human does continuously — these are **first-class goals, active from day 1**, not things
you do only once the spine is finished. They feed FOOD SECURITY (line 3) and the base
(lines 6–7), and each has its own trigger threshold:

| Living loop | Trigger to run it | Chain | Standing role |
|---|---|---|---|
| **Hunt (meat)** | food stock < ~1 day OR passive mobs nearby & no cooked meat | kill cow/pig/chicken → cook → eat/store | primary early food; first-class activity |
| **Wheat → bread** | have a base + hoe; bread stock low | build 9×9 field (§3.5B) → harvest → craft bread | staple, renewable, low-attention |
| **Apples** | opportunistic while chopping oak | collect apple drops from oak leaves | free food, no dedicated trip |
| **Fishing** *(optional)* | idle-safe time near water, low food, rod available | craft rod → fish | optional passive food/loot; skip if busy |
| **House / base build** | any base-stage trigger fires (§3.1) | build shell/room/farm (§3.5) | first-class — "how to build a house" is a goal, not a chore |
| **Animal pen (breeding)** | have surplus wheat/seeds + a hunted pair | fence pen (§3.5C) → breed → sustainable meat | converts one-off hunting into a renewable supply |

**How the two axes interleave:** the spine and the living loops share the *same*
priority ladder — FOOD SECURITY (line 3) sits **above** TIER PROGRESSION (line 5), so a
hungry bot hunts/farms *before* it goes back to mining iron. Base-building (a living
loop) surfaces via line 6's base plan and its stage triggers (§3.1). Nothing here is
past the cap; all of it is *pre-diamond, pre-Nether* sustaining play.

---

## 2. Habit playbooks

Short, threshold-driven. These are the "implicit habits a good player has that the
crafting recipe never tells you."

### 2.1 Mining discipline
- **Torch cadence.** Physics: since 1.18 hostiles need **block-light 0** to spawn; a
  torch is light 14 and drops 1 per block (taxicab). On open flat ground one torch
  covers ~13 blocks. **But walls and corners block light instantly**, so in a 1-wide
  corridor the safe rule is a torch **every 6–8 blocks**, and **one at every junction /
  corner** (light doesn't turn corners). Place on the **same side** consistently (see
  §2.7 — a human uses "torches on the right" as a breadcrumb to find the way out).
- **Light-check inline.** If `block-light == 0` where you're standing or about to mine,
  drop a torch regardless of the cadence counter. Cheap insurance; costs one torch.
- **Ore priority when a vein is exposed** (grab-order, because inventory & time are
  finite): diamond > emerald > gold/redstone(need iron pick) > iron > lapis > coal >
  copper. Always **mine the whole vein** before moving on,
  and **grab the drops** (never leave them — rivals snipe in seconds).
- **Strip vs branch.** Default to **branch mining**: a 1×2 main corridor, side branches
  **2 blocks apart** (2-spacing exposes every block face — no 1-wide vein can hide;
  3-spacing is faster but misses thin veins — only worth it if you're rich in time-cost
  terms). Branch length ~ until inventory/durability/torch supply says turn back.
- **Depth target.** For diamonds go to **Y ≈ −59** (deepslate layer; the old "Y=11" died
  with 1.18). For a first iron run, any exposed cave or Y 0–16 is fine.
- **Turn-back triggers** (any one → head to base): free slots < 4; active pickaxe
  dur < 10% and no spare; torches < 4 left; hunger ≤ 6 with no food; it's dusk and base
  is far. **Breadcrumb home**: mine in straight cardinal lines and keep a torch trail so
  the return path is deterministic, not a re-search.
- **Hazard reflex while mining.** Never dig the block directly *below* you into an
  unknown (fall/lava). Never dig straight *into* a wall at head height without checking
  for a fluid behind (mine the block, step back). If you hear/see lava, wall it off.

### 2.2 Smelting & storage routine (the "come home to process" loop)
The reason a base exists: raw ore is worthless until smelted, and you can't carry
forever. The habit loop:
```
mine out  →  return at a turn-back trigger  →  at base:
   1. dump raw ore into the furnace(s), fuel from coal stock
   2. while it smelts: deposit junk (cobble surplus, dirt, gravel) to bulk chest
   3. deposit valuables to their category chest (§3.4)
   4. restock the working kit: torches to 32+, food to full stack, a spare pickaxe
   5. collect smelted ingots → craft/upgrade any tool that's below best tier
   6. head back out (or advance the base plan if a build trigger fired)
```
Smelting is *batched* and *overlapped* with depositing — a human never stands watching
a furnace. Keep **fuel and raw ore stocked at the furnace** so a return is a 20-second
pit-stop, not a project.

### 2.3 Inventory hygiene
- **Keep a working kit, not a hoard.** Canonical kit: best pickaxe + spare, axe, shovel,
  sword, 1 stack of torches, 1 stack of cooked food, a stack of cobble/dirt (bridging &
  walling), crafting table, water bucket, the current job's output space.
- **Junk rules.** Drop or leave-unmined: excess cobble beyond ~1 stack, excess dirt/
  gravel/andesite/diorite/granite beyond a stack, rotten flesh (unless composting/trade),
  duplicate low-tier tools. **Deposit, don't drop, when near a base** (leaving drops
  invites rivals and clutter).
- **Free-slot floor.** Treat **< 4 free slots** as "inventory pressure" → return trigger.
  Below that you start auto-discarding lowest-value junk to avoid dropping *valuables* on
  pickup-overflow.
- **One-stack rule for building blocks in the field**: carry exactly what the current
  build needs plus a buffer; the rest lives in the storage room.

### 2.4 Tool lifecycle
- **Always carry the next tier's material** if cheap (a few extra ingots), so a break is
  a re-craft, not a trip home.
- **Replace before break, not after.** Swap the active tool at **dur < 10%**; a tool that
  breaks *mid-swing* stranded a real bot twice (see FEEDBACK). **A broken/near-broken
  primary tool outranks the current job** — replacing it *is* the task until done.
- **Upgrade eagerly.** The moment a better tier is craftable (stone→iron→diamond), make
  it and equip it; a human never mines iron with a stone pick if they have the ore.
- **Recycle.** Near-broken iron+ tools → keep for emergencies or smelt back to nuggets;
  don't clutter chests with 12 half-dead stone picks. **Enchanted/named tools are
  protected** — never auto-discard those.
- **Match tool to block** (speed + drops): pickaxe for stone/ore, axe for wood, shovel
  for dirt/sand/gravel, shears for leaves/wool. Wrong tool wastes durability and time.

### 2.5 Food & hunger management
Mechanics (Java): hunger and saturation are 0–20; **saturation ≤ hunger**; hidden
exhaustion 0–4 loops and drains saturation, then hunger. Regen gates:

| Hunger | Regen behavior | Sprint |
|---|---|---|
| 20 **and** saturation > 0 | fast: 1 hp / 0.5 s | yes |
| ≥ 18 | slow: 1 hp / 4 s | yes |
| ≤ 17 | **no natural regen** | yes |
| ≤ 6 | no regen | **cannot sprint** |
| 0 | starvation damage (to 10 hp normal / 1 hp hard) | no |

Rules:
- **Never let hunger sit ≤ 6** — losing sprint kills your ability to flee. Eat *before*
  a fight or a long trek if you're near that.
- **Eat to unlock regen**, don't eat to top a full bar (wastes food): if `health < max
  AND hunger ≤ 17 AND have food → eat`. To *heal*, you actually want hunger back to 18+.
- **Prefer high-saturation foods** for the kit (cooked meat, bread) over low-sat snacks
  (berries, cookies) — fewer eat-events, longer between refuels. Carry ~1 stack.
- **Food security is a goal** (§1.3 line 3): keep ≥ ~1 day of food in stock; if it drops,
  the goal layer schedules a hunt/farm/cook cycle *before* you're starving in the field.

### 2.6 Threat response (flee / fight / wall-up)
Decision, in order:
```
creeper < 4 and no way to safely melee   → back off ≥5 blocks; don't let it hiss on you
health < 10  OR  no weapon                → FLEE toward light / base; wall the gap behind
skeleton at range, open ground            → close distance behind cover, or wall & ignore
melee mob, hp>10, have sword+food         → FIGHT (strafe, hit-and-step-back)
swarmed / night ambush                    → WALL UP: pillar 2 up or box in 1x1, wait out
```
- **Wall-up is the universal safe default** when unsure: place blocks to make a 1×1×2
  pocket or pillar up 2–3; mobs can't reach, and you can eat/regen. Cheap, deterministic,
  almost never wrong.
- **Don't fight over nothing.** If the goal doesn't require the ground the mob is on,
  disengaging costs nothing. Fight only when cornered or when the drop/route matters.
- **Torch-proof the fight location** after winning so it doesn't re-spawn.

### 2.7 Wayfinding & self-rescue (the habit that prevents "lost bot")
- **Mine in straight cardinal lines**; never wander diagonally underground.
- **Torches on one consistent wall** = a directional breadcrumb (torches-on-your-left
  going in means they're on your right coming out).
- **Seal branches you've exhausted** or mark them, so you don't re-mine.
- **Water bucket** = the universal "I'm about to die to fall/lava" panic button.

### 2.8 Getting to depth — the staircase (not the pillar-drop)
A human does **not** dig straight down (fall/lava death) and does **not** just pillar
back up. They cut a **staircase** so the descent doubles as the return path for hauling
loot out.
- **Shape:** a **1-wide, 2-high** staircase, descending one step down + one forward per
  block (≈45°). Mine the block **ahead-low**, step into it, repeat. Keep 2 headroom so
  you can walk (and sprint) back up loaded.
- **Rule:** never mine the block *directly* under your feet; on a staircase you're always
  mining the block *ahead and below*, so an unseen lava pocket spills away from you, not
  onto you.
- **Light it:** a torch every ~6 steps on the same wall (breadcrumb + spawn-proof).
- **Landing:** at target Y, open a small 1×2 alcove — that's where the branch mine
  starts, and where you drop a chest/furnace for an on-site depot on long runs.
- **Faster alternatives (situational, judgment):** a 1×1 **ladder shaft** or a
  **water-drop shaft** (bucket at bottom to break the fall) descends quicker but is worse
  for hauling and for re-lighting; a good player uses the staircase for a *home* mine and
  a ladder/water shaft only for a quick scouting drop.

### 2.9 Mining-level cheat-sheet (where to strip-mine for what)
Java 1.18+ triangular ore distribution — dig the *main corridor at the ore's peak Y* and
branch from there. These are the target Y-levels a human keys off:

| Target | Best Y (dig here) | Notes |
|---|---|---|
| **Diamond, redstone** | **Y ≈ −59** | deepslate; also gold down here. Y=11 is dead post-1.18. |
| **Iron** (bulk, mid-game) | **Y ≈ 16** (band 15–20) | triangle peak at 16; fast (stone, not deepslate) |
| **Gold** | Y ≈ −16 and below | needs iron pickaxe to collect |
| **Copper** | Y ≈ 48 | |
| **Coal** | Y 45–136 (common, high up) | grab opportunistically; you need it constantly for torches+smelting |
| **Lapis** | Y ≈ 0 | |

Practical human rule: **one deep base-mine at Y≈−59** (diamonds + redstone + gold in one
corridor), plus **grab iron/coal on the way down** through the Y16 band. Don't cut a
separate tunnel per ore if one corridor's branches already sweep the layer.

---

## 3. Base lifecycle

A base is **grown, not planned all at once**. Each stage has a *trigger* (a condition
that makes the next stage worth the cost) and a small footprint. The habit is: build the
*minimum* that unblocks the current need, then expand when a real trigger fires — not
speculative mega-builds.

### 3.1 Stages, triggers, contents

| Stage | Trigger to build it | Contents | Footprint |
|---|---|---|---|
| **0. Bootstrap shelter** | first nightfall / mobs near, no safe spot | 1×2 dirt/cobble box or wall-off a cliff niche; 1 torch inside; door/block the entrance | 1×2×2 |
| **1. Small base** | survived night once; have ≥ stone tools; need to process ore | **furnace**, **crafting table**, **1–2 chests**, **bed**, floor torches (light 0-proof), a door | ~5×5 |
| **2. Workshop** | multiple tool tiers in play; smelting is a bottleneck | **furnace bank (3–4)**, dedicated crafting corner, tool/anvil area, fuel chest beside furnaces | +3×5 room |
| **3. Storage room** | chests overflow / can't find items (~2+ full chests) | categorized chest wall (§3.4), labeled (signs/item-frames), aisle to walk | 5×7+ |
| **4. Farms** | food/wood/light runs interrupt real work | wheat+carrot farm (water-irrigated), animal pen (breeding), tree farm, sugarcane/cactus | scalable |
| **5. Expansion** | surplus time & materials; cooperation needs | extra bedrooms, mob farm, nether portal, storage annex, aesthetic exterior, paths | open |

**The through-line:** you always have a bed (skip night + set spawn), light (block-light
> 0 everywhere inside), and walls. Everything past that is bottleneck-driven.

### 3.2 Base-siting rules (deterministic, done once)
- Near what you use: wood (trees), water, and ideally a cave mouth / exposed stone for
  mining access. Flat-ish ground = less terraforming.
- Register it in `BASE.md` (no duplicate infra — reuse existing furnaces/chests via the
  USING/FREE lease protocol). Don't build a second furnace 20 blocks from an idle one.

### 3.3 Neatness / "looks human-made" rules (bot-followable)
Aesthetics is mostly **consistency constraints**, which are deterministic:
- **One material palette per structure.** Don't checker cobble+dirt+planks randomly; pick
  a wall material and stick to it (cobble/stone-brick walls, plank/log frame).
- **Right angles & symmetry.** Walls on the grid, rooms rectangular, door centered,
  torches at even spacing. No 1-off jagged edges.
- **No eyesores.** Never leave: floating dirt/cobble **pillars** from bridging (mine them
  back down), 1-block dirt towers, half-dug holes, or a "cobble monster" blob. Clean up
  scaffolding after a build.
- **Floors flat, paths defined.** A consistent floor block; light the path; use slabs/
  stairs for level changes instead of dirt steps.
- **Light integrated, not spammed.** Enough torches for light>0, placed evenly (wall
  sconces / symmetric grid), not one every 2 blocks in a random scatter.
- **Roof it.** Enclosed top (no open-air rooms mobs can drop into); it also reads as
  "built," not "dug."

*This is the ~90%-deterministic part of aesthetics. The remaining ~10% — "does this
look good / interesting" — is a judgment call (§4).*

### 3.4 Storage-organization scheme
Chests are **categorized, labeled, and laid out for scanning** — a human wall, not a
random pile. Category scheme (one chest/double-chest per category, in a fixed order):

```
[ ORES/INGOTS ] [ BUILDING BLOCKS ] [ FOOD ] [ TOOLS/ARMOR ] [ REDSTONE/MISC ]
[ raw+smelted ] [ stone/wood/dirt ] [cooked] [ spares       ] [ rails/etc     ]
   iron, gold,     cobble, planks,     meat,     picks/axes,      string, bones,
   diamond, coal   glass, wool         crops     bows, armor      dyes, seeds
```
Layout rules:
- **Fixed slot per category** so "where's iron?" is O(1), not a search. Same order every
  base.
- **Label** with signs or item-frames (put a sample item in the frame). A bot deposits by
  category → chest map; **overflow spills to a marked overflow chest**, never onto a
  random pile.
- **Depot vs personal**: surplus beyond the base's needs goes to the **community depot**
  (DEPOT.md protocol), not hoarded — same categorization applies there.
- **Access aisle**: 1-wide walkway facing the chest wall, lit, so every chest is
  reachable without breaking blocks.

### 3.5 Build blueprints (the actual step-recipes)
These are the "how a human lays it out" procedures — parametric blueprints, almost
entirely deterministic (place block at offset X,Y,Z). The *dimensions* below are the
defaults a good player reaches for.

**A. Base shell (small base / stage 1).**
```
1. Pick a footprint on flat-ish ground: default interior 7×7 (grows to 7×9 for workshop).
2. Clear & flatten the footprint to one Y (dig up bumps, fill dips — no jagged floor).
3. Lay the FLOOR: one material, full rectangle (planks or stone — pick a palette).
4. Raise WALLS 3 high around the perimeter, same material, corners squared.
   - leave a 1×2 gap centered on one wall for the DOOR.
   - optional 1×1 windows (glass) at eye height, evenly spaced & symmetric.
5. ROOF it fully (slabs/planks) — no open top (mobs drop in; also it reads as "built").
6. DOOR in the gap; torches/lantern inside so block-light > 0 everywhere (no dark corner).
7. Drop the core kit against the back wall in fixed order:
   [ furnace(s) ] [ crafting table ] [ chest(s) ] [ bed ].
8. Clean up: remove any bridging pillars/scaffolding; flatten the approach; light a path.
```
Rationale for each rule ties back to §3.3: single palette, right angles, roofed, lit,
symmetric openings — that's what makes it read as human-made, and every one of those is a
constraint a program can satisfy.

**B. Crop field (9×9, the canonical unit).**
```
1. Clear a 9×9 area; ensure it's a solid dirt/grass top (add dirt if needed).
2. Dig the CENTER block one down and place a WATER source there.
   → hydrates all farmland within 4 blocks = the whole 9×9.
3. Till the other 80 blocks with a hoe → farmland (stays hydrated from the center water).
4. Plant one crop type per field (wheat / carrots / potatoes / beetroot) — keep it uniform.
5. LIGHT it to ≥ 9 (crops need light level 9+ to grow): torches on fence posts or a
   central lantern; this also spawn-proofs it (light 0 → mobs).
6. FENCE the perimeter + a fence gate (fence is 1.5 high — stops mobs and stops the bot
   from jumping in and trampling crops). 
7. Optional: a 1-deep water canal or slab path down the middle rows for walking + harvest.
```
Scale up by **tiling 9×9 units** side by side (each with its own center water) rather than
one giant field — keeps every block hydrated and keeps the grid tidy.

**C. Animal pen (breeding).**
```
1. Fence a ~10×10 area (or size to herd) on grass, with a fence GATE.
2. Lead in a breeding pair (wheat→cows/sheep, carrots→pigs, seeds→chickens).
3. LIGHT it (torches on posts) so it's spawn-proof and animals don't despawn into dark.
4. Breed with their food when you need meat; keep the herd, harvest the surplus.
5. Keep it ADJACENT to the base, not a hike away (food security is a return-trip resource).
```

**D. Tree farm (sustainable wood).**
```
Rows of saplings spaced so canopies don't jam (oak/birch: every 2–3 blocks; leave 5+ air
above). Bonemeal to speed. Replant every stump immediately (the wood loop should never
require a wilderness trek once this exists).
```

---

## 4. How this maps to the engine — deterministic vs judgment

The honest accounting Felix wants. For each decision surface: is it a **threshold rule**
(a program evaluates a number and acts — no LLM) or a **judgment call** (open-ended,
context-heavy — the LLM earns its keep)?

### 4.1 Deterministic threshold rules (the vast majority)
Everything in the **reflex ladder §1 (P0–P5)** and almost all of §2 is pure threshold
logic. These should be **in-bot, evaluated at ~4 Hz, no LLM in the loop** (token
efficiency is a standing project rule):

| Decision | Rule | Kind |
|---|---|---|
| Survival reflex | hp<6 / fire / lava / drowning → escape | **DET** |
| Eat | hunger≤6 → now; hunger≤17 & hurt & food → eat | **DET** |
| Tool swap/upgrade | dur<10% → swap; better tier craftable → upgrade | **DET** |
| Return to base | free-slots<4 OR dusk&far OR out of torches | **DET** |
| Place torch | light==0 here OR cadence-counter≥6 | **DET** |
| Grab drop | drop within pickup range → collect | **DET** |
| Wall-up default | swarmed / hp<10 & no weapon → box in | **DET** |
| Ore grab-order | fixed priority list on exposed vein | **DET** |
| Branch spacing / depth | 2-apart, Y≈−59 for diamond | **DET** |
| Goal prerequisite gates | food<1day → food goal before mining, etc. | **DET** |
| Storage deposit routing | item category → fixed chest slot | **DET** |
| Base neatness constraints | palette/symmetry/no-floating-pillars/roof | **DET** (mostly) |
| Base stage triggers | "2 full chests → build storage room" etc. | **DET** |
| Base siting | near wood/water/stone, not duplicate infra | **DET** |
| Staircase descent to Y | 1-wide 2-high, mine ahead-low, torch every 6 | **DET** |
| Mining-level targeting | dig main corridor at ore's peak Y (§2.9) | **DET** |
| Build blueprints (shell/field/pen) | parametric place-block recipes (§3.5) | **DET** |

### 4.2 Genuine judgment calls (rare — where the LLM belongs)
Small set. These share a signature: **no clean threshold, multiple defensible answers,
needs world/social context or creativity.**

| Decision | Why it's not a threshold |
|---|---|
| **Top-level goal when prerequisites are all met** (§1.3 line 6–7 ties) | "We're stable — now what: expand? explore? big build? help a teammate?" Open-ended, strategic. |
| **What to build & overall base layout/theme** | Design intent. Constraints are deterministic (§3.3), but the *idea* ("a longhouse here facing the lake") is creative. |
| **Novel/ambiguous situations** | Something the rule set never anticipated (weird terrain trap, a griefer, an unusual trade). No guard covers it → escalate to LLM. |
| **Cooperation & negotiation** | Who does what, resolving conflicting claims, responding to another player's request/chat. Social, contextual. |
| **Cost/benefit on a fuzzy detour** | "There's a village 200 blocks off — worth abandoning the mine run?" Depends on goals & stock in a way that's judgment, not a single number. |
| **Risk appetite under uncertainty** | "Push deeper with 1 torch and half a pickaxe, or bail?" A human weighs it; a bot *can* use a conservative default rule, but the interesting calls are judgment. |

### 4.3 The split, stated plainly
- **By distinct decision rules:** ~**85% deterministic / ~15% judgment**.
- **By time spent in a normal session:** ~**97% deterministic**. The threshold ladder
  fires thousands of times; judgment fires a handful of times per session (pick a goal,
  design a build, handle one surprise, one social exchange).
- **Design consequence:** build the ladder in §1–§2 as fast in-bot code with real
  thresholds; call the LLM **only** at the §4.2 surfaces — i.e. mostly at *goal
  boundaries* (what to pursue next) and *creative/social boundaries* (what to build, how
  to cooperate, unforeseen events), not inside the moment-to-moment loop. That is exactly
  the sparse-LLM architecture the engine is aiming for.

---

## 5. Sources (grounding for the numbers)

- Mob spawn light level changed to **block-light 0** in 1.18 (was ≤7): [Minecraft Wiki — Light](https://minecraft.wiki/w/Light), [MC-261408](https://bugs.mojang.com/browse/MC-261408)
- Torch = light 14, 1/block taxicab falloff, ~13-block flat reach; walls/corners block it: [Tutorial:Spawn-proofing](https://minecraft.wiki/w/Tutorial:Spawn-proofing)
- Hunger/saturation/exhaustion, regen gates (20+sat fast, ≥18 slow, ≤17 none, ≤6 no sprint): [Tutorial:Hunger management](https://minecraft.wiki/w/Tutorial:Hunger_management)
- Branch-mining 2-block spacing catches every vein; diamond best Y ≈ −59 (Y=11 outdated post-1.18): [Minecraft X-Ray — Strip vs Branch 2026](https://minecraftxray.com/blog/strip-mining-vs-branch-mining-2026), [Best Y-Level for Diamonds](https://minecraftxray.com/blog/best-y-level-diamonds-2026)
- Iron triangle-distribution peak Y ≈ 16 (band 15–20), deepslate slower below Y 0: [Minecraft.How — Iron Y-level](https://minecraft.how/blog/post/minecraft-iron-level-guide)
- Crops need light level ≥ 9 to grow; farmland hydrates 4 blocks from water, so one central source covers a 9×9: [Minecraft Wiki — Farmland](https://minecraft.wiki/w/Farmland), [Tutorials/Crop farming](https://minecraft.fandom.com/wiki/Tutorials/Crop_farming)
