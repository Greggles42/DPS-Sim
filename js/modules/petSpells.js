/**
 * Pet-summon spell pool resolution for the pet DPS sim.
 *
 * Magician, Necromancer, Shaman, Shadowknight and Beastlord summon pets via
 * spells that are indistinguishable from any other spell in
 * resources/spells-data.js except by their effect list: a pet-summon spell
 * carries effectid 71 (Necro/SK skeleton line), 33 (Magician elementals,
 * Shaman spirit wolves, a handful of others), or 106 (Beastlord warders).
 * Crucially, the spell's `teleport_zone` field is repurposed by the server to
 * hold the exact `name` of the pet's NPC template — that's the only link to
 * the pet's real combat stats (resources/npc_types-data.js), so this
 * module's whole job is walking spells-data.js -> teleport_zone ->
 * npc_types-data.js.
 *
 * Shadowknight needs no special-casing: SK shares the same skeleton-pet
 * spell records as Necromancer (classes5 vs classes11 on the same rows),
 * just gated to a much higher level — it falls out of the same classesN
 * scan as every other class.
 *
 * Beastlord also gets a "pet proc buff" line — the "Spirit of X" spells
 * (Lightning/Blizzard/Inferno/...) cast ON the pet (targettype 14) that grant
 * it a chance to proc elemental damage on its own swings via SE_WeaponProc
 * (effectid 85). getPetProcBuffPool() resolves those the same way, including
 * the hardcoded rate override EQMacEmu's Pet::LoadPetPets applies to exactly
 * these ten spells (zone/pets.cpp) rather than trusting their own listed
 * base2 value, which is a stale/unused 175% for all of them in the data.
 */
