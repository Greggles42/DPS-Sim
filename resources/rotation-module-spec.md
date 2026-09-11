# Spell Rotation Module — Spec for gSim

## Goal

Add a rotation planner/optimizer to gSim: given a pool of nukes, simulate the actual
cast-by-cast timeline against the global cooldown rules and per-spell recast timers,
and report DPS, mana/sec, and sustain over a fight duration. Should work as a standalone
module (pure functions, no UI framework dependency) so it can be called from gSim's
existing simulation layer or exposed as its own panel.

A working prototype of the logic exists as a single-file HTML/JS artifact (vanilla JS,
no build step) — this doc describes porting that logic into gSim as typed modules.
Treat the mechanics description below as the source of truth; the prototype code is a
reference implementation, not gospel.

## Core mechanics to model

**Global cooldown (GCD):** After a normal spell finishes casting, there is a 2.25s
lockout before the *next normal spell* can begin casting. This is separate from and
additive with that spell's own recast timer.

**Off-global spell (exactly one, optional):** One spell can be flagged as "off-global."
It still takes its own full cast time on the bar — only one spell can be mid-cast at
any moment, normal or off-global — but:
- Starting it is **not gated** by the GCD lock (it can begin the instant the caster is
  free, even if a normal-spell GCD lock is still ticking).
- Casting it does **not impose** a GCD lock on what comes next.
- It is gated only by its own recast timer.

In effect there are two independent clocks: a `busyUntil` timeline (serial — one cast
at a time, everyone respects this) and a `gcdFree` timeline (only read/written by
normal spells).

**Resist adjustment:** Raw spell damage in the data overstates actual delivered
damage. Apply an expected-value multiplier per damage instance:

```
factor = P(land)*1.0 + P(partial resist)*0.25 + P(full resist)*0.0
```

Default assumption: full resist and partial resist chances are configurable inputs
(e.g. 5% / 12%), same for every spell unless per-spell resist modifiers become
relevant later.

**Multi-wave spells (rains):** Rain-type spells split their total listed damage across
3 waves, and each wave rolls the resist check independently. Mathematically the
*expected value* is identical whether you apply the resist factor once to the total or
three times to three even splits (expectation is linear) — so for a deterministic
average-based simulator, just apply the factor to the total damage. Track `waves` on
the spell record anyway so the UI/output can flag it, and so a future Monte Carlo mode
(see "Possible extensions") has what it needs for variance.

## Data model

```ts
interface Spell {
  id: string;
  name: string;
  level: number;
  type: string;            // "ST nuke" | "Rain" | "PBAE" | "Chain AE" | etc.
  damage: number;          // total listed damage (pre-resist), full amount across all waves for rains
  resistType: string;      // e.g. "Fire (-10)"
  mana: number;
  castTime: number;        // seconds
  recastTime: number;      // seconds, spell-specific cooldown after cast completes
  waves: number;           // 1 for single-target, 3 for rain-type
}

interface ResistConfig {
  fullResistPct: number;   // 0-100
  partialResistPct: number;// 0-100, lands at 25% damage
}

interface RotationConfig {
  pool: Spell[];
  offGlobalSpellId: string | null;   // null = pure GCD chain, no off-global filler
  fightDurationSec: number;
  maxMana: number;         // 0 = unlimited
  manaRegenPerTick: number;// per 6s tick, include buffs/meditation
  resist: ResistConfig;
  priorityMode: 'dps' | 'sustain' | 'balanced';
}

interface CastLogEntry {
  time: number;
  spellId: string;
  spellName: string;
  effectiveDamage: number;
  manaCost: number;
  kind: 'gcd' | 'offGlobal';
}

interface RotationResult {
  totalDamage: number;
  totalMana: number;
  castCount: number;
  durationSec: number;
  dps: number;
  manaPerSec: number;
  manaRemaining: number | null;   // null if unlimited
  ranOutOfManaAt: number | null;  // sim time, null if never
  log: CastLogEntry[];
}
```

## Algorithm

Constant: `GCD = 2.25` seconds.

```
effectiveDamage(spell, factor) = spell.damage * factor

resistFactor(fullPct, partialPct):
  f = clamp(fullPct/100, 0, 1)
  p = clamp(partialPct/100, 0, 1)
  land = max(0, 1 - f - p)
  return land*1 + p*0.25 + f*0

score(spell, mode, isOffGlobal, factor, maxDpsScore, maxManaScore):
  edmg = effectiveDamage(spell, factor)
  # off-global spell doesn't tax the timeline with a trailing 2.25s lock,
  # so its throughput denominator excludes GCD
  dpsScore  = edmg / (spell.castTime + (isOffGlobal ? 0 : GCD))
  manaScore = edmg / spell.mana
  if mode == 'dps':     return dpsScore
  if mode == 'sustain':  return manaScore
  # balanced: normalize both to 0-1 against the pool's best-in-slot, average them
  return 0.5*(dpsScore/maxDpsScore) + 0.5*(manaScore/maxManaScore)
```

Simulation loop (event-driven, not fixed-timestep — jump straight to the next
decision point each iteration rather than stepping by small deltas):

