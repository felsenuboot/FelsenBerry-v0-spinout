// planner.js — the v1 look-ahead execution runtime (EXECUTION_ARCHITECTURE.md Part B).
//
// THREE pieces, in the order they matter:
//   1. run(deps, job)        — the UNIFORM EXECUTOR FACADE. One awaitable completion
//                              contract for every job: travel legs -> deps.travel (graded
//                              honestly, like Baritone's verifyArrival), skill/craft/mine/
//                              build legs -> deps.skills. Normalizes everything (skill
//                              results + producer typed reasons) into {ok, made, reason}.
//   2. plan(project, world)  — the DETERMINISTIC planner. Pure tech-tree rules, NO LLM.
//                              Walks the early spine get_wood -> craft_basics ->
//                              craft_wood_tools -> get_stone -> craft_stone_gear, filtering
//                              already-satisfied chains and AUTO-INSERTING prerequisites off
//                              the CHAINS.md DAG (a target of get_stone with no pickaxe pulls
//                              in craft_wood_tools ahead of it).
//   3. Lookahead             — THE NOVEL PIECE. A 1-deep speculative queue: at job N's START
//                              it stages job N+1; on N's completion callback N+1 fires with
//                              ZERO planning gap. Instrumented so the overlap is visible in
//                              timestamps (N+1-planned lands DURING N; N+1-start == N-complete).
//
// DEPENDENCY INJECTION is the whole design. Nothing here requires mineflayer or dereferences
// a live bot at module load — every world-touching capability arrives through `deps`:
//   deps.skills.run(name, args) -> Promise<rawTaskResultOrThrow>   (in-bot: S.start + poll)
//   deps.travel(to)             -> Promise<{arrived, dist}>        (in-bot: pathfinder/goto2)
//   deps.now()                  -> ms clock                        (injectable for tests)
//   deps.log(line)              -> void                            (optional)
// So the planner + look-ahead + facade are unit-testable WITHOUT a server (see
// bench/fixtures/lookahead.test.js). The in-bot adapters that build `deps` from
// globalThis.__skills + bot.pathfinder live in makeBotDeps() at the bottom, lazily, so a
// plain `require('./planner.js')` in a node test never touches mineflayer.
//
// v1 travel = mineflayer-pathfinder + goto2 (architecture decision, locked). The Baritone
// sidecar (port 3109) is DEFERRED: run(job) abstracts travel behind deps.travel so Baritone
// can be swapped in later behind the same interface with no caller changes.

'use strict';

// ---------------------------------------------------------------------------
// world helpers — read a plain {have:{item:count}} snapshot. Tools live in `have`
// too (have.wooden_pickaxe:1), so the gates need no separate tool map.
// ---------------------------------------------------------------------------
const has = (w, name) => ((w.have || {})[name] || 0);
const sumSuffix = (w, suf) => Object.entries(w.have || {})
  .reduce((a, [k, v]) => a + (k.endsWith(suf) ? v : 0), 0);
const logCount = (w) => sumSuffix(w, '_log');
const plankCount = (w) => sumSuffix(w, '_planks');
// "has some wood to craft from" — logs OR planks. craft_basics/tools gate on this.
const hasWood = (w) => logCount(w) > 0 || plankCount(w) > 0;
const anyPickaxe = (w) => sumSuffix(w, '_pickaxe') > 0;
const anyAxe = (w) => sumSuffix(w, '_axe') > 0;
const hasStonePick = (w) => has(w, 'stone_pickaxe') > 0;
const cobble = (w) => has(w, 'cobblestone') + has(w, 'cobbled_deepslate');
// "from absolute zero" — no tool of any kind. chopTrees hard-requires an axe (skills.js:2938),
// so get_wood cannot lead the plan in this state; the tool-craft has to bootstrap first.
const noToolAtAll = (w) => !anyPickaxe(w) && !anyAxe(w);

