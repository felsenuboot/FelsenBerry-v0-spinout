#!/usr/bin/env node
// bench/fixtures/lookahead.test.js — the v1 look-ahead runtime, proven WITHOUT a server.
//
// Plain node, zero mineflayer: requires ../../planner.js (which never touches a bot at load)
// and drives it with a MOCK skills layer + MOCK travel + a real clock. Three proofs:
//   1. plan()  — the deterministic spine, its gates, and prerequisite AUTO-INSERTION.
//   2. Lookahead — the money shot: next-job planning OVERLAPS current-job execution, so the
//      next job starts with ~0 gap. Run head-to-head against a SEQUENTIAL baseline (plan
//      AFTER complete) to quantify the hidden latency.
//   3. attachToAgenda — an interrupt preempts the project and it RESUMES the same job without
//      losing the 1-deep queue; the spine advances by exactly one on verified completion.
//
// Run:  node bench/fixtures/lookahead.test.js
// Exits nonzero if any assertion fails.

'use strict';
const P = require('../src/planner.js');

let pass = 0, fail = 0;
const fails = [];
const ok = (cond, label) => { if (cond) { pass++; } else { fail++; fails.push(label); console.log('  FAIL: ' + label); } };
const eq = (a, b, label) => ok(JSON.stringify(a) === JSON.stringify(b), `${label} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// PART 1 — plan(): deterministic spine, gates, auto-insertion
// ---------------------------------------------------------------------------
function testPlan() {
  console.log('\n== PART 1: deterministic planner ==');

  // fresh world (absolute zero, no tool) -> BOOTSTRAP order: the tool-craft LEADS because
  // chopTrees (get_wood) hard-requires an axe (skills.js:2938). craft_wood_tools self-
  // bootstraps its own wood+table by hand-dig, so craft_basics (the table) drops out.
  let jobs = P.plan({ goal: 'craft_stone_gear' }, { have: {} });
  eq(jobs.map((j) => j.chain),
    ['craft_wood_tools', 'get_wood', 'get_stone', 'craft_stone_gear'],
    'fresh world (no tool) -> BOOTSTRAP order: craft_wood_tools leads, craft_basics subsumed');

  // ...but the moment ANY tool exists, the normal wood-first order applies.
  jobs = P.plan({ goal: 'craft_stone_gear' },
    { have: { wooden_axe: 1 } });
  eq(jobs.map((j) => j.chain),
    ['get_wood', 'craft_basics', 'craft_wood_tools', 'get_stone', 'craft_stone_gear'],
    'has an axe -> normal SPINE order (get_wood can lead, it now has its axe)');

  // gate: already have wood tools + a table + logs -> get_wood/basics/wood_tools drop out
  jobs = P.plan({ goal: 'craft_stone_gear' },
    { have: { oak_log: 8, crafting_table: 1, wooden_pickaxe: 1 } });
  eq(jobs.map((j) => j.chain), ['get_stone', 'craft_stone_gear'],
    'have wood+table+pickaxe -> only get_stone + craft_stone_gear remain');

  // AUTO-INSERTION from zero: target get_stone directly, no tool -> bootstrap pulls the
  // tool-craft in first (it self-provisions wood+table+pickaxe), then get_wood, then get_stone.
  jobs = P.plan({ goal: 'get_stone' }, { have: {} });
  eq(jobs.map((j) => j.chain), ['craft_wood_tools', 'get_wood', 'get_stone'],
    'target get_stone, empty world -> craft_wood_tools bootstrapped ahead of it');

  // gate: fully geared already -> empty plan (nothing to do)
  jobs = P.plan({ goal: 'craft_stone_gear' }, { have: { stone_pickaxe: 1 } });
  eq(jobs.map((j) => j.chain), [], 'already has a stone pickaxe -> empty plan');

  // gate: enough cobble present -> get_stone drops but craft_stone_gear stays
  jobs = P.plan({ goal: 'craft_stone_gear' },
    { have: { oak_log: 8, crafting_table: 1, wooden_pickaxe: 1, cobblestone: 20 } });
  eq(jobs.map((j) => j.chain), ['craft_stone_gear'],
    'have cobble already -> only craft_stone_gear remains');
}

// ---------------------------------------------------------------------------
// MOCK skills + travel. A skill "runs" for EXEC_MS then resolves a task object shaped like
// skills.js S.status().task. A tiny world tracks what got made so results look real.
// ---------------------------------------------------------------------------
const EXEC_MS = 120;     // modeled per-leg execution time
const PLAN_MS = 40;      // modeled per-job planning latency (the thing look-ahead hides)

function makeMockDeps() {
  const world = { have: {} };
  const add = (k, n) => { world.have[k] = (world.have[k] || 0) + n; };
  const skills = {
    async run(name, args) {
      await sleep(EXEC_MS);
      // shape results per the real skills' fields so normalizeSkill() exercises real paths
      if (name === 'chopTrees') { add('oak_log', 3); return { done: true, result: { treesFelled: 1, logsDug: 3 } }; }
      if (name === 'produce') { add(args.resource, args.count || 1); return { done: true, result: { ok: true, made: args.count || 1, how: 'crafted', reason: undefined } }; }
      if (name === 'ensureTool') { add((args.tier || 'wooden') + '_' + args.tool, 1); return { done: true, result: { tool: args.tool, how: 'crafted' } }; }
      if (name === 'mineLane') { add('cobblestone', args.count || 16); return { done: true, result: { banked: args.count || 16, dug: args.count || 16 } }; }
      return { done: true, result: {} };
    },
  };
  const travel = async (to) => { await sleep(30); return { arrived: true, dist: 0 }; };
  return { skills, travel, now: () => Date.now(), log: () => {}, _world: world };
}

// ---------------------------------------------------------------------------
// PART 2 — the look-ahead overlap, vs a sequential baseline
// ---------------------------------------------------------------------------
async function testLookahead() {
  console.log('\n== PART 2: 1-deep look-ahead overlap (the money shot) ==');
  const jobs = P.plan({ goal: 'craft_stone_gear' }, { have: {} });

  // planNext models the planning latency the architecture hides. Same latency for both runs.
  const planNext = (deps) => async (i) => { await sleep(PLAN_MS); return jobs[i] || null; };

  // --- look-ahead run: stage N+1 at N's start ---
  const dLA = makeMockDeps();
  const la = new P.Lookahead(dLA, jobs, { planNext: planNext(dLA) });
  const tLA0 = Date.now();
  await la.runAll();
  const tLA = Date.now() - tLA0;

  const rows = la.summary();
  console.log('\n  overlap timeline (ms, relative to first job start):');
  console.log('  ' + ['N', 'N.start', 'N.done', '(N+1).planned', '(N+1).start', 'plannedDuringN', 'gapMs'].join('  '));
  for (const r of rows) {
    console.log('  ' + [`${r.from}->${r.to}`, r.nStart, r.nComplete, r.nextPlanned, r.nextStart,
      r.plannedDuringN, r.gapMs].join('   '));
  }

  // every N+1 was planned DURING N's execution, and started with a ~0 gap
  ok(rows.every((r) => r.plannedDuringN), 'every next job was PLANNED during the current job (overlap)');
  ok(rows.every((r) => r.gapMs != null && r.gapMs <= 10), 'every next job STARTED with ~0 gap after the current completed');
  // and every chain actually SUCCEEDED through run(job)+normalizeSkill (guards the ensureTool/
  // producer normalization bug from ever hiding behind the timing assertions again)
  ok(la.results.length === jobs.length && la.results.every((r) => r.result.ok),
    'every chain ran to ok:true through the run(job) facade (' + la.results.map((r) => r.job.chain).join(', ') + ')');

  // --- sequential baseline: plan AFTER the previous job completes (mindcraft/Voyager shape) ---
  const dSEQ = makeMockDeps();
  const tSEQ0 = Date.now();
  for (let i = 0; i < jobs.length; i++) {
    await sleep(PLAN_MS);                 // plan THIS job first (on the critical path)
    await P.run(dSEQ, jobs[i]);           // then execute it
  }
  const tSEQ = Date.now() - tSEQ0;

  const hidden = tSEQ - tLA;
  console.log(`\n  total wall time:  look-ahead ${tLA}ms   sequential ${tSEQ}ms   -> hidden ${hidden}ms of planning latency`);
  // look-ahead hides (jobs-1) planning latencies vs sequential. Allow scheduler slop.
  ok(hidden >= (jobs.length - 1) * PLAN_MS - 30,
    `look-ahead hid ~${(jobs.length - 1) * PLAN_MS}ms of planning latency (measured ${hidden}ms)`);
  ok(tLA < tSEQ, 'look-ahead run finished before the sequential baseline');
}

// ---------------------------------------------------------------------------
// PART 3 — attachToAgenda: interrupt preempts the PROJECT and RESUMES the same job without
// losing the 1-deep queue. Uses a MINIMAL mock agenda that mirrors the real contract:
// setProject sets A.project; a preempt leaves A.project untouched (resume-not-retry); only a
// VERIFIED completion calls A._lookahead.advance().
// ---------------------------------------------------------------------------
async function testAgendaWire() {
  console.log('\n== PART 3: agenda wire — interrupt preempt + resume, queue intact ==');

  // mock agenda modelling the fields advance() must keep clean: the PROJECT owner, the
  // per-rung `unproductive` churn counter (agenda.js ~904), and stand-down state.
  const A = {
    project: null,
    _lookahead: null,
    owner: 'PROJECT',                 // PROJECT rung holds the body while a project runs
    unproductive: {},
    standDown: {}, standDownCount: {},
    setProject(spec) { this.project = spec ? Object.assign({ completedOnce: false }, spec) : null; },
    sense() { return { counts: {} }; },
    // the ONE guarded hook the real agenda adds: on verified completion, advance the queue.
    // The real ladder does this WITH A.owner still === PROJECT and would then run its
    // unproductive detector — model that: if advance() left us owning PROJECT with a fresh
    // (unfinished) project, the detector would increment churn. advance() must prevent it.
    _verifiedComplete() {
      const adv = this._lookahead ? this._lookahead.advance() : { done: true };
      if (this.owner === 'PROJECT' && this.project && !this.project.completedOnce) {
        this.unproductive.PROJECT = (this.unproductive.PROJECT || 0) + 1;   // detector would fire
      }
      if (this.owner == null) this.owner = 'PROJECT';    // choose() re-picks PROJECT for the new job
      return adv;
    },
    _preempt(why) { this._preemptedProject = this.project && this.project.skill; /* project untouched */ },
  };

  const deps = makeMockDeps();
  const ctrl = P.attachToAgenda(A, deps, { goal: 'craft_stone_gear' }, { worldFrom: () => ({ have: {} }) });
  const started = ctrl.start();
  const fired = [A.project.skill];         // full sequence of projects the queue drives
  ok(started.ok, 'attach + start set the first project');
  // from empty world the plan is the BOOTSTRAP order, so job#0 is craft_wood_tools -> its
  // first work leg is ensureTool (the self-bootstrapping tool craft that leads from zero).
  eq(A.project.skill, 'ensureTool', 'first project is craft_wood_tools\' work leg (ensureTool)');
  // (b) bootstrap kit-gate exemption: on by default, and it force:true's the spine jobs so
  // skills.js preflight can't refuse the local bootstrap work (and agenda's projectKit reads
  // ctrl.exemptKit to drop the excursion floor that would otherwise starve the spine).
  ok(ctrl.exemptKit === true, '(b) exemptKit defaults on under attachToAgenda');
  ok(A.project.args && A.project.args.force === true, '(b) spine jobs carry force:true to bypass S.start kit preflight');
  ok(ctrl.staged && ctrl.staged.spec, 'job#1 was staged at job#0 start (1-deep queue armed)');
  const stagedAfterStart = ctrl.staged.spec.skill;

  // --- INTERRUPT mid-job: a P1d TOOL interrupt preempts the PROJECT ---
  A._preempt('TOOL');
  ok(A.project && A.project.skill === 'ensureTool', 'after preempt, A.project is STILL job#0 (not lost, not advanced)');
  ok(ctrl.staged && ctrl.staged.spec.skill === stagedAfterStart, 'after preempt, the staged next job is STILL armed (queue intact)');
  eq(ctrl.index, 0, 'index unchanged by a preempt');

  // --- RESUME: PROJECT rung regains the body, same job continues, then VERIFIES done ---
  const adv1 = A._verifiedComplete();      // job#0 finally verifies
  fired.push(A.project.skill);
  ok(!adv1.done, 'spine not finished after job#0');
  eq(ctrl.index, 1, 'index advanced by exactly one on verified completion (no skip)');
  eq(A.project.skill, stagedAfterStart, 'zero-gap: the pre-staged job#1 is now the project');
  ok(ctrl.staged && ctrl.staged.index === 2, 'job#2 got staged when job#1 started (1-deep maintained)');

  // drive the rest of the spine to completion, asserting no job is ever skipped or repeated
  let guard = 0;
  while (guard++ < 20) {
    const adv = A._verifiedComplete();
    if (adv.done) break;
    fired.push(A.project.skill);
  }
  ok(guard < 20, 'spine terminated (no runaway)');
  console.log('  project sequence driven by the queue: ' + fired.join(' -> '));
  // BOOTSTRAP spine from empty, FLATTENED to per-work-leg jobs:
  //   craft_wood_tools -> ensureTool(pickaxe), ensureTool(axe)   <- BOTH legs now run (the fix)
  //   get_wood        -> chopTrees
  //   get_stone       -> mineLane
  //   craft_stone_gear-> ensureTool(stone_pickaxe), ensureTool(stone_sword), ensureTool(stone_axe)
  eq(fired, ['ensureTool', 'ensureTool', 'chopTrees', 'mineLane', 'ensureTool', 'ensureTool', 'ensureTool'],
    '7 per-leg jobs fired in order — craft_wood_tools runs BOTH pickaxe AND axe (no dropped leg)');
  // the churn-detector hardening: advancing the queue never looked like unproductive churn
  eq(A.unproductive.PROJECT || 0, 0, 'advancing the queue never tripped the unproductive-churn detector');
}

(async () => {
  testPlan();
  await testLookahead();
  await testAgendaWire();
  console.log(`\n==== ${pass} passed, ${fail} failed ====`);
  if (fail) { console.log('FAILURES:\n  - ' + fails.join('\n  - ')); process.exit(1); }
  process.exit(0);
})();