(function (global) {
  'use strict';

  var PET_EFFECT_IDS = { 71: true, 33: true, 106: true };
  var UNUSABLE_LEVEL = 255;
  var SE_WEAPON_PROC = 85;
  var PET_TARGET_TYPE = 14;
  // Server hardcodes a 275 proc-rate bonus (-> 375% of baseline PPM) for
  // exactly these ten Beastlord "Spirit of X" pet buffs (Pet::LoadPetPets,
  // zone/pets.cpp) instead of trusting each spell's own effect_base_value2
  // (which is a stale 75 for all of them) — every other pet-proc buff, if
  // one is ever added to the data, falls back to that spell's own value.
  var PET_PROC_RATE_OVERRIDE = {
    2635: 275, 2636: 275, 2637: 275, 2638: 275, 2639: 275,
    2640: 275, 2641: 275, 2888: 275, 2890: 275, 3459: 275
  };

  function getRotationSpells() {
    return global.RotationSpells || null;
  }

  function spellData() {
    return global.__DPS_SPELLS_EN__ || null;
  }

  function npcTypesData() {
    return global.__DPS_NPC_TYPES__ || null;
  }

  var _npcIndex = null;
  /** Lazily built, cached { npcName -> npc_types record }. */
  function npcIndexByName() {
    if (_npcIndex) return _npcIndex;
    var list = npcTypesData();
    _npcIndex = {};
    if (!list) return _npcIndex;
    for (var i = 0; i < list.length; i++) {
      var rec = list[i];
      if (rec && rec.name) _npcIndex[rec.name] = rec;
    }
    return _npcIndex;
  }

  function isPetSummonSpell(sp) {
    for (var i = 1; i <= 12; i++) {
      var eid = Number(sp['effectid' + i]);
      if (PET_EFFECT_IDS[eid]) return true;
    }
    return false;
  }

  /**
   * Every pet-summon spell the given class can cast by the given level,
   * resolved to the pet's real npc_types combat stats.
   *
   * @returns {Array<Object>} pool entries, sorted ascending by the spell's
   *   own class-level requirement (i.e. "which spell would I memorize
   *   first", not "which pet hits hardest" — a Magician has 4 parallel
   *   element lines at every tier, so level order is the only sane one).
   */
  function getPetSummonPool(classId, level) {
    var RS = getRotationSpells();
    var all = spellData();
    if (!RS || !all) return [];

    var id = RS.classIdFor(classId);
    var lvl = Number(level) || 1;
    if (!id) return [];

    var field = 'classes' + id;
    var npcByName = npcIndexByName();
    var pool = [];

    for (var spellId in all) {
      if (!Object.prototype.hasOwnProperty.call(all, spellId)) continue;
      var sp = all[spellId];
      var minLevel = Number(sp[field]);
      if (!isFinite(minLevel) || minLevel <= 0 || minLevel >= UNUSABLE_LEVEL || minLevel > lvl) continue;
      if (!isPetSummonSpell(sp)) continue;

      var npc = npcByName[sp.teleport_zone];
      if (!npc) continue;   // spell doesn't resolve to a known pet template — skip, don't guess

      pool.push({
        spellId: String(spellId),
        spellName: sp.name || ('Spell ' + spellId),
        petName: npc.name,
        level: Number(npc.level) || 1,
        hp: Number(npc.hp) || 0,
        minDamage: Number(npc.mindmg) || 1,
        maxDamage: Math.max(Number(npc.mindmg) || 1, Number(npc.maxdmg) || 1),
        ac: Number(npc.AC) || 0,
        atk: Number(npc.ATK) || 0,
        accuracy: Number(npc.Accuracy) || 0,
        dex: Number(npc.DEX) || 75,
        npcAvoidance: Number(npc.avoidance) || 0,
        // npc_types.attack_delay is in deciseconds (matches every other
        // combat-delay field this sim reads from the same table).
        attackDelayMs: (Number(npc.attack_delay) || 30) * 100,
        attackCount: Number(npc.attack_count) || 1,
        npcClassId: Number(npc.class) || 1,
        race: Number(npc.race) || 0,
        bodytype: Number(npc.bodytype) || 0,
        mana: Number(sp.mana) || 0,
        castTimeMs: Number(sp.cast_time) || 0,
        // The spell's own class-level requirement, used for sort order —
        // deliberately NOT the pet's npc-level (see function doc above).
        spellMinLevel: minLevel
      });
    }

    pool.sort(function (a, b) { return a.spellMinLevel - b.spellMinLevel || a.spellName.localeCompare(b.spellName); });
    return pool;
  }

  /**
   * Beastlord "pet proc buff" spells (Spirit of Lightning, Spirit of the
   * Blizzard, ...) — cast on the pet, they grant it a chance to proc a
   * direct-damage spell on its own melee swings. Resolved into a flat
   * damage number + a proc-chance rate value (same PPM-per-swing formula
   * this sim already uses for weapon item procs — see
   * EQCombat.getProcChancePerSwing — since it's the same server formula
   * (Mob::GetProcChance) fed by the same kind of rate multiplier).
   *
   * @returns {Array<Object>} sorted ascending by class-level requirement.
   */
  function getPetProcBuffPool(classId, level) {
    var RS = getRotationSpells();
    var all = spellData();
    if (!RS || !all) return [];

    var id = RS.classIdFor(classId);
    var lvl = Number(level) || 1;
    if (!id) return [];

    var field = 'classes' + id;
    var pool = [];

    for (var spellId in all) {
      if (!Object.prototype.hasOwnProperty.call(all, spellId)) continue;
      var sp = all[spellId];
      var minLevel = Number(sp[field]);
      if (!isFinite(minLevel) || minLevel <= 0 || minLevel >= UNUSABLE_LEVEL || minLevel > lvl) continue;
      if (Number(sp.targettype) !== PET_TARGET_TYPE) continue;

      var procSpellId = null, procEffectSlot = null;
      for (var i = 1; i <= 12; i++) {
        if (Number(sp['effectid' + i]) === SE_WEAPON_PROC) {
          procSpellId = Number(sp['effect_base_value' + i]);
          procEffectSlot = i;
          break;
        }
      }
      if (!procSpellId) continue;

      var procSpell = all[String(procSpellId)];
      if (!procSpell) continue;
      var procDamage = 0, procResistType = null;
      for (var j = 1; j <= 12; j++) {
        var eid = Number(procSpell['effectid' + j]);
        if (eid === 0) {   // SE_CurrentHP — direct damage, negative = damage dealt
          var base = Number(procSpell['effect_base_value' + j]) || 0;
          if (base < 0) procDamage = -base;
        }
      }
      if (!procDamage) continue;   // not a damage proc — skip rather than model a 0

      // The server reads this spell's own rate override from base2[] (the
      // struct's second parallel per-effect-slot array — SE_WeaponProc packs
      // {proc spell id in base[], rate% in base2[]} at the SAME slot index),
      // which our export exposes as effect_limit_value{slot}, NOT
      // effect_base_value2 (a different slot's own base value entirely —
      // e.g. these spells' 2nd effect slot is an unrelated +DEX buff whose
      // base value happens to also be a plausible-looking number).
      var ownRateMod = Number(sp['effect_limit_value' + procEffectSlot]) || 0;
      var procMod = Object.prototype.hasOwnProperty.call(PET_PROC_RATE_OVERRIDE, spellId)
        ? PET_PROC_RATE_OVERRIDE[spellId]
        : ownRateMod;

      pool.push({
        spellId: String(spellId),
        spellName: sp.name || ('Spell ' + spellId),
        procSpellName: procSpell.name || ('Spell ' + procSpellId),
        procDamage: procDamage,
        procResistType: Number(procSpell.resisttype) || 0,
        // Same units as EQCombat.getProcChancePerSwing's multiplier: 100 =
        // baseline PPM, so this scales that baseline by (100+procMod)/100.
        procRatePct: 100 + procMod,
        mana: Number(sp.mana) || 0,
        castTimeMs: Number(sp.cast_time) || 0,
        spellMinLevel: minLevel
      });
    }

    pool.sort(function (a, b) { return a.spellMinLevel - b.spellMinLevel; });
    return pool;
  }

  global.PetSpells = {
    getPetSummonPool: getPetSummonPool,
    getPetProcBuffPool: getPetProcBuffPool,
    isPetSummonSpell: isPetSummonSpell
  };

})(typeof window !== 'undefined' ? window : globalThis);