// ---------------------------------------------------------------------------
// CHAIN LIBRARY (early spine only, per the task). Each chain is a COMPOSITION over two
// substrates exactly as CHAINS.md defines it: a [BARITONE]-style travel leg (here: goto2/
// pathfinder via deps.travel) + [SKILL] work legs. `legs(args)` returns the ordered
// primitives run(job) will drive.
//
//   satisfied(w, args) — gate: is this chain's goal ALREADY met in world w? (skip if so)
//   precond(w)         — DAG precondition; if false the earlier spine chain that produces it
//                        is auto-inserted (falls out of walking SPINE_ORDER from the top).
//   produces           — what completing it adds to the projected world, so later gates in
//                        the SAME plan see the effect (self-consistent decomposition).
// ---------------------------------------------------------------------------
const CHAINS = {
  get_wood: {
    produces: (args) => ({ oak_log: args.quota || 3 }),
    satisfied: (w, args) => hasWood(w) && logCount(w) >= (args.quota || 3),
    precond: () => true,                              // roots the spine
    // For the very first tree the body is usually already among trees -> travel is a no-op.
    // types is pinned to ANY, explicitly and always: bulk wood-gathering must NEVER inherit a
    // species from the bootstrap tool-craft (craftToolChain.bestSpecies picks whatever the
    // first hand-dug log happened to be). A tool head needs one species; a WOOD GOAL wants
    // whatever is nearest. (Belt-and-suspenders: chopTrees already defaults to 'any' and this
    // planner never threaded a species through — but making it explicit closes any future leak
    // and documents the invariant.)
    legs: (args) => [
      { kind: 'travel', to: args.tree || null, optional: true, why: 'to a tree stand' },
      { kind: 'skill', skill: 'chopTrees', args: { count: args.count || 3, types: 'any' } },
    ],
  },
  craft_basics: {
    produces: () => ({ crafting_table: 1, oak_planks: 4, stick: 4 }),
    satisfied: (w) => has(w, 'crafting_table') >= 1,
    precond: (w) => hasWood(w),                       // no wood -> get_wood auto-inserts
    // producer.js knows the real per-species plank+stick bill and places the table.
    legs: () => [
      { kind: 'craft', skill: 'produce', args: { resource: 'crafting_table', count: 1 } },
    ],
  },
  craft_wood_tools: {
    // ensureTool -> craftToolChain SELF-BOOTSTRAPS from zero: it hand-digs its own logs (the
    // one sanctioned hand-on-log, skills.js:1738), makes planks, crafts a crafting_table if
    // none is in reach, makes sticks, and crafts the tool. So it also YIELDS a table — which
    // is why craft_basics drops out of a bootstrap plan once this has run.
    produces: () => ({ wooden_pickaxe: 1, wooden_axe: 1, crafting_table: 1 }),
    satisfied: (w) => anyPickaxe(w),                  // any pickaxe means we're past wood tools
    precond: (w) => has(w, 'crafting_table') >= 1,    // needs a table -> craft_basics inserts
    // keepTable:true — the starter crafting table these place must PERSIST from the pickaxe
    // craft to the axe craft (and become the starter base); without it craftToolChain digs it
    // back up and the axe leg finds no table -> from-zero loop dies at the pickaxe->axe boundary.
    legs: () => [
      { kind: 'skill', skill: 'ensureTool', args: { tool: 'pickaxe', keepTable: true } },
      { kind: 'skill', skill: 'ensureTool', args: { tool: 'axe', keepTable: true } },
    ],
  },
  get_stone: {
    produces: (args) => ({ cobblestone: args.quota || 16 }),
    satisfied: (w, args) => cobble(w) >= (args.quota || 16),
    precond: (w) => anyPickaxe(w),                    // Baritone/mine needs a pickaxe first
    // shallow/surface stone suffices — travel is often a no-op near base.
    legs: (args) => [
      { kind: 'travel', to: args.spot || null, optional: true, why: 'to exposed stone' },
      { kind: 'mine', skill: 'mineLane', args: { target: args.target || 'stone', count: args.quota || 16 } },
    ],
  },
  craft_stone_gear: {
    produces: () => ({ stone_pickaxe: 1, stone_axe: 1, stone_sword: 1 }),
    satisfied: (w) => hasStonePick(w),
    precond: (w) => cobble(w) >= 3 && has(w, 'crafting_table') >= 1,
    // keepTable across all three stone crafts too — by now the body has wandered off the
    // starter table (chopping/mining), so each stone-tool craft may place its own table; keep
    // it so the three crafts share one and nothing is dug up mid-sequence.
    legs: () => [
      { kind: 'skill', skill: 'ensureTool', args: { tool: 'stone_pickaxe', keepTable: true } },
      { kind: 'skill', skill: 'ensureTool', args: { tool: 'stone_sword', keepTable: true } },
      { kind: 'skill', skill: 'ensureTool', args: { tool: 'stone_axe', keepTable: true } },
    ],
  },
};

