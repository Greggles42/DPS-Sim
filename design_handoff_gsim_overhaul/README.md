# Handoff: gSim UI Overhaul

## Overview

This is a comprehensive UI overhaul for **gSim**, a Project Quarm (EverQuest emulator) DPS simulator. The redesign restructures the tool into two coordinated experiences:

- **Desktop** — a 3-pane "command console" layout (Class rail · Build editor · Live results) with persistent HUD, Easy/Advanced mode toggle, and on-canvas simulation results.
- **Mobile** — a tabbed stepper (Build · Sim · Report · History) optimized for one-handed use on phones.

The tool is used by EverQuest players to model melee / ranged / tanking builds against specific NPCs by configuring character stats, gear, buffs, AA (alternate advancement), and combat skills, then running a simulation that outputs DPS, TPS, and a detailed damage breakdown.

## About the Design Files

The files in this bundle are **design references created in HTML** — interactive prototypes showing the intended look, layout, and behavior. They are **not production code to copy directly**.

The task is to **recreate these HTML designs in gSim's existing environment** (Python/Flask + Jinja templates + vanilla JS, based on the original gSim codebase), using its established patterns, form components, and data flow. If gSim is being rewritten in a new environment (React/Vue/etc.), choose the framework that best fits the team's direction and port the designs there.

Key things the developer should preserve from the original gSim:
- All simulation logic, formulas, and data (weapon database, NPC list, buff definitions, AA tables)
- Era/expansion selector (Classic → GoD, currently showing Luclin)
- Class-specific skill auto-fill and override semantics
- The existing "Rank Weapons" function (now exposed as "Rank All" in the top bar)

## Fidelity

**High-fidelity.** These mocks specify final colors, typography, spacing, component states, and interaction behavior. The developer should recreate the UI **pixel-perfectly** in gSim's target environment, using the exact design tokens listed below.

The aesthetic is deliberately EverQuest-evocative: dark navy/black backgrounds, gold accents, serif display type (Cinzel), parchment-style inputs, subtle gold radial gradients at the corners of each panel.

---

## Screens / Views

### 1. Desktop Command Console (1440 × 900)

