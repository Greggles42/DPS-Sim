# Server-accuracy backlog (not yet implemented)

Recorded after the server/DB audit (Oct-25-2026 dump). Everything here differs from the live server but was not changed.

## Combat
- NPC backstab (skill/level formula behind the target, plain Attack() otherwise) and NPC flying-kick minimum damage.
- NPC haste cap of 250 (`NPC::GetHasteCap`); class-attack reuse rounding (divide by haste, truncate to 100 ms, no 1000 ms floor).
- `DoTShielding` has no input (DoT ticks only bypass runes today).
- Physical Enhancement selectable as an AA (engine already supports `physicalEnhancementRank`).
- Haste v2 (SPA 98, Melody of Ervaj) and Hundred Hands.
- Berserk, Assassinate, throwing, headshot, endless quiver, bane damage and recommended-level damage scaling.
- Instrument Mastery / Ayonae's Tutelage as AAs, Jam Fest.

## Pets
- Pet spell lists and innate procs (74 of 140 pet templates have them), pet class attacks (bash/kick/backstab/monk), pet enrage, pet taunt.

## Hate
- Heal hate (`1 + 2*val/3`, capped 800/1500 with `VeliousEraAggroCaps`), bard (40) / pet (100) / mez-stun (/4) hate limits, taunt, Tunnel Vision (0.75), DoT hate as (ticks+1) x tick.

## Buffs / data
- Buff stacking: the SE_StackingCommand_Block/Overwrite effects, the hard-coded special spell ids (resurrection effects, diseased cloud), and the alternate "patch V1" client stacking routine are not ported (which routine the live server uses is not recorded in the DB).
- Items tagged `min_expansion = -1` by the server ("always available") keep the sim's stored era classification; there is no server-side source for it.
- 40 equippable items in the dump that are not in the shipped curated item set (quest/novelty weapons such as the "Diaku Forged" and "of the Gladiator" items) were not added.
- Focus effects before Luclin return 0 on the server (moot at the PoP era the server runs).
- Weapon-skill threshold cases: nothing concrete outstanding. The skill base-damage thresholds (25/75/125/175) and the 24 skill caps the sim reads match the live DB; the ~48 other skill ids are not read by the sim.

## Notes
See the audit report in `C:\Users\gregg\.claude\plans\i-would-like-for-effervescent-whistle.md` for the server file:line references behind each item.