// The fixed DAG order (CHAINS.md §"Precondition gate"). Linear here because the early spine
// IS linear; walking it top-down and dropping satisfied chains yields a valid gated plan and
// makes prerequisite auto-insertion fall out for free.
const SPINE_ORDER = ['get_wood', 'craft_basics', 'craft_wood_tools', 'get_stone', 'craft_stone_gear'];
// BOOTSTRAP ORDER — used ONLY from absolute zero (no tool of any kind). The normal order
// leads with get_wood, but get_wood = chopTrees, which hard-requires an axe (skills.js:2938):
// axe <- wood <- chopTrees is a chicken-and-egg. The break: craft_wood_tools (ensureTool ->
// craftToolChain) self-bootstraps its FIRST wood by hand-dig, so it can lead. This is the
// classical human order — punch a tree by hand -> planks -> table -> wooden axe+pickaxe ->
// THEN chop/mine efficiently. Once tools exist the plan reverts to SPINE_ORDER.
const BOOTSTRAP_ORDER = ['craft_wood_tools', 'get_wood', 'craft_basics', 'get_stone', 'craft_stone_gear'];

// ---------------------------------------------------------------------------
// plan(project, world) -> orderedJobList
//   project: { goal: '<chain name>', args? }  — the target tier to reach.
//            (a bare string is treated as {goal: string}.)
//   world:   { have: { item: count, ... } }
// Deterministic. No LLM. Returns [{ chain, args }, ...] — the chains still needed, in DAG
// order, each carrying the project's args for that chain. Chains whose goal is already met
// are dropped; prerequisites of the target are auto-inserted because we always walk from the
// TOP of the spine and project each emitted chain's `produces` forward.
// ---------------------------------------------------------------------------
function plan(project, world) {
  if (typeof project === 'string') project = { goal: project };
  const goal = project.goal || project.chain || 'craft_stone_gear';
  const argsFor = project.args || {};
  if (SPINE_ORDER.indexOf(goal) < 0) throw new Error(`plan: unknown goal chain '${goal}' (known: ${SPINE_ORDER.join(', ')})`);

  // From absolute zero the tool-craft must lead (chopTrees needs an axe); once any tool
  // exists, the normal wood-first order applies. Both orders contain the same chains, so a
  // goal is reachable in either.
  const order = noToolAtAll(world || { have: {} }) ? BOOTSTRAP_ORDER : SPINE_ORDER;
  const goalIdx = order.indexOf(goal);

  // work on a projected copy so a later chain's gate sees earlier chains' output
  const proj = { have: Object.assign({}, (world && world.have) || {}) };
  const merge = (delta) => { for (const [k, v] of Object.entries(delta)) proj.have[k] = (proj.have[k] || 0) + v; };

  // GOAL SHORT-CIRCUIT: the intermediate resource chains are MEANS to the target tier, not
  // goals in themselves. If the target chain's goal is already met, there is nothing to do —
  // don't gather wood/cobble for a tier already reached. (Without this, "already has a stone
  // pickaxe" would still queue get_wood/craft_basics/get_stone.)
  if (CHAINS[goal].satisfied(proj, argsFor)) return [];

  const jobs = [];
  for (let i = 0; i <= goalIdx; i++) {
    const name = order[i];
    const c = CHAINS[name];
    const args = (goal === name) ? argsFor : {};        // only the target carries caller args
    if (c.satisfied(proj, args)) continue;              // gate: already done, skip
    jobs.push({ chain: name, args });
    merge(c.produces(args));                            // project its effect forward
  }
  return jobs;
}