```
function simulateRotation(config) -> RotationResult:
  factor = resistFactor(config.resist.fullResistPct, config.resist.partialResistPct)
  unlimited = config.maxMana <= 0
  regenPerSec = config.manaRegenPerTick / 6

  isOffGlobal(spell) = spell.id == config.offGlobalSpellId

  maxDpsScore  = max over pool of edmg/(cast + (isOffGlobal?0:GCD))
  maxManaScore = max over pool of edmg/mana

  t = 0
  busyUntil = 0      # caster's serial cast-bar timeline
  gcdFree = 0        # earliest a normal spell may START; off-global ignores this
  mana = config.maxMana
  lastManaUpdateT = 0
  availAt = { spellId: 0 for every spell in pool }   # per-spell recast-clear time
  log = []
  totalDamage = 0, totalMana = 0, castCount = 0
  ranOutOfManaAt = null

  manaAt(time):
    if unlimited: return Infinity
    return min(config.maxMana, mana + (time - lastManaUpdateT) * regenPerSec)

  while t < config.fightDurationSec:
    t = max(t, busyUntil)
    if t >= config.fightDurationSec: break

    m = manaAt(t)
    candidates = pool.filter(spell =>
      availAt[spell.id] <= t
      and (unlimited or m >= spell.mana)
      and (isOffGlobal(spell) or gcdFree <= t)
    )

    if candidates is non-empty:
      best = argmax(candidates, c => score(c, config.priorityMode, isOffGlobal(c), factor, maxDpsScore, maxManaScore))
      castEnd = t + best.castTime
      if not unlimited: mana = m - best.mana; lastManaUpdateT = t
      edmg = effectiveDamage(best, factor)
      totalDamage += edmg; totalMana += best.mana; castCount += 1
      log.push({ time: t, spellId: best.id, spellName: best.name,
                 effectiveDamage: edmg, manaCost: best.mana,
                 kind: isOffGlobal(best) ? 'offGlobal' : 'gcd' })
      availAt[best.id] = castEnd + best.recastTime
      busyUntil = castEnd
      if not isOffGlobal(best): gcdFree = castEnd + GCD
      t = castEnd
      continue

    # nothing castable right now — check if it's specifically a mana problem
    if not unlimited and ranOutOfManaAt is null:
      wouldBeReadyIgnoringMana = pool.some(spell =>
        availAt[spell.id] <= t and (isOffGlobal(spell) or gcdFree <= t)
      )
      if wouldBeReadyIgnoringMana: ranOutOfManaAt = t

    # jump to the next time something changes state, rather than stepping by a fixed delta
    nextTimes = [gcdFree if gcdFree > t] + [availAt[s.id] for s in pool if availAt[s.id] > t]
    nextT = min(nextTimes) if nextTimes else t + 0.25
    if nextT <= t: nextT = t + 0.1   # safety valve against zero-length loops
    t = min(nextT, config.fightDurationSec)

  return {
    totalDamage, totalMana, castCount,
    durationSec: config.fightDurationSec,
    dps: totalDamage / config.fightDurationSec,
    manaPerSec: totalMana / config.fightDurationSec,
    manaRemaining: unlimited ? null : manaAt(t),
    ranOutOfManaAt,
    log,
  }
```

Cap the loop with a hard iteration ceiling (e.g. 250,000) as a safety valve — with the
event-jump approach this should never come close to that for any realistic fight
length, but it protects against a scheduling edge case producing a zero-length loop.

## Priority modes

- **`dps`** — greedy pick maximizes `damage / (castTime + GCD-if-applicable)`. This is
  the right heuristic for filler decisions because a spell's real cost isn't just its
  cast time — for normal spells it's cast time *plus* the trailing 2.25s lock it
  imposes on the next cast.
- **`sustain`** — greedy pick maximizes `damage / mana`, ignoring time entirely.
- **`balanced`** — normalizes both scores against the pool's best-in-slot for each
  metric and averages them 50/50. Simple to make this a weighted slider instead of a
  fixed 50/50 if you want finer control later.

## Suggested module boundaries

```
/rotation
  types.ts          # interfaces above
  resist.ts         # resistFactor, effectiveDamage
  scoring.ts         # score()
  simulate.ts        # simulateRotation()
  index.ts           # public exports
```

Keep `simulateRotation` a pure function (config in, result out) — no DOM/UI coupling —
so it's trivially unit-testable and reusable from both a UI panel and any batch-mode
comparison tooling (e.g. "run this pool through all three priority modes and diff the
DPS").

## Edge cases to cover in tests

- Empty pool with no off-global spell selected → should return zero damage, not throw.
- Off-global spell selected but its recast never clears within the fight window after
  the first cast (e.g. long recast, short fight) → only casts once, rest of fight is
  pure normal-spell GCD chain.
- `maxMana = 0` (unlimited) → mana never gates spell selection, `manaRemaining` is
  `null`.
- Mana pool that runs dry mid-fight → `ranOutOfManaAt` gets set exactly once, at the
  first moment something was castable (recast-clear and GCD-clear) but unaffordable;
  simulation should keep running afterward on whatever regen allows rather than
  halting.
- A spell whose `recastTime` is shorter than `GCD` (shouldn't normally happen in the
  data, since GCD is the effective floor, but don't assume the data is well-formed —
  clamp or at least don't crash).
- Off-global spell also present in the *normal* candidate pool by mistake — make sure
  `isOffGlobal()` checks by id, not by object identity, so a spell can't accidentally
  get treated as both.

## Possible extensions (not required for v1)

- **Monte Carlo resist variance**: instead of the deterministic expected-value factor,
  roll each damage instance independently (3 rolls for rain spells, 1 for everything
  else) across N simulated fights and report a damage distribution/percentile range
  instead of a single average. This is where `waves` actually matters — right now it's
  tracked but functionally inert in the deterministic model.
- **Manual rotation mode**: let the user lock in an explicit ordered sequence instead
  of the greedy optimizer, and simulate that fixed sequence for comparison against the
  greedy result.
- **Per-spell resist modifiers**: the resist type/value per spell (e.g. "Fire (-10)")
  currently isn't used quantitatively — could feed into a proper resist-check formula
  against a target's resist stat instead of a single flat full/partial percentage
  shared across the whole pool.
