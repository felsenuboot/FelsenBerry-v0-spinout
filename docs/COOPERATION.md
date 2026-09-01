# COOPERATION — the third pillar (designed, not yet built)

Status: **designed here, unimplemented.** `live` is proven and `build` is partial; this doc
gives `cooperate` a concrete blueprint + test plan so it isn't a hand-wave. It requires a
running server to build and verify, which was down at design time.

## Thesis: coordinate through shared STATE, not chatter

Natural-language coordination between LLM agents collapses as the group grows — mindcraft's
own **MineCollab** benchmark shows multi-agent success falling ~90 % → <30 % from 2 → 5
agents, worse when the bots must *talk* to plan. So FelsenBerry coordinates the same way it
decides: **deterministically, over shared state.** Bots read and write small,
authoritative registries; they do not negotiate in prose. The (optional) LLM is for the rare
social/negotiation edge, never the routine coordination loop — the same sparse-LLM rule as
everywhere else in this engine.

## The primitives (already proven in the felcrew fleet — reuse them)

- **BASE registry** (`BASE.md`) — the authoritative list of shared infrastructure
  (furnaces, chests, tables, farms) with positions. Rule: **no duplicate infra** — build a
  furnace only if the registry has none free in range.
- **USING / FREE leases** — a bot claims a shared fixture (a furnace, a mining shaft, a
  build site) by marking it `USING <bot> <until>`; others must respect it and pick another
  or wait. Leases expire so a dead bot never deadlocks the fixture.
- **Community depot** (`DEPOT.md` protocol) — surplus beyond a bot's working kit goes to
  shared depot chests, categorized; teammates draw from it. Turns hoarding into a shared
  economy.
- **Claims** — a registered base/farm/territory is **respected and never destroyed** by a
  cooperating bot (distinct from the autonomy to destroy *unclaimed* blocks).

These already work for the human-run fleet; the cooperate pillar is wiring them into the
autonomous engine's decision loop.

## The coordination model

Each bot runs its own FelsenBerry loop (perception → plan → look-ahead → execute). Make the
**shared registries part of every bot's perception**, and make the **planner claim before it
acts**:

1. **Perception includes the shared state.** Extend `worldState` with a `shared` section:
   `{ infra:[…leased?…], claims:[…], depot:{…}, teammates:[{name,pos,project,lease}] }`,
   read from the registries. Now "is a furnace free?" / "is anyone mining this vein?" is a
   deterministic lookup, exactly like "is there wood nearby?".
2. **Claim → act → release.** Before a bot commits to a shared resource (a furnace, an ore
   body, a build site), it takes a **lease**; it releases on completion or expiry. Two bots
   never smelt at the same furnace or strip the same vein because the lease arbitrates —
   deterministically, first-writer-wins, no conversation.
3. **Task/role allocation without a leader.** A deterministic partition of the standing
   goal by a stable key (bot name hash, or a claimed sub-region) means two bots working the
   same project don't collide: e.g. one leases the north branch of the mine, the other the
   south; one owns the wheat field, the other the animal pen. No central coordinator, no
   messages — just claims over a shared plan.
4. **Conflict resolution is a rule, not a negotiation.** On a contested claim, a fixed
   priority (earliest timestamp wins; ties broken by name order) resolves it. The loser
   deterministically re-plans to the next option. The LLM is consulted only for a genuinely
   novel social situation the rules don't cover.
5. **Respect claims absolutely.** A cooperating bot never harvests, mines, or deconstructs
   another bot's registered base/claim/lease — this is the cooperation counterpart to the
   base-protection filter (`isProtected`) that already guards a bot's own starter base.

## What to build (next-cycle checklist)

- [ ] `shared` section in `worldState` (perception reads BASE/DEPOT/lease registries).
- [ ] A lease API the planner calls: `claim(resource, ttl)` / `release(resource)` /
      `isClaimed(resource)` — backed by the shared registry, expiry-safe.
- [ ] Planner: take a lease before committing a job that uses a shared/contended resource;
      on a failed claim, deterministically pick the next option (re-plan, don't wait blindly).
- [ ] Deterministic goal partition so N bots on one project split the work by claim/region.
- [ ] Respect-claims guard extended to teammates' registered infra + active leases.

## How to verify (needs a server)

1. Two FelsenBerry bots, one shared base with **one** furnace. Both finish mining and want
   to smelt. **Expect:** one leases the furnace and smelts; the other sees it `USING`,
   waits or uses a second furnace — never a collision, no chat. Clean damage audit; neither
   touches the other's claimed infra.
2. Two bots, one standing "gather 64 wood" goal. **Expect:** they partition (different tree
   stands / regions by claim) and don't double-chop the same trees; both deposit to the
   shared depot; total ≈ additive, not duplicated.
3. Scale to 3–5 bots and confirm throughput **stays additive** — the deterministic
   substrate should not show the MineCollab collapse, because coordination is state, not
   language. That result is the pillar's acceptance criterion.

## Why this is the right shape

It keeps the whole engine's discipline intact: deterministic in the loop, LLM only at the
edges, safety via guards. Cooperation becomes just more shared state the same planner reads —
not a new, fragile, chatty subsystem. When it's built and test 3 passes, the third pillar is
met.