// ---------------------------------------------------------------------------
// run(deps, job) -> Promise<{ok, made, reason, legs?}>
//   job: { chain, args }                         — a whole chain (expands to its legs)
//     |  { kind:'travel', to }                   — one travel primitive
//     |  { kind:'skill'|'craft'|'mine'|'build', skill, args }  — one work primitive
// ONE uniform awaitable completion contract. A chain resolves when its last leg resolves; the
// first failing leg short-circuits and its typed reason propagates. `made` is the leg's honest
// yield (logs dug / items produced / blocks banked / 1 on arrival).
// ---------------------------------------------------------------------------
async function run(deps, job) {
  if (job.chain) {
    const c = CHAINS[job.chain];
    if (!c) return { ok: false, made: 0, reason: 'unknown_chain' };
    const legs = c.legs(job.args || {});
    let made = 0;
    const legOut = [];
    for (const leg of legs) {
      const r = await runLeg(deps, leg);
      legOut.push({ leg: leg.skill || leg.kind, ok: r.ok, made: r.made, reason: r.reason });
      if (!r.ok) {
        // an optional leg that no-ops (e.g. travel to null / already there) is not a failure
        if (leg.optional && (r.reason === 'noop' || r.reason === 'arrived')) continue;
        return { ok: false, made, reason: r.reason, legs: legOut };
      }
      made += r.made || 0;
    }
    return { ok: true, made, reason: undefined, legs: legOut };
  }
  return runLeg(deps, job);
}

async function runLeg(deps, leg) {
  if (leg.kind === 'travel') {
    if (!leg.to) return { ok: true, made: 0, reason: 'noop' };   // no-op travel (already there)
    let g;
    try { g = await deps.travel(leg.to); }
    catch (e) { return { ok: false, made: 0, reason: 'travel_error:' + String(e && e.message || e).slice(0, 40) }; }
    // graded honestly, like Baritone verifyArrival: did we ACTUALLY arrive?
    if (g && g.arrived) return { ok: true, made: 1, reason: undefined };
    return { ok: false, made: 0, reason: 'unreachable' };
  }
  // skill / craft / mine / build -> the skills.js / producer.js layer
  let task;
  try { task = await deps.skills.run(leg.skill, leg.args || {}); }
  catch (e) { return { ok: false, made: 0, reason: 'error:' + String(e && e.message || e).slice(0, 40) }; }
  return normalizeSkill(leg.skill, task);
}

// Normalize a skills.js task outcome into {ok, made, reason}. A task is {done, error, result}
// (the shape skills.js S.status returns). Producer's `produce` already returns
// {ok, made, reason} in task.result — pass its typed reason straight through. Other skills
// carry their own count fields; MADE picks the honest one per skill.
function normalizeSkill(name, task) {
  if (!task) return { ok: false, made: 0, reason: 'no_result' };
  if (task.error) return { ok: false, made: 0, reason: task.error.code || 'error' };
  const res = task.result || {};
  // producer.js backs exactly ONE skill — `produce` — and it returns its own {ok, made,
  // reason}. Key on the name, NOT on the presence of a `how`/`reason` field: ensureTool also
  // carries a `how`, and treating it as the producer contract would grade a made-ready tool
  // (made:0) as a failure.
  if (name === 'produce') {
    return { ok: res.ok !== false && (res.made || 0) > 0, made: res.made || 0, reason: res.reason };
  }
  const made = MADE[name] ? MADE[name](res) : (task.done ? 1 : 0);
  const ok = task.done !== false && made > 0 || (task.done && made === 0 && SUCCESS_MAY_BE_ZERO.has(name));
  return { ok: Boolean(ok), made, reason: ok ? undefined : (res.reason || 'no_progress') };
}
// per-skill "how much did it make" extractors (fields verified in skills.js)
const MADE = {
  chopTrees: (r) => r.logsDug || 0,
  mineLane: (r) => r.banked || r.dug || 0,
  huntAnimals: (r) => r.killed || 0,
  collectDrops: (r) => r.picked || 0,
  ensureTool: () => 1,                       // a tool is a boolean acquire, "1" = ready
  safeDescend: (r) => (r.startY != null && r.endY != null && r.endY < r.startY) ? 1 : 0,
};
// skills whose success is legitimately a zero count (a tool made ready, an already-lit base)
const SUCCESS_MAY_BE_ZERO = new Set(['ensureTool', 'spawnProof']);