#### Top Bar (56px)
Fixed header with:
- **Logo**: `g` + small-caps `S` + `im` in Cinzel gold 19px, tagline "FOR PROJECT QUARM" (10px, muted, 0.25em tracking). Subtitle "EverQuest DPS Simulator · v1.13" below.
- **Era selector**: pill button showing "ERA · Luclin ▾" (gold border, input background).
- **Mode tabs**: segmented control for Melee / Ranged / Tanking. "Tanking" is disabled (WIP).
- **Persistent HUD** (right side): Two large stats — TPS (blue #4a9eff, 22px Cinzel) and TOTAL DPS (gold, 26px Cinzel with gold glow). Separator line between them. Sits in a panel with radial gold gradient.
- **Rank All button**: Secondary CTA — outlined gold, dark background, 🏆 icon, "RANK ALL" in Cinzel. Opens the weapon ranking view (tests all equippable weapons, outputs top 200 combinations).
- **Run Sim button**: Primary CTA — filled gold gradient `linear-gradient(145deg, #D4AF37 0%, #8a6b14 100%)` with dark text `#0a0a0c`, Cinzel 800 weight, strong gold box-shadow + inset highlight. ⚡ icon.
- **Easy / Advanced toggle**: Pill switch. Easy = slider-based inputs, guided. Advanced = numeric inputs, manual overrides, extra panels (Report, etc.).

#### Body — 3-pane grid: `200px | 1fr | 400px`

**LEFT pane — Class rail**
- 15 classes listed vertically (Bard, Beastlord, Cleric, Druid, Enchanter, Magician, Monk, Necromancer, Paladin, Ranger, Rogue, Shadowknight, Shaman, Warrior, Wizard).
- Active class has a crimson left-border, gold text, subtle crimson-to-transparent horizontal gradient background.
- Inactive: grey text, transparent background.
- Clicking a class changes the active selection (drives skill defaults, AA tree, class-restricted gear).

**CENTER pane — Build editor** (vertical stack of panels, 12px gap)
1. **Character & Haste**
   - Race dropdown (Human/Barbarian/Iksar/Vah Shir pills) — determines base stat starting values.
   - Stats table: STR / AGI / DEX / STA with columns Base | +Pts | Gear | Final.
   - Worn Haste control (right column): slider in Easy mode, numeric input in Advanced.
   - Additional haste/ATK fields (v1 Haste, v3 Haste, Worn ATK, Spell ATK).
   - Footer: "Highest haste src: Silver Bracelet of Speed (41%)".

2. **Equipped Items**
   - Section header: "20 slots · 445 AC total" hint; "+ IMPORT INVENTORY" action.
   - **Stat summary pills row** (inside a gold-bordered strip): STR 229, STA 182, AGI 134, DEX 111, WIS 92, INT 68, HP +1050, AC 445, HASTE 41%, ATK 95.
   - 2-column grid of 20 slots (Head, Face, Ear×2, Neck, Shoulders, Back, Arms, Wrist×2, Hands, Fingers×2, Chest, Legs, Feet, Waist, Range, Primary, Ammo).
   - Each row: `[SLOT] Item Name [stat summary]`. Slot in muted uppercase small, name in Zodiak 12px, stat summary in blue `#4a9eff` mono 10px.

3. **Weapon 1 | ⇅ (rotated 90° horizontal) | Weapon 2** (3-col grid)
   - Each weapon card: icon square, name (Zodiak 15px), meta line (type, damage, delay, stat bonuses), search input "Type 4+ chars to search…".
   - Fields row: Damage, Delay, Proc, Elem.
   - Expandable "▸ PROC, ELEMENTAL & BANE" link.
   - Weapon 2 is dimmed (opacity 0.6) when main hand is 2H — "Offhand blocked while main hand is 2H."
   - Swap button between cards — 36×36 gold-bordered square with ⇅ (rotated 90° to appear horizontal).

4. **Target & Fight**
   - Target NPC combo: "Kaas Thox Xi Aten Ha Ra · Lvl 66 · AC 800" with clear-X.
   - Fields: Target AC, Mob Lvl, Duration (s), Runs.
   - Easy mode only: Group / Raid content pills. Advanced: italic note "Content-type preset disabled in Advanced — set individual mob / AC / lvl above."

5. **Skills & Options** (collapsed)
   - Single-line expandable link: "▸ SKILLS & OPTIONS — auto-filled from class · click to override".

6. **AA + Buffs** (2-col grid)
   - **Alternate Advancement**: Groups labeled "LUCLIN — ARCHETYPE" and "LUCLIN — MONK" (class-specific). Each AA row shows name + a dot-counter (0 to max) where each dot is a 20×20 square; filled dots are gold.
   - **Buffs**: 5 categorized groups — Haste, Offensive, Bard Songs, Potions & Clickies, Slot Buffs. Each group header shows `CATEGORY  N/M` (active / total). Each buff row: checkbox + name + class tag (ENC, BRD, SHM, etc.). Footer shows aggregate: "Haste: +60% · ATK: +95 · STR: +55".

7. **Report** (Advanced mode only)
   - Plaintext pre-formatted block (monospace 10px, scrollable, 220px max height).
   - Shows sections like "═══ Executive Summary ═══" (section headers in gold), then indented key-value pairs (Duration, Total DPS, TPS, Critical hits, etc.).
   - Action: "EXPORT .TXT".

**RIGHT pane — Live Results** (vertical stack)
1. **Results header** — "RESULTS · Last run · 20 avg".
2. **Big DPS number** — centered gold panel, "Resulting DPS" label, 52px Cinzel bold gold number (77.48), footer "σ 0.39 · crit +3.37 · 390 crits · 464,851 dmg".
3. **Damage Breakdown** — pie chart (110px) + legend (Primary hand 61.1%, Damage bonus 23.1%, Flying Kick 15.8%). Total dmg below.
4. **Per-Swing Damage histograms** — two rows: "Caen's Bo — 43d/30" (4,389 hits · 33–374) and "Flying Kick" (941 hits · 48–283). Each is a mini bar chart, 36 bars.
5. **Session History** — table of recent runs: Weapon | ATK | DPS | Era | Mode. Mode badge: gold "ADV" or green "EZ".

### 2. Mobile Tabbed Stepper (iPhone 14 Pro frame)

Tab bar at bottom with 4 tabs: **Build** · **Sim** · **Report** · **History**.

**Build tab**
- Class picker (horizontal scroll chips).
- Character Stats grid (STR/AGI/DEX/STA + AC/HP/ATK/HASTE pills).
- Worn Haste section — slider in Easy mode, numeric input in Advanced. Header action "TOGGLE".
- Equipped Items (condensed list of 5 key slots).
- Buffs (checkbox list, same categories as desktop).
- Target NPC picker.

**Sim tab**
- Large "Run Simulation" CTA.
- Results summary (big DPS number, breakdown pie, per-swing histograms).

**Report tab**
- Scrollable plaintext report (same content as desktop Report panel).

**History tab**
- List of past runs with timestamps.

### 3. Tweaks Panel

Bottom-right floating panel (appears when Tweaks toggle is on in the preview toolbar):
- **View**: Split | Desktop | Mobile
- **Desktop Scale**: Fit | 1:1
- **Show Annotations** toggle

---

## Interactions & Behavior

- **Class selection**: Click a class in the left rail → updates active class indicator, re-populates skill defaults, AA tree labels, and class-restricted gear filters. Drives the AA "LUCLIN — MONK" (etc.) section label.
- **Easy/Advanced toggle**: Swaps Worn Haste between slider (Easy) and numeric input (Advanced). Hides Group/Raid preset in Advanced (shown as italic note). Shows Report panel only in Advanced.
- **Buff toggles**: Clicking a buff row flips its checkbox. Updates per-category count (e.g. "2/4") and the aggregate footer (Haste, ATK, STR totals).
- **Weapon swap (⇅)**: Swaps Weapon 1 ↔ Weapon 2 contents.
- **Rank All**: Opens a weapon ranking view that simulates all equippable weapons (per class/era) and outputs a sorted list of the top 200 combinations or top N for a specific slot. The original gSim had this; preserve its behavior exactly.
- **Run Sim**: Executes the simulation (`N runs × duration seconds`). Updates the persistent HUD (TPS + TOTAL DPS), the big DPS number, pie chart, histograms, and appends a row to Session History.
- **Mobile tab switching**: Clicking a bottom-bar tab switches the main content area.

---

## State Management

Client-side state:
- `selectedClass: string` (default 'Monk')
- `mode: 'Melee' | 'Ranged' | 'Tanking'`
- `advanced: boolean` (Easy/Advanced toggle)
- `buffs: Record<string, boolean>` (map of buff-name → active)
- `race: string`
- `weaponMH, weaponOH: Weapon` (item objects)
- `equipped: Record<SlotName, Item>`
- `target: NPC`
- `lastRun: SimulationResult` (DPS, TPS, damage total, per-weapon hits, etc.)
- `sessionHistory: SimulationResult[]`

Data fetching:
- Weapon database (filtered by class/era/slot)
- NPC database (by era)
- AA definitions (by class/era)
- Buff catalog

---

## Design Tokens

### Colors
```
/* Backgrounds */
BG              #07070a    /* Outer canvas */
PANEL           #0f1014    /* Panel background */
INPUT           #14151a    /* Input/field background */

/* Text */
TEXT            #e8e4d4    /* Primary text (warm off-white) */
TEXT_DIM        #b8b4a4    /* Secondary text */
MUTED           #7a7668    /* Muted labels */
MUTED_DIM       #4a4638    /* Very muted */

/* Gold accent system */
GOLD            #D4AF37    /* Primary gold */
GOLD_BRIGHT     #e8c547    /* Bright highlight */
GOLD_DIM        rgba(212,175,55,0.4)
GOLD_FAINT      rgba(212,175,55,0.1)
GOLD_BORDER     rgba(212,175,55,0.25)

/* Structural */
BORDER          rgba(255,255,255,0.08)
CRIMSON         #8B0000    /* Active class highlight */

/* Data viz */
TPS_BLUE        #4a9eff
PIE_BLUE        #4a9eff
PIE_BLUE_DARK   #2c6fb8
PIE_VIOLET      #8b5cf6
```

### Typography
```
FONT_DISPLAY    'Cinzel', serif         /* Section labels, buttons, HUD */
FONT_SERIF      'Zodiak', serif         /* Item names, headings with flair */
FONT_BODY       'Satoshi', system-ui    /* Default body, inputs */
FONT_MONO       'JetBrains Mono', ui-monospace  /* Numeric values, reports */
```

Sizes (desktop):
- Hero DPS: 52px Cinzel 700
- HUD totals: 22-26px Cinzel 700
- Panel section labels: 10px Cinzel 700, 0.14em tracking, uppercase
- Body: 11-13px Satoshi
- Meta/hint: 9-10px
- Minimum legible: 9px (0.1em+ tracking)

### Spacing
- Panel padding: 14px (12px for dense panels)
- Panel gap: 12px
- Field gap: 8px
- Grid columns (main): `200px | 1fr | 400px`
- Border radius: 3px (inputs), 4px (panels/buttons), 6px (control squares)

### Shadows
- Primary CTA: `0 0 24px rgba(232,197,71,0.45), inset 0 1px 0 rgba(255,255,255,0.3)`
- Hero number glow: `0 0 24px rgba(212,175,55,0.3)` (as text-shadow)
- Pie drop-shadow: `drop-shadow(0 2px 8px rgba(0,0,0,0.4))`

### Backgrounds / Treatments
- Main canvas: radial gradients at corners:
  `radial-gradient(circle at 15% 0%, rgba(212,175,55,0.05) 0%, transparent 45%), radial-gradient(circle at 85% 100%, rgba(139,0,0,0.06) 0%, transparent 55%)`
- HUD panel: `radial-gradient(ellipse at 100% 50%, rgba(212,175,55,0.08), transparent 70%)`
- Top bar: `rgba(0,0,0,0.4)` with `backdrop-filter: blur(12px)`.

---

## Assets

- **Fonts** (all web-loaded, no local assets needed):
  - Cinzel — Google Fonts
  - Zodiak & Satoshi — Fontshare (`https://api.fontshare.com/v2/css?f[]=zodiak@400,700&f[]=satoshi@400,500,700`)
- **Icons**: Unicode glyphs only (⚡ ⇅ 🏆 ◈ ▸ ▾ ✓ ⌕ ×). No icon font / SVG set needed, though the team may substitute an SVG icon set if preferred.
- **Imagery**: None. No character portraits, item icons, or maps in this design — placeholder squares stand in for item icons.

---

## Files

All files are in this handoff folder:

- `gSim UI Overhaul.html` — Root HTML. Mounts React, wires up the Tweaks panel, orchestrates Desktop + Mobile views.
- `final/theme.jsx` — Design tokens (colors, fonts). Exports `window.GSIM_THEME`. **Read this first.**
- `final/desktop.jsx` — `DesktopCommandFinal` component (the 1440×900 desktop console).
- `final/mobile.jsx` — `MobileStepperFinal` component (the iPhone tabbed stepper).
- `ios-frame.jsx` — iOS device bezel/frame wrapper used by the mobile view.

To run locally:
```
# Serve the folder over any static server, then open gSim UI Overhaul.html
python3 -m http.server 8000
```

Open the Tweaks panel (toolbar toggle when embedded, or add the button) to switch between Split / Desktop-only / Mobile-only views.
