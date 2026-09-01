// perception.js — the structured WORLD-STATE snapshot (Felix's "perception layer").
//
// ONE job: turn a live mineflayer body into a clean, serializable picture of "what do I have
// and what's around me", so the DECISION layer (the deterministic planner today, Andy the
// local LLM tomorrow) decides with real awareness instead of thin/blind reads. This same
// object is designed to be Andy's prompt context — keep it small, flat, and JSON-safe.
//
// CPU-ONLY. It reads bot.inventory / bot.findBlocks / bot.entities ONLY — never any GPU/vision
// path (that guardrail is structural: the box crashed on GPU VRAM exhaustion). Everything here
// is a cheap synchronous scan.
//
// Shape (stable — Andy will be prompted on it):
//   worldState = {
//     ok: bool,                                   // false if the body isn't alive/ready
//     conditions: { inventory:{item:count}, health, food, pos:{x,y,z} },
//     surroundings: {
//       resources: { <key>: { count, nearestReachable:{x,y,z}|null, nearestDist, positions:[{x,y,z,name}], species?:{sp:n} } },
//       structures: [ { name, x,y,z, dist } ],    // crafting_table / chest / furnace ... in reach
//       threats:    [ { name, x,y,z, dist } ],    // hostile mobs nearby
//     },
//   }
//
// "nearestReachable" = the nearest matching block within the body's VERTICAL REACH BAND
// (feetY-MAX_BELOW .. feetY+MAX_ABOVE) — the same cheap reachability heuristic the bootstrap
// hand-dig uses. It is null when blocks exist but none are in the band (the "there's wood but
// it's 40 blocks overhead / down a shaft" case), which is exactly the signal a chain needs to
// decide "work here" vs "relocate toward the nearest forest".

'use strict';

const MAX_BELOW = 5;    // mirror skills.js: never reach a target more than this far below feet
const MAX_ABOVE = 10;   // ...or above

const SPECIES = ['oak', 'spruce', 'birch', 'jungle', 'acacia', 'dark_oak', 'cherry', 'pale_oak', 'mangrove'];

// Default resource groups: a resource KEY -> the block names that satisfy it. Logs fold ALL
// species under one 'log' key (with a species breakdown) so a wood goal reads "is there ANY
// log nearby" — the fix for the species-lock: gather whatever wood is actually around.
const DEFAULT_RESOURCES = {
  log: SPECIES.flatMap((s) => [s + '_log', s + '_wood']),
  stone: ['stone'],
  cobblestone: ['cobblestone', 'cobbled_deepslate'],
  coal_ore: ['coal_ore', 'deepslate_coal_ore'],
  iron_ore: ['iron_ore', 'deepslate_iron_ore'],
  diamond_ore: ['diamond_ore', 'deepslate_diamond_ore'],
  water: ['water'],
};

const STRUCTURE_BLOCKS = ['crafting_table', 'chest', 'trapped_chest', 'furnace', 'blast_furnace',
  'smoker', 'barrel', 'bed'];

// Hostile mob names (the ones a survival bot actually flees/fights). Kept explicit rather than
// trusting entity.kind, which varies by mineflayer/data version.
const HOSTILES = new Set(['zombie', 'husk', 'drowned', 'zombie_villager', 'skeleton', 'stray',
  'bogged', 'creeper', 'spider', 'cave_spider', 'witch', 'enderman', 'slime', 'silverfish',
  'phantom', 'pillager', 'vindicator', 'ravager', 'vex', 'evoker', 'zoglin', 'warden', 'breeze']);

const dist2 = (a, b) => (a.x - b.x) ** 2 + (a.y - b.y) ** 2 + (a.z - b.z) ** 2;

// blockIds(bot, names) -> [id], skipping names unknown to this world's registry.
function blockIds(bot, names) {
  const out = [];
  for (const n of names) {
    try { const d = bot.registry.blocksByName[n]; if (d) out.push(d.id); } catch (_) {}
  }
  return out;
}

// scanResource — find blocks of a resource group and grade reachability. PURE given bot's
// findBlocks. Returns { count, nearestReachable, nearestDist, positions, species }.
function scanResource(bot, names, feet, opts) {
  const radius = opts.radius || 48;
  const cap = opts.maxPerResource || 8;
  const ids = blockIds(bot, names);
  if (!ids.length) return { count: 0, nearestReachable: null, nearestDist: null, positions: [] };
  let hits = [];
  try { hits = bot.findBlocks({ matching: ids, maxDistance: radius, count: 128 }) || []; } catch (_) { hits = []; }
  // sort by distance to feet (nearest first)
  hits.sort((p, q) => dist2(p, feet) - dist2(q, feet));
  const inBand = (p) => p.y >= feet.y - MAX_BELOW && p.y <= feet.y + MAX_ABOVE;
  let nearestReachable = null, nearestDist = null;
  const positions = [];
  const species = {};
  for (const p of hits) {
    let name = null;
    try { name = (bot.blockAt(p) || {}).name || null; } catch (_) {}
    if (positions.length < cap) positions.push({ x: p.x, y: p.y, z: p.z, name });
    if (name) { const m = /^(.*)_(log|wood)$/.exec(name); if (m) species[m[1]] = (species[m[1]] || 0) + 1; }
    if (!nearestReachable && inBand(p)) {
      nearestReachable = { x: p.x, y: p.y, z: p.z, name };
      nearestDist = Math.round(Math.sqrt(dist2(p, feet)));
    }
  }
  const out = { count: hits.length, nearestReachable, nearestDist, positions };
  if (Object.keys(species).length) out.species = species;
  return out;
}