// ---------------------------------------------------------------------------
// Lookahead — the 1-deep speculative queue. Standalone driver (proof harness) OR the engine
// behind attachToAgenda(). It owns the ordered job list and, at each job's START, stages the
// NEXT job (planning it while the current one executes). On completion, the staged job fires
// immediately — zero planning gap.
//
// Instrumentation: every timing-relevant moment is pushed to .events with a timestamp, so the
// overlap is provable: for each N, `N+1 planned` lands BETWEEN `N start` and `N complete`, and
// `N+1 start` == `N complete` (~0 gap). See summary() / the test's money-shot table.
// ---------------------------------------------------------------------------
class Lookahead {
  // jobs: ordered [{chain,args}|primitive]
  // opts.execute(job) -> Promise<result>   default: run(deps, job)
  // opts.planNext(index) -> Promise<job|null>   default: instant SPINE lookup jobs[index].
  //   Injectable so a test (or a future Andy fallback) can give planning a MEASURABLE latency
  //   and prove it is hidden under execution.
  constructor(deps, jobs, opts = {}) {
    this.deps = deps;
    this.jobs = jobs.slice();
    this.now = deps.now || (() => Date.now());
    this.log = deps.log || (() => {});
    this.execute = opts.execute || ((job) => run(deps, job));
    this.planNext = opts.planNext || ((i) => Promise.resolve(this.jobs[i] || null));
    this.events = [];
    this.results = [];
    this._staged = null;     // { index, promise } — the 1-deep queue
    this.t0 = null;
  }

  _ev(index, event) {
    const t = this.now();
    if (this.t0 == null) this.t0 = t;
    this.events.push({ index, event, t, rel: t - this.t0 });
    this.log(`lookahead: job#${index} ${event} @+${t - this.t0}ms`);
    return t;
  }

  // Kick off (asynchronously) the planning of job `index`, staging it. This is the overlap:
  // called at the CURRENT job's start, it resolves DURING the current job's execution.
  _stage(index) {
    if (index >= this.jobs.length) { this._staged = { index, promise: Promise.resolve(null) }; return; }
    const promise = Promise.resolve(this.planNext(index)).then((job) => {
      this._ev(index, 'planned');          // <- lands during the previous job's execution
      return job;
    });
    this._staged = { index, promise };
  }

  // Run the whole list with 1-deep look-ahead. Returns the results array.
  async runAll() {
    if (!this.jobs.length) return this.results;
    // stage job 0 up front (nothing to overlap with yet), then run the pipeline
    this._stage(0);
    let index = 0;
    while (index < this.jobs.length) {
      const staged = this._staged;                 // the job we pre-planned
      const job = await staged.promise;            // already resolved in the common case
      if (!job) break;
      const start = this._ev(index, 'start');
      // AS SOON as this job starts, stage the NEXT one — planning overlaps this execution.
      this._stage(index + 1);
      let result;
      try { result = await this.execute(job); }
      catch (e) { result = { ok: false, made: 0, reason: 'exec_error:' + (e && e.message) }; }
      const done = this._ev(index, 'complete');
      this.results.push({ index, job, result, startedAt: start - this.t0, endedAt: done - this.t0 });
      index++;
    }
    return this.results;
  }

  // Analysis: prove the overlap. For each transition N -> N+1 report where N+1's plan landed
  // relative to N's window, and the gap between N complete and N+1 start.
  summary() {
    const at = (i, e) => { const ev = this.events.find((x) => x.index === i && x.event === e); return ev ? ev.rel : null; };
    const rows = [];
    for (let i = 0; i < this.jobs.length - 1; i++) {
      const nStart = at(i, 'start'), nComplete = at(i, 'complete');
      const nextPlanned = at(i + 1, 'planned'), nextStart = at(i + 1, 'start');
      if (nStart == null || nComplete == null) continue;
      rows.push({
        from: i, to: i + 1,
        nStart, nComplete,
        nextPlanned,
        nextStart,
        // planned DURING N's execution?  (the overlap)
        plannedDuringN: nextPlanned != null && nextPlanned >= nStart && nextPlanned <= nComplete,
        // the gap between finishing N and starting N+1 (should be ~0 — it was pre-staged)
        gapMs: nextStart != null ? nextStart - nComplete : null,
      });
    }
    return rows;
  }
}

module.exports = { plan, run, runLeg, normalizeSkill, Lookahead, CHAINS, SPINE_ORDER,
  // world helpers exported for tests/callers building a projected world
  _world: { has, hasWood, anyPickaxe, hasStonePick, cobble, logCount },
  // in-bot adapters (lazy — never touch mineflayer at require time)
  makeBotDeps, attachToAgenda };

