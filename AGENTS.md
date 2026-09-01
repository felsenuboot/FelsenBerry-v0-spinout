# AGENTS — how to develop FelsenBerry

Working agreements for anyone advancing this engine — a human, a fresh Claude/agent run, or
a team of coordinated agents. Read [CONTEXT.md](CONTEXT.md) first for the *why*; this file
is the *how*. These practices were learned the hard way during the field tests.

## Golden rules

1. **Verify before you fix.** More than one "bug" here turned out to be a misread of a log
   line or a phantom that the code already handled correctly. Reproduce and locate the
   defect in the source *before* changing anything — especially before touching shared code.
   A retracted phantom is a better outcome than a "fix" to correct code.
2. **Never gamble base infrastructure for a demo.** If a live run would risk the base (e.g.
   an un-fixed destructive path near protected blocks), stop and fix the safety first. All
   the clean damage audits came from holding this line.
3. **Deterministic-first.** Before adding an LLM call, ask "is this a threshold?" It almost
   always is. The LLM earns its keep only at goal boundaries and creative/social calls.
4. **Small vertical slices, flag-gated.** Ship the smallest thing that proves one claim,
   behind an opt-in flag (e.g. an env var) so the running fleet is byte-for-byte unchanged
   until the flag is set.

## Shared-code discipline

FelsenBerry itself is small and self-contained. The *host* skill library (in felcrew) is
shared, production code many bots depend on. When a fix must reach into it:

- Implement it as a **reviewed diff**; do not deploy silently. **Review gate = deploy gate.**
- Keep changes **additive and behavior-preserving** where the code already works. Anchor to
  an existing regression fixture; add a new one for the case you're fixing.
- **Deploy is a careful cherry-pick** of just the fix, never a merge of a stale branch (a
  branch several engine-versions behind will re-apply duplicates and silently revert live
  fixes).
- Fail-open defaults on any new guard, so an un-wired call keeps the old behavior.

## The look-ahead runtime (`src/planner.js`)

- `run(deps, job) → Promise<{ok, made, reason}>` — the uniform executor facade. `deps`
  injects `travel`, the skill runner, and the world snapshot; no live bot at module load,
  so it is unit-testable without a server.
- `plan(project, world) → [jobs]` — deterministic tech-tree decomposition, no LLM. Walks
  the spine top-down, drops satisfied chains, auto-inserts prerequisites. From an empty
  inventory it uses the bootstrap order (tool-craft leads, because chopping needs an axe).
- The **1-deep look-ahead queue** stages job N+1 at job N's *start* and fires it on N's
  completion — the zero-gap seam. Wire it to the host's PROJECT rung via `setProject`.
- **Flatten multi-leg chains into per-leg jobs** — do not run only the first leg (that was
  the dropped-axe bug). Each `ensureTool` etc. is its own look-ahead job.

## Testing protocol

**Offline (always):** a plain-`node` assertion harness against a mock bot + mock skills
proves the look-ahead overlap (every N+1 planned during N, ~0 gap) and interrupt
preempt/resume without a server. Keep it green; extend it with every behavior change. This
is where you prove *timing* — sub-second gaps can't be read from server logs.

**Live (guarded):** to verify on a real server —
- Launch a **dedicated bot on an UNUSED port** (never a production port), opt-in flag on.
- The bot must start **empty** for a from-zero test — reused usernames keep prior inventory;
  use a fresh name or an actually-emptied one.
- Use an **arm-when-clear** gate: defer the bootstrap until the body is ≥ ~30 blocks from
  base, so a from-scratch hand-dig can never touch base infra.
- Position it at genuine wild resources; do not trust flaky travel to place it.
- **Hands off other players' bots.** Run an honest **damage audit** afterward (blocks
  broken/placed, protected-region refusals) and report it.
- Live proves *advancement* (job→job on the real ladder) + safety; the offline harness
  owns *timing*. Keep that split honest — don't fake sub-second numbers from logs.

## If you coordinate multiple agents

- One **supervisor** holds the plan and the review gate; **specialist** agents each own a
  narrow slice (a fix, a diagnosis, a doc). The supervisor relays findings to the human.
- Specialists **report diffs for review** and do not deploy shared code themselves.
- Prefer **fewer, well-scoped agents** over a swarm. A read-only diagnosis agent that
  reports file:line evidence is worth more than a fixer that guesses.

## Memory discipline

- **Keep [CONTEXT.md](CONTEXT.md) and [ROADMAP.md](ROADMAP.md) current** — they are the
  durable memory. When a decision is made or a bug is fixed, update them in the same change.
- Record a *finding* (with why + how-to-apply) the moment it's learned, so the next run
  doesn't re-discover it. Convert relative dates to absolute.

## Commit conventions

- Small, self-describing commits; note what changed and why. Semver the component
  (`package.json`) when the public runtime contract changes.
- Never commit secrets (RCON passwords, tokens). This repo has none — keep it that way.