// worldState(bot, opts) -> the snapshot above. Never throws; returns {ok:false} if the body
// isn't ready. opts: { radius=48, maxPerResource=8, resources={key:[names]}, structureRadius=16,
// threatRadius=24 }.
function worldState(bot, opts = {}) {
  const s = { ok: false, conditions: null, surroundings: null };
  try {
    if (!bot || !bot.entity || typeof bot.health !== 'number' || bot.health <= 0) return s;
    const p = bot.entity.position;
    const feet = { x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z) };

    // ---- conditions ----
    const inventory = {};
    try { for (const it of bot.inventory.items()) inventory[it.name] = (inventory[it.name] || 0) + it.count; } catch (_) {}
    s.conditions = {
      inventory,
      health: Math.round(bot.health * 10) / 10,
      food: bot.food,
      pos: { x: Math.round(p.x), y: Math.round(p.y), z: Math.round(p.z) },
    };

    // ---- surroundings.resources ----
    const groups = opts.resources || DEFAULT_RESOURCES;
    const resources = {};
    for (const [key, names] of Object.entries(groups)) resources[key] = scanResource(bot, names, feet, opts);

    // ---- surroundings.structures ----
    const structures = [];
    const structRadius = opts.structureRadius || 16;
    const structIds = blockIds(bot, STRUCTURE_BLOCKS);
    if (structIds.length) {
      let hits = [];
      try { hits = bot.findBlocks({ matching: structIds, maxDistance: structRadius, count: 24 }) || []; } catch (_) {}
      hits.sort((a, b) => dist2(a, feet) - dist2(b, feet));
      for (const h of hits.slice(0, 12)) {
        let name = null; try { name = (bot.blockAt(h) || {}).name || null; } catch (_) {}
        structures.push({ name, x: h.x, y: h.y, z: h.z, dist: Math.round(Math.sqrt(dist2(h, feet))) });
      }
    }

    // ---- surroundings.threats ----
    const threats = [];
    const threatRadius = opts.threatRadius || 24;
    try {
      for (const e of Object.values(bot.entities || {})) {
        if (!e || !e.position || e === bot.entity) continue;
        const nm = e.name || (e.mobType && String(e.mobType).toLowerCase()) || null;
        const kindHostile = e.kind === 'Hostile mobs';
        if (!kindHostile && !(nm && HOSTILES.has(nm))) continue;
        const d = Math.sqrt(dist2(e.position, p));
        if (d > threatRadius) continue;
        threats.push({ name: nm, x: Math.round(e.position.x), y: Math.round(e.position.y), z: Math.round(e.position.z), dist: Math.round(d) });
      }
      threats.sort((a, b) => a.dist - b.dist);
    } catch (_) {}

    s.surroundings = { resources, structures, threats };
    s.ok = true;
    return s;
  } catch (e) {
    s.error = String(e && e.message || e).slice(0, 80);
    return s;
  }
}

// ---- small derived helpers the planner/chains read (keep the decision code declarative) ----

// Does the body have ANY reachable wood right now? (species-agnostic — the Bug A fix.)
const hasReachableWood = (ws) => Boolean(ws && ws.ok && ws.surroundings.resources.log
  && ws.surroundings.resources.log.nearestReachable);

// The nearest reachable block for a resource key, or null.
const nearestReachable = (ws, key) => {
  try { const r = ws.surroundings.resources[key]; return (r && r.nearestReachable) || null; } catch (_) { return null; }
};

// The nearest structure of a given block name (e.g. 'crafting_table'), or null — the Bug B
// REUSE signal ("is there already a table I should use instead of placing a new one").
const nearestStructure = (ws, name) => {
  try { return (ws.surroundings.structures || []).find((x) => x.name === name) || null; } catch (_) { return null; }
};

// The projected {have} world the deterministic planner consumes = the live inventory. Reading
// it THROUGH the perception snapshot (rather than a separate ad-hoc inventory read) is what
// kills the "nothing_to_do" stale-snapshot race: plan() sees exactly what perception saw.
const haveFrom = (ws) => ({ have: Object.assign({}, (ws && ws.conditions && ws.conditions.inventory) || {}) });

module.exports = { worldState, hasReachableWood, nearestReachable, nearestStructure, haveFrom,
  // exported for tests / callers
  _scanResource: scanResource, DEFAULT_RESOURCES, STRUCTURE_BLOCKS, HOSTILES, MAX_BELOW, MAX_ABOVE };