// ===========================================================================
// IN-BOT ADAPTERS — build `deps` from a live bot + globalThis.__skills, and wire the
// look-ahead onto the agenda's PROJECT rung. Everything below is lazy: it is only reached
// when actually running inside a bot process (or the flag-gated inject payload), so a plain
// require() from a node test never evaluates a mineflayer path.
// ===========================================================================

// deps.skills.run(name, args): S.start the skill, then poll S.status until the task ends,
// resolving with the task object {done, error, result}. This is the in-bot realization of the
// "await the skill promise" completion contract (skills.js is fire-and-poll, not promise-based).
function makeBotDeps(bot, globalRef) {
  const G = globalRef || globalThis;
  const now = () => Date.now();
  const skills = {
    run(name, args) {
      const S = G.__skills;
      if (!S) return Promise.reject(new Error('no __skills installed'));
      const started = S.start(bot, name, args || {});
      if (!started.ok) return Promise.resolve({ error: started.error || { code: 'start_failed' } });
      const id = started.taskId;
      return new Promise((resolve) => {
        const poll = () => {
          let st;
          try { st = S.status(bot, 0); } catch (e) { return resolve({ error: { code: 'status_error', message: e.message } }); }
          const t = st.task;
          if (!t || t.id !== id) {
            // our task was replaced by another owner (e.g. a preempt) — report as interrupted
            return resolve({ error: { code: 'preempted' }, interrupted: true });
          }
          if (!t.running) return resolve(t);
          setTimeout(poll, 250);
        };
        poll();
      });
    },
  };
  // v1 travel = pathfinder/goto2, graded honestly (verifyArrival-style). Abstracted so the
  // Baritone sidecar can replace this one function later with no caller change.
  const travel = async (to) => {
    if (!to) return { arrived: true, dist: 0 };
    const { x, y, z, range } = to;
    const goals = G.__goals || (bot.pathfinder && bot.pathfinder.goals) || null;
    try {
      if (goals && bot.pathfinder) {
        const goal = (y == null)
          ? new goals.GoalNearXZ(x, z, range || 3)
          : new goals.GoalNear(x, y, z, range || 2);
        await bot.pathfinder.goto(goal);
      }
    } catch (e) { /* fall through to the honest position grade */ }
    const p = bot.entity && bot.entity.position;
    const dist = p ? Math.hypot(p.x - x, (y == null ? 0 : p.y - y), p.z - z) : Infinity;
    return { arrived: dist <= (range || 4), dist };
  };
  const log = (line) => { try { const S = G.__skills; if (S && Array.isArray(S.log)) { S._seq = (S._seq || 0) + 1; S.log.push({ seq: S._seq, lvl: 'info', msg: line }); } } catch (e) {} };
  // bot is exposed so worldFrom can build a fresh perception snapshot at plan time.
  return { skills, travel, now, log, bot };
}

// attachToAgenda(A, deps, project) — FLAG-GATED wire. When ENGINE_LOOKAHEAD=1, decompose the
// project into the spine, hand the FIRST job to the agenda's PROJECT rung (A.setProject), and
// stage the NEXT job speculatively. The agenda runs/verifies/preempts/resumes each job with
// its EXISTING machinery unchanged — interrupts (eat/flee/deposit/tool/light) preempt the
// PROJECT rung and it resumes the same job, because A.project isn't advanced until the job
// VERIFIES done. On that verified completion the agenda calls A._lookahead.advance() (the one
// guarded hook added to agenda.js), which swaps in the already-staged next job with zero
// planning gap and stages the one after it.
//
// This deliberately does NOT rewrite the delicate PROJECT rung: it maps the look-ahead onto
// setProject, reusing every latch/hysteresis/resume path the rung already proves in
// bench/fixtures/agenda-ladder.js.
function attachToAgenda(A, deps, project, opts = {}) {
  if (!A) throw new Error('attachToAgenda: no agenda');
  // World snapshot for the planner. Prefer the PERCEPTION layer (perception.js) when a live
  // bot is reachable: it reads the inventory fresh at plan time, which kills the "nothing_to_do"
  // stale-snapshot race (the planner deciding against an inventory that wasn't ready yet). It
  // is also the exact same worldState Andy will be prompted on, so today's deterministic plan
  // and tomorrow's LLM plan see one picture. Falls back to the agenda's sense() counts.
  const worldFrom = opts.worldFrom || (() => {
    try {
      if (deps && deps.bot) {
        const perception = require('./perception.js');
        const ws = perception.worldState(deps.bot);
        if (ws.ok) return perception.haveFrom(ws);
      }
    } catch (_) {}
    const s = (A.sense && A.sense()) || {};
    return { have: Object.assign({}, s.counts || {}) };
  });
  const exemptKit = opts.exemptKit !== false;
  // FLATTEN the chain plan into per-WORK-LEG jobs. The agenda runs ONE skill per project, so a
  // multi-leg chain must become multiple look-ahead jobs — NOT just its first leg. Running only
  // legs[0] silently dropped craft_wood_tools' SECOND leg (ensureTool axe): the bootstrap made
  // a pickaxe, consumed its wood, and then get_wood/chopTrees demanded an axe the bot never
  // built -> "no axe, could not acquire" dead-lock (verified live on KackboonKevin 18:06:24).
  // So every work leg of every chain becomes its own job, in order; travel legs are dropped
  // (v1 travel = arm-when-clear + hand-place; Baritone later). force:true (when exemptKit)
  // bypasses skills.js S.start's own kit preflight so near-body bootstrap work isn't refused
  // kit_missing before it can build the very kit the gate wants.
  const flatten = (proj) => {
    const out = [];
    for (const job of plan(proj, worldFrom())) {
      const c = CHAINS[job.chain];
      if (!c) continue;
      for (const leg of c.legs(job.args || {})) {
        if (leg.kind === 'travel') continue;
        const args = exemptKit ? Object.assign({ force: true }, leg.args) : leg.args;
        out.push({ skill: leg.skill, args, chain: job.chain });
      }
    }
    return out;
  };
  const jobs = flatten(project);
  const ctrl = {
    jobs, index: 0, staged: null, deps,
    // FLAG-GATED bootstrap exemption (also read by agenda's projectKit). opts.exemptKit:false
    // restores strict kit discipline.
    exemptKit,
    _spec(i) { const j = this.jobs[i]; return j ? { skill: j.skill, args: j.args } : null; },
    _stageNext() {
      const i = this.index + 1;
      // 1-deep: stage the following job now (during the current job's execution)
      this.staged = { index: i, spec: this._spec(i) };
      if (deps.log) deps.log(`lookahead(agenda): staged job#${i} ${this.staged.spec ? this.staged.spec.skill : '(end)'}`);
    },
    start() {
      if (!this.jobs.length) return { ok: false, reason: 'nothing_to_do' };
      const spec = this._spec(0);
      if (!spec) return { ok: false, reason: 'no_spec' };
      A.setProject(spec);
      this._stageNext();
      return { ok: true, first: spec.skill };
    },
    // called by the agenda's guarded hook on VERIFIED project completion.
    // Swaps in the pre-staged next job (zero planning gap) and re-arms the queue.
    advance() {
      // Re-arbitration hygiene: the agenda is calling this mid-harvest, with A.owner still the
      // PROJECT rung and the just-finished project's `completedOnce` set. If we simply set a
      // fresh (unfinished) project, PROJECT.fire() goes true AGAIN within the same tick — and
      // the ladder's "completed but did not meet its own condition" detector (agenda.js ~904)
      // would read that as churn and stand PROJECT down every couple of jobs. So drop ownership
      // and clear PROJECT's churn/stand-down exactly as the ladder's own `paused` branch does,
      // letting choose() re-pick PROJECT cleanly for the new job. (No-ops on a mock agenda that
      // lacks these fields.)
      try {
        A.owner = null;
        if (A.unproductive) A.unproductive.PROJECT = 0;
        if (A.standDown) delete A.standDown.PROJECT;
        if (A.standDownCount) A.standDownCount.PROJECT = 0;
      } catch (e) {}
      this.index++;
      if (!this.staged || !this.staged.spec) { A.setProject(null); if (deps.log) deps.log('lookahead(agenda): spine complete'); return { done: true }; }
      A.setProject(this.staged.spec);         // zero-gap: it was already staged
      this._stageNext();
      return { done: false, now: this.staged.spec };
    },
  };
  A._lookahead = ctrl;
  return ctrl;
}
