// Desktop — Command Console (final)
// 3-pane: Class rail · Build editor · Live results
// Based on real gSim data; tuned for density + persistent DPS readout.

const T = window.GSIM_THEME;
const Corners = window.GsimCorners;

function cinzel() { return { fontFamily: T.FONT_DISPLAY }; }
function satoshi() { return { fontFamily: T.FONT_BODY }; }
function zodiak() { return { fontFamily: T.FONT_SERIF }; }
function mono() { return { fontFamily: T.FONT_MONO }; }

function CCSectionLabel({ children, hint, action }) {
  return (
    <div style={{
      display: 'flex', alignItems: 'baseline', justifyContent: 'space-between',
      fontSize: 10, letterSpacing: '0.14em', textTransform: 'uppercase',
      color: T.GOLD, fontWeight: 700, marginBottom: 10,
      paddingBottom: 6, borderBottom: `1px solid ${T.GOLD_BORDER}`,
      ...cinzel(),
    }}>
      <span>{children}</span>
      {hint && <span style={{ color: T.MUTED, letterSpacing: '0.04em', fontSize: 9, ...satoshi(), textTransform: 'none' }}>{hint}</span>}
      {action && <span style={{ color: T.GOLD, letterSpacing: '0.1em', fontSize: 9, cursor: 'pointer' }}>{action}</span>}
    </div>
  );
}

function CCPill({ children, active, onClick }) {
  return (
    <div onClick={onClick} style={{
      padding: '4px 10px', borderRadius: 3, fontSize: 10,
      letterSpacing: '0.1em', textTransform: 'uppercase', fontWeight: 600,
      border: `1px solid ${active ? T.GOLD : T.BORDER}`,
      background: active ? T.GOLD_FAINT : 'transparent',
      color: active ? T.GOLD : T.MUTED, ...cinzel(),
      cursor: 'pointer', userSelect: 'none',
    }}>{children}</div>
  );
}

function CCField({ label, value, w = 64, accent = false, hint }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <div style={{ fontSize: 9, letterSpacing: '0.1em', color: T.MUTED, textTransform: 'uppercase', display: 'flex', gap: 4, alignItems: 'baseline' }}>
        {label}
        {hint && <span style={{ color: T.MUTED_DIM, fontSize: 8, letterSpacing: 0 }}>{hint}</span>}
      </div>
      <div style={{
        width: w, height: 28, background: T.INPUT, border: `1px solid ${T.BORDER}`,
        borderRadius: 3, padding: '0 8px',
        display: 'flex', alignItems: 'center', justifyContent: 'flex-end',
        fontSize: 13, color: accent ? T.GOLD : T.TEXT, fontWeight: accent ? 700 : 500, ...mono(),
      }}>{value}</div>
    </div>
  );
}

function CCStatRow({ name, base, pts, gear, final }) {
  const Btn = ({ children }) => (
    <div style={{ width: 14, height: 14, border: `1px solid ${T.BORDER}`, borderRadius: 2, background: T.INPUT, fontSize: 9, color: T.MUTED, display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer' }}>{children}</div>
  );
  return (
    <tr>
      <td style={{ color: T.TEXT, fontWeight: 600, fontSize: 11, padding: '3px 6px' }}>{name}</td>
      <td style={{ color: T.MUTED, fontSize: 11, textAlign: 'right', padding: '3px 6px', ...mono() }}>{base}</td>
      <td style={{ padding: '3px 6px', textAlign: 'center' }}>
        <div style={{ display: 'inline-flex', alignItems: 'center', gap: 2 }}>
          <Btn>−</Btn>
          <div style={{ width: 18, textAlign: 'center', fontSize: 11, color: T.TEXT, ...mono() }}>{pts}</div>
          <Btn>+</Btn>
        </div>
      </td>
      <td style={{ color: T.GOLD, fontSize: 11, textAlign: 'right', padding: '3px 6px', fontWeight: 600, ...mono() }}>{gear}</td>
      <td style={{ color: T.GOLD, fontSize: 12, textAlign: 'right', padding: '3px 6px', fontWeight: 700, ...mono() }}>{final}</td>
    </tr>
  );
}

function CCHistogram({ color, count = 36, seed = 1 }) {
  const bars = React.useMemo(() => {
    return Array.from({ length: count }, (_, i) => {
      const t = i / (count - 1);
      // pseudo-random deterministic
      const n1 = Math.sin(seed * 12.9898 + i * 78.233) * 43758.5453;
      const noise = (n1 - Math.floor(n1));
      const bell = Math.exp(-Math.pow((t - 0.35) * 2.5, 2)) * 0.8 + 0.15;
      return 6 + bell * 42 + noise * 6;
    });
  }, [count, seed]);
  return (
    <div style={{ display: 'flex', alignItems: 'flex-end', gap: 1.5, height: 50 }}>
      {bars.map((h, i) => (
        <div key={i} style={{ flex: 1, height: h, background: color, borderRadius: '1.5px 1.5px 0 0', opacity: 0.85 }} />
      ))}
    </div>
  );
}

function CCDamagePie({ size = 120, segs }) {
  const r = size / 2;
  let a = -Math.PI / 2;
  const arcs = segs.map((s, i) => {
    const end = a + (s.pct / 100) * Math.PI * 2;
    const x1 = r + r * Math.cos(a), y1 = r + r * Math.sin(a);
    const x2 = r + r * Math.cos(end), y2 = r + r * Math.sin(end);
    const large = end - a > Math.PI ? 1 : 0;
    const d = `M${r},${r} L${x1},${y1} A${r},${r} 0 ${large} 1 ${x2},${y2} Z`;
    a = end;
    return <path key={i} d={d} fill={s.color} />;
  });
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} style={{ filter: 'drop-shadow(0 2px 8px rgba(0,0,0,0.4))' }}>
      {arcs}
      <circle cx={r} cy={r} r={r * 0.4} fill={T.PANEL} />
      <circle cx={r} cy={r} r={r * 0.4} fill="none" stroke={T.GOLD_BORDER} />
    </svg>
  );
}

function CCPanel({ children, style = {} }) {
  return (
    <Corners style={{ background: T.PANEL, border: `1px solid ${T.GOLD_BORDER}`, borderRadius: 4, padding: 14, ...style }}>
      {children}
    </Corners>
  );
}

// Equipped items (compact list matching real gSim)
function CCEquipped() {
  const slots = [
    ['Head', 'Crown of the Kromzek Kings', '+25 STR +8 AGI +12 STA'],
    ['Face', 'Silver Mask of the Slayer', '+25 STR +12 DEX +12 HP'],
    ['Ear', 'Hoop of Chaos', '+16 STR +8 DEX +12 HP'],
    ['Ear (2)', 'Earring of Falling Stars', '+10 STR +15 STA +10 HP'],
    ['Neck', 'Silent Fang Necklace', '+20 STR +10 DEX +10 HP'],
    ['Shoulders', 'Shroud of Patience', '+10 STR +10 DEX +10 AGI +10 STA'],
    ['Back', 'Cloak of Destruction', '+35 STR +10 AGI +10 STA +15 HP'],
    ['Arms', 'Mark of Shadows', '+15 STR +12 DEX +15 AGI +10 STA'],
    ['Wrist', 'Spirit Wracked Cord', '+12 STR +12 DEX +5 HP +100'],
    ['Wrist (2)', 'Silver Bracelet of Speed', '+10 STA +10 STR +10 DEX +5 HP'],
    ['Hands', 'Celestial Fists', '+15 STR +10 DEX +8 AGI +10 STA'],
    ['Fingers', 'Ring of Rage', '+20 STR +7 DEX +7 AGI +7 HP +75'],
    ['Fingers (2)', 'Ring of Dain Frostreaver IV', '+10 STR +10 STA +10 DEX'],
    ['Chest', 'Shroud of Longevity', '+20 STR +15 STA +20 HP'],
    ['Legs', 'Flayed Barbarian Leggings', '+60 STR +10 DEX +10 AGI +10'],
    ['Feet', 'Yttrium Studded Boots', '+25 STR +12 DEX +10 STA'],
    ['Waist', 'Belt of Dwarf Slaying', '+20 STR +16 HP +100'],
    ['Range', 'Crystallized Serpent Eye', '+25 STR +12 AGI +12 HP +75'],
    ['Primary', "Caen's Bo Staff of Fury", '43d / 30 · STR +16 STA +15 AGI +20'],
    ['Ammo', 'Shissar Fangs', '11/15 · STR +5 DEX +5 AGI +5 STA +3'],
  ];

  return (
    <CCPanel style={{ padding: 12 }}>
      <CCSectionLabel hint="20 slots · 445 AC total" action="+ IMPORT INVENTORY">Equipped Items</CCSectionLabel>
      {/* Aggregate stat summary pills */}
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 10, padding: '8px 10px', background: T.INPUT, border: `1px solid ${T.GOLD_BORDER}`, borderRadius: 3 }}>
        {[
          ['STR', '229'],['STA','182'],['AGI','134'],['DEX','111'],['WIS','92'],['INT','68'],
          ['HP','+1050'],['AC','445'],['HASTE','41%'],['ATK','95'],
        ].map(([k, v]) => (
          <div key={k} style={{ display: 'flex', alignItems: 'baseline', gap: 4, padding: '2px 8px', background: 'rgba(0,0,0,0.3)', border: `1px solid ${T.BORDER}`, borderRadius: 2 }}>
            <span style={{ fontSize: 8, letterSpacing: '0.14em', color: T.MUTED, ...cinzel(), fontWeight: 600 }}>{k}</span>
            <span style={{ fontSize: 11, color: T.GOLD, fontWeight: 700, ...mono() }}>{v}</span>
          </div>
        ))}
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', columnGap: 16, rowGap: 2, fontSize: 11 }}>
        {slots.map(([slot, name, stats]) => (
          <div key={slot} style={{ display: 'grid', gridTemplateColumns: '68px 1fr', alignItems: 'baseline', padding: '3px 0', borderBottom: `1px solid rgba(255,255,255,0.04)` }}>
            <span style={{ color: T.MUTED, fontSize: 10, letterSpacing: '0.04em', textTransform: 'uppercase' }}>{slot}</span>
            <div style={{ minWidth: 0 }}>
              <span style={{ ...zodiak(), color: T.TEXT, fontSize: 12, fontWeight: 500 }}>{name}</span>
              <span style={{ color: T.PIE_BLUE, fontSize: 10, marginLeft: 6, ...mono() }}>[{stats}]</span>
            </div>
          </div>
        ))}
      </div>
    </CCPanel>
  );
}

function DesktopCommandFinal({ variant = 'default' }) {
  const W = 1440;
  const H = 900;
  const [selectedClass, setSelectedClass] = React.useState('Monk');
  const [mode, setMode] = React.useState('Melee');
  const [advanced, setAdvanced] = React.useState(true);
  const [buffs, setBuffs] = React.useState({
    'Visions of Grandeur': true,
    'Speed of the Shissar': false,
    'Warsong of the Vah Shir': true,
    "Koedic's Endless Intellect": false,
    'Ancient: Feral Avatar': true,
    'Savagery': false,
    'Call of the Predator': false,
  });

  const toggleBuff = (name) => setBuffs(b => ({ ...b, [name]: !b[name] }));

  const classes = ['Bard','Beastlord','Cleric','Druid','Enchanter','Magician','Monk','Necromancer','Paladin','Ranger','Rogue','Shadowknight','Shaman','Warrior','Wizard'];

  const pieSegs = [
    { pct: 61.1, color: T.PIE_BLUE, label: 'Primary hand' },
    { pct: 23.1, color: T.PIE_BLUE_DARK, label: 'Damage bonus' },
    { pct: 15.8, color: T.PIE_VIOLET, label: 'Flying Kick' },
  ];

  return (
    <div style={{
      width: W, height: H, background: T.BG, color: T.TEXT, ...satoshi(),
      display: 'flex', flexDirection: 'column', overflow: 'hidden',
      backgroundImage: 'radial-gradient(circle at 15% 0%, rgba(212,175,55,0.05) 0%, transparent 45%), radial-gradient(circle at 85% 100%, rgba(139,0,0,0.06) 0%, transparent 55%)',
    }}>
      {/* ─── Top bar ─── */}
      <div style={{
        height: 56, borderBottom: `1px solid ${T.BORDER}`,
        background: 'rgba(0,0,0,0.4)', backdropFilter: 'blur(12px)',
        display: 'flex', alignItems: 'center', padding: '0 20px', gap: 16, flexShrink: 0,
      }}>
        <div>
          <div style={{ ...cinzel(), fontSize: 19, fontWeight: 700, color: T.GOLD, letterSpacing: '0.02em', lineHeight: 1 }}>
            g<span style={{ fontSize: 16 }}>S</span>im <span style={{ color: T.MUTED, fontWeight: 400, fontSize: 10, letterSpacing: '0.25em', marginLeft: 4 }}>FOR PROJECT QUARM</span>
          </div>
          <div style={{ fontSize: 9, letterSpacing: '0.2em', color: T.MUTED, textTransform: 'uppercase', marginTop: 3 }}>EverQuest DPS Simulator · v1.13</div>
        </div>

        {/* Era selector */}
        <div style={{ marginLeft: 20, display: 'flex', alignItems: 'center', gap: 8, padding: '4px 10px', background: T.INPUT, border: `1px solid ${T.GOLD_BORDER}`, borderRadius: 4 }}>
          <span style={{ fontSize: 9, color: T.MUTED, letterSpacing: '0.16em', ...cinzel() }}>ERA</span>
          <span style={{ fontSize: 13, color: T.GOLD, ...zodiak(), fontWeight: 600 }}>Luclin</span>
          <span style={{ color: T.MUTED, fontSize: 10 }}>▾</span>
        </div>

        {/* Mode tabs */}
        <div style={{ display: 'flex', gap: 2, padding: 3, background: T.INPUT, borderRadius: 4, border: `1px solid ${T.BORDER}` }}>
          {['Melee','Ranged','Tanking'].map((m) => (
            <div key={m} onClick={() => m !== 'Tanking' && setMode(m)} style={{
              padding: '6px 14px', fontSize: 10, letterSpacing: '0.14em', textTransform: 'uppercase',
              fontWeight: 600, borderRadius: 3, cursor: m === 'Tanking' ? 'not-allowed' : 'pointer',
              background: mode === m ? T.GOLD_FAINT : 'transparent',
              color: mode === m ? T.GOLD : (m === 'Tanking' ? T.MUTED_DIM : T.MUTED), ...cinzel(),
            }}>{m}{m === 'Tanking' && <span style={{ fontSize: 8, marginLeft: 4, opacity: 0.6 }}>WIP</span>}</div>
          ))}
        </div>

        <div style={{ flex: 1 }} />

        {/* Persistent HUD */}
        <div style={{ display: 'flex', gap: 18, alignItems: 'center', padding: '7px 18px', background: 'rgba(0,0,0,0.55)', border: `1px solid ${T.GOLD_BORDER}`, borderRadius: 4, position: 'relative' }}>
          <div style={{ position: 'absolute', inset: 0, background: 'radial-gradient(ellipse at 100% 50%, rgba(212,175,55,0.08), transparent 70%)', borderRadius: 4, pointerEvents: 'none' }} />
          <div style={{ textAlign: 'right', position: 'relative' }}>
            <div style={{ fontSize: 9, letterSpacing: '0.14em', color: '#8a9aad', textTransform: 'uppercase', fontWeight: 600 }}>TPS <span style={{ fontSize: 7, opacity: 0.7 }}>BETA</span></div>
            <div style={{ ...cinzel(), fontSize: 22, fontWeight: 700, color: T.TPS_BLUE, lineHeight: 1 }}>100.72</div>
          </div>
          <div style={{ width: 1, height: 32, background: T.BORDER }} />
          <div style={{ textAlign: 'right', position: 'relative' }}>
            <div style={{ fontSize: 9, letterSpacing: '0.14em', color: T.MUTED, textTransform: 'uppercase', fontWeight: 600 }}>TOTAL DPS</div>
            <div style={{ ...cinzel(), fontSize: 26, fontWeight: 700, color: T.GOLD, lineHeight: 1, textShadow: '0 0 12px rgba(212,175,55,0.3)' }}>77.48</div>
          </div>
        </div>

        {/* Rank Weapons — secondary CTA */}
        <div title="Test all equippable weapons (top 200 combinations)" style={{
          padding: '10px 16px', border: `1px solid ${T.GOLD_DIM}`,
          background: 'rgba(0,0,0,0.5)',
          borderRadius: 4, fontSize: 11, color: T.GOLD, letterSpacing: '0.16em', textTransform: 'uppercase',
          ...cinzel(), fontWeight: 700, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 6,
        }}>
          <span style={{ fontSize: 13 }}>🏆</span> Rank All
        </div>

        {/* Run button — prominent CTA */}
        <div style={{
          padding: '10px 24px', border: `1.5px solid ${T.GOLD_BRIGHT}`,
          background: `linear-gradient(145deg, ${T.GOLD} 0%, #8a6b14 100%)`,
          borderRadius: 4, fontSize: 13, color: '#0a0a0c', letterSpacing: '0.18em', textTransform: 'uppercase',
          ...cinzel(), fontWeight: 800, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 8,
          boxShadow: '0 0 24px rgba(232,197,71,0.45), inset 0 1px 0 rgba(255,255,255,0.3)',
          textShadow: '0 1px 0 rgba(255,255,255,0.25)',
        }}>
          <span style={{ fontSize: 16 }}>⚡</span> Run Sim
        </div>

        {/* Easy / Advanced */}
        <div onClick={() => setAdvanced(a => !a)} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 9, letterSpacing: '0.14em', ...cinzel(), cursor: 'pointer', userSelect: 'none' }}>
          <span style={{ color: advanced ? T.MUTED : T.GOLD, fontWeight: advanced ? 400 : 700 }}>EASY</span>
          <div style={{ width: 36, height: 18, borderRadius: 999, background: T.INPUT, border: `1px solid ${T.GOLD_DIM}`, position: 'relative' }}>
            <div style={{ position: 'absolute', top: 2, left: advanced ? 'auto' : 2, right: advanced ? 2 : 'auto', width: 12, height: 12, borderRadius: '50%', background: `linear-gradient(145deg, ${T.GOLD_BRIGHT}, #9a7209)`, boxShadow: '0 0 8px rgba(212,175,55,0.5)', transition: 'all 0.18s' }} />
          </div>
          <span style={{ color: advanced ? T.GOLD : T.MUTED, fontWeight: advanced ? 700 : 400 }}>ADVANCED</span>
        </div>
      </div>

      {/* ─── Body: 3 panes ─── */}
      <div style={{ flex: 1, display: 'grid', gridTemplateColumns: '200px 1fr 400px', gap: 0, overflow: 'hidden', minHeight: 0 }}>

        {/* LEFT: Class rail */}
        <div style={{ borderRight: `1px solid ${T.BORDER}`, background: 'rgba(0,0,0,0.25)', padding: '12px 10px', overflowY: 'hidden', display: 'flex', flexDirection: 'column' }}>
          <div style={{ fontSize: 9, letterSpacing: '0.2em', color: T.MUTED, textTransform: 'uppercase', marginBottom: 8, padding: '0 4px', ...cinzel(), fontWeight: 600 }}>Class</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 1, flex: 1, overflowY: 'auto' }}>
            {classes.map(c => {
              const active = c === selectedClass;
              return (
                <div key={c} onClick={() => setSelectedClass(c)} style={{
                  padding: '7px 10px', fontSize: 11, borderRadius: 3, cursor: 'pointer',
                  ...cinzel(), letterSpacing: '0.08em',
                  background: active ? 'linear-gradient(90deg, rgba(139,0,0,0.25) 0%, rgba(139,0,0,0) 100%)' : 'transparent',
                  borderLeft: active ? `3px solid ${T.CRIMSON}` : '3px solid transparent',
                  color: active ? T.GOLD : T.TEXT_DIM,
                  border: active ? `1px solid ${T.GOLD_DIM}` : '1px solid transparent',
                  borderLeftWidth: 3,
                  fontWeight: active ? 700 : 400,
                }}>{c.toUpperCase()}</div>
              );
            })}
          </div>
        </div>

        {/* CENTER: Build editor */}
        <div style={{ padding: 14, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 12 }}>

          {/* Character + haste */}
          <CCPanel>
            <CCSectionLabel hint={`${selectedClass} · Lvl 60`}>Character & Haste</CCSectionLabel>

            {/* Race selector — determines starting stats */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12, padding: '6px 10px', background: T.INPUT, border: `1px solid ${T.GOLD_DIM}`, borderRadius: 3 }}>
              <span style={{ fontSize: 9, letterSpacing: '0.14em', color: T.MUTED, textTransform: 'uppercase', ...cinzel(), fontWeight: 600 }}>Race</span>
              <div style={{ flex: 1, ...zodiak(), fontSize: 13, color: T.GOLD, fontWeight: 600, display: 'flex', alignItems: 'center', gap: 6 }}>
                Human <span style={{ color: T.MUTED, fontSize: 10, ...satoshi(), fontWeight: 400 }}>· STR 75 STA 75 AGI 75 DEX 75 WIS 80 INT 75</span>
              </div>
              <span style={{ color: T.GOLD, fontSize: 11 }}>▾</span>
            </div>
            <div style={{ display: 'flex', gap: 3, marginBottom: 12, flexWrap: 'wrap' }}>
              {['Human','Barbarian','Iksar','Vah Shir'].map((r, i) => (
                <div key={r} style={{
                  padding: '3px 9px', fontSize: 9, letterSpacing: '0.1em', ...cinzel(), fontWeight: 600, textTransform: 'uppercase',
                  borderRadius: 2, cursor: 'pointer',
                  background: i === 0 ? T.GOLD_FAINT : 'transparent',
                  color: i === 0 ? T.GOLD : T.MUTED,
                  border: `1px solid ${i === 0 ? T.GOLD_DIM : T.BORDER}`,
                }}>{r}</div>
              ))}
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: 'auto 1px 1fr', gap: 16, alignItems: 'flex-start' }}>
              <table style={{ borderCollapse: 'collapse' }}>
                <thead>
                  <tr>
                    {['Stat','Base','+Pts','Gear','Final'].map(h => (
                      <th key={h} style={{ fontSize: 9, color: T.MUTED, letterSpacing: '0.08em', textTransform: 'uppercase', padding: '2px 6px', textAlign: h === 'Stat' ? 'left' : (h === '+Pts' ? 'center' : 'right'), fontWeight: 600 }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  <CCStatRow name="STR" base={75} pts={0} gear={229} final={255} />
                  <CCStatRow name="AGI" base={75} pts={0} gear={134} final={209} />
                  <CCStatRow name="DEX" base={75} pts={0} gear={111} final={186} />
                  <CCStatRow name="STA" base={75} pts={0} gear={182} final={255} />
                </tbody>
              </table>

              <div style={{ background: T.BORDER, alignSelf: 'stretch' }} />

              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                <div style={{ fontSize: 9, letterSpacing: '0.1em', color: T.MUTED_DIM, textTransform: 'uppercase', marginBottom: -4, textAlign: 'right' }}>
                  {advanced ? 'MANUAL HASTE' : 'AUTO HASTE'}
                </div>
                {advanced ? (
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <CCField label="Worn Haste" hint="%" value="41" w={56} accent />
                    <div style={{ flex: 1, fontSize: 9, color: T.MUTED_DIM, lineHeight: 1.4, paddingTop: 14 }}>
                      Override detected value. Min 0 · Max 100. Applies before caps.
                    </div>
                  </div>
                ) : (
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                    <div style={{ flex: 1, height: 4, background: T.INPUT, borderRadius: 2, position: 'relative', cursor: 'pointer' }}>
                      <div style={{ width: '41%', height: '100%', background: `linear-gradient(90deg, ${T.GOLD_DIM}, ${T.GOLD})`, borderRadius: 2 }} />
                      <div style={{ position: 'absolute', left: '41%', top: -4, width: 12, height: 12, borderRadius: '50%', background: T.GOLD, boxShadow: '0 0 8px rgba(212,175,55,0.5)', transform: 'translateX(-50%)' }} />
                    </div>
                    <div style={{ ...cinzel(), fontSize: 15, fontWeight: 700, color: T.GOLD, ...mono() }}>41%</div>
                  </div>
                )}
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                  <CCField label="v1 Haste" hint="%" value="60" w={56} />
                  <CCField label="v3 Haste" hint="%" value="0" w={56} />
                  <CCField label="Worn ATK" value="95" w={56} accent />
                  <CCField label="Spell ATK" value="0" w={56} />
                </div>
                <div style={{ fontSize: 10, color: T.MUTED, fontStyle: 'italic', marginTop: -2 }}>Highest haste src: Silver Bracelet of Speed (41%)</div>
              </div>
            </div>
          </CCPanel>

          {/* Equipped items */}
          <CCEquipped />

          {/* Weapons: MH + swap + OH */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 44px 1fr', gap: 10, alignItems: 'stretch' }}>
            <CCPanel>
              <CCSectionLabel hint="Main Hand">Weapon 1</CCSectionLabel>
              <div style={{ display: 'flex', gap: 12 }}>
                <div style={{ width: 52, height: 52, background: T.INPUT, border: `1px solid ${T.BORDER}`, borderRadius: 4, display: 'flex', alignItems: 'center', justifyContent: 'center', color: T.GOLD_DIM, fontSize: 20 }}>◈</div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ ...zodiak(), fontSize: 15, fontWeight: 700, color: T.TEXT, marginBottom: 2 }}>Caen's Bo Staff of Fury</div>
                  <div style={{ fontSize: 10, color: T.MUTED, letterSpacing: '0.04em' }}>2H BLUNT · 43d / 30 delay · STR +16 STA +15 AGI +20</div>
                  <div style={{
                    marginTop: 6, height: 26, background: T.INPUT, border: `1px solid ${T.BORDER}`, borderRadius: 3,
                    padding: '0 10px', display: 'flex', alignItems: 'center', fontSize: 11, color: T.MUTED,
                  }}>
                    <span style={{ marginRight: 6, color: T.GOLD_DIM }}>⌕</span> Type 4+ chars to search…
                  </div>
                </div>
              </div>
              <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
                <CCField label="Damage" value="43" w={48} />
                <CCField label="Delay" value="30" w={48} />
                <CCField label="Proc" value="—" w={56} />
                <CCField label="Elem" value="—" w={56} />
              </div>
              <div style={{ marginTop: 8, fontSize: 10, color: T.GOLD, letterSpacing: '0.1em', cursor: 'pointer', ...cinzel(), fontWeight: 600 }}>▸ PROC, ELEMENTAL & BANE</div>
            </CCPanel>

            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              <div title="Swap MH/OH" style={{ width: 36, height: 36, border: `1px solid ${T.GOLD_DIM}`, borderRadius: 6, background: T.INPUT, display: 'flex', alignItems: 'center', justifyContent: 'center', color: T.GOLD, fontSize: 16, cursor: 'pointer', transform: 'rotate(90deg)' }}>⇅</div>
            </div>

            <CCPanel style={{ opacity: 0.6 }}>
              <CCSectionLabel hint="Offhand · Disabled (2H)">Weapon 2</CCSectionLabel>
              <div style={{ display: 'flex', gap: 12 }}>
                <div style={{ width: 52, height: 52, background: T.INPUT, border: `1px dashed ${T.BORDER}`, borderRadius: 4 }} />
                <div style={{ flex: 1 }}>
                  <div style={{ ...zodiak(), fontSize: 15, fontWeight: 600, color: T.MUTED, textDecoration: 'line-through' }}>Unequipped</div>
                  <div style={{ fontSize: 10, color: T.MUTED }}>Offhand blocked while main hand is 2H.</div>
                  <div style={{
                    marginTop: 6, height: 26, background: T.INPUT, border: `1px solid ${T.BORDER}`, borderRadius: 3,
                    padding: '0 10px', display: 'flex', alignItems: 'center', fontSize: 11, color: T.MUTED_DIM,
                  }}>
                    <span style={{ marginRight: 6 }}>⌕</span> Search offhand…
                  </div>
                </div>
              </div>
              <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
                <CCField label="Damage" value="0" w={48} />
                <CCField label="Delay" value="0" w={48} />
                <CCField label="Proc" value="—" w={56} />
                <CCField label="Elem" value="—" w={56} />
              </div>
            </CCPanel>
          </div>

          {/* Target & Fight */}
          <CCPanel>
            <CCSectionLabel hint="Simulation parameters">Target & Fight</CCSectionLabel>
            <div style={{ marginBottom: 10 }}>
              <div style={{ fontSize: 9, color: T.MUTED, letterSpacing: '0.1em', textTransform: 'uppercase', marginBottom: 4 }}>Target NPC</div>
              <div style={{ height: 30, background: T.INPUT, border: `1px solid ${T.GOLD_DIM}`, borderRadius: 3, padding: '0 10px', display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: T.TEXT, ...zodiak() }}>
                Kaas Thox Xi Aten Ha Ra <span style={{ fontSize: 10, color: T.MUTED, ...satoshi() }}>· Lvl 66 · AC 800</span>
                <div style={{ flex: 1 }} />
                <span style={{ color: T.MUTED, fontSize: 12, cursor: 'pointer' }}>×</span>
              </div>
            </div>
            <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end', flexWrap: 'wrap' }}>
              <CCField label="Target AC" value="800" w={60} />
              <CCField label="Mob Lvl" value="66" w={46} />
              <CCField label="Duration" hint="s" value="6000" w={60} />
              <CCField label="Runs" value="20" w={46} />
              {!advanced && (
                <div>
                  <div style={{ fontSize: 9, color: T.MUTED, letterSpacing: '0.1em', textTransform: 'uppercase', marginBottom: 4 }}>Content</div>
                  <div style={{ display: 'flex', gap: 4 }}>
                    <CCPill active>Group</CCPill>
                    <CCPill>Raid</CCPill>
                  </div>
                </div>
              )}
              {advanced && (
                <div style={{ fontSize: 10, color: T.MUTED_DIM, fontStyle: 'italic', alignSelf: 'center' }}>
                  Content-type preset disabled in Advanced — set individual mob / AC / lvl above.
                </div>
              )}
            </div>
          </CCPanel>

          {/* Skills & Options — collapsed link, as in original */}
          <CCPanel style={{ padding: '10px 14px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
              <span style={{ color: T.GOLD, fontSize: 12 }}>▸</span>
              <span style={{ ...cinzel(), fontSize: 10, letterSpacing: '0.14em', textTransform: 'uppercase', color: T.GOLD, fontWeight: 700 }}>Skills & Options</span>
              <span style={{ fontSize: 10, color: T.MUTED, marginLeft: 8 }}>auto-filled from class · click to override</span>
            </div>
          </CCPanel>

          {/* AA + Buffs */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
            <CCPanel>
              <CCSectionLabel hint="4 active · 14 pts">Alternate Advancement</CCSectionLabel>
              <div style={{ fontSize: 9, letterSpacing: '0.1em', color: T.MUTED, textTransform: 'uppercase', marginBottom: 6, ...cinzel() }}>LUCLIN — ARCHETYPE</div>
              {[
                ['Combat Fury', 3, 3], ['Combat Stability', 1, 3], ['Combat Agility', 0, 3], ['Natural Durability', 1, 3],
              ].map(([name, val, max]) => (
                <div key={name} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '4px 0', fontSize: 11 }}>
                  <span style={{ color: T.TEXT }}>{name}</span>
                  <div style={{ display: 'flex', gap: 2 }}>
                    {Array.from({ length: max + 1 }, (_, i) => (
                      <div key={i} style={{
                        width: 20, height: 20, borderRadius: 2, border: `1px solid ${i <= val ? T.GOLD_DIM : T.BORDER}`,
                        background: i <= val && i > 0 ? T.GOLD_FAINT : T.INPUT,
                        color: i <= val ? T.GOLD : T.MUTED, fontSize: 10, fontWeight: 600,
                        display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', ...mono(),
                      }}>{i}</div>
                    ))}
                  </div>
                </div>
              ))}
              <div style={{ fontSize: 9, letterSpacing: '0.1em', color: T.MUTED, textTransform: 'uppercase', margin: '10px 0 6px', ...cinzel() }}>LUCLIN — MONK</div>
              {[['Ambidexterity', 1, 1], ['Double Riposte', 0, 3], ['Return Kick', 0, 3]].map(([name, val, max]) => (
                <div key={name} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '4px 0', fontSize: 11 }}>
                  <span style={{ color: T.TEXT }}>{name}</span>
                  <div style={{ display: 'flex', gap: 2 }}>
                    {Array.from({ length: max + 1 }, (_, i) => (
                      <div key={i} style={{
                        width: 20, height: 20, borderRadius: 2, border: `1px solid ${i <= val ? T.GOLD_DIM : T.BORDER}`,
                        background: i <= val && i > 0 ? T.GOLD_FAINT : T.INPUT,
                        color: i <= val ? T.GOLD : T.MUTED, fontSize: 10, fontWeight: 600,
                        display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', ...mono(),
                      }}>{i}</div>
                    ))}
                  </div>
                </div>
              ))}
            </CCPanel>

            <CCPanel>
              <CCSectionLabel hint={`${Object.values(buffs).filter(Boolean).length} active`} action="EXPAND ALL">Buffs</CCSectionLabel>
              {[
                ['HASTE', [
                  ['Visions of Grandeur','ENC'],
                  ['Speed of the Shissar','ENC'],
                  ['Warsong of the Vah Shir','BRD'],
                  ['Swift Like the Wind','BRD'],
                ]],
                ['OFFENSIVE', [
                  ["Koedic's Endless Intellect",'ENC'],
                  ['Call of the Predator','RNG'],
                  ['Ancient: Feral Avatar','SHM'],
                  ['Savagery','BST'],
                  ['Strength of Nature','DRU'],
                ]],
                ['BARD SONGS', [
                  ['Chorus of Replenishment','BRD'],
                  ['McVaxius War March','BRD'],
                  ['Composition of Ervaj','BRD'],
                ]],
                ['POTIONS & CLICKIES', [
                  ['Clarity Potion','POT'],
                  ['Rage of Zek','CLK'],
                  ['Epic 1.0 Click','EPI'],
                ]],
                ['SLOT BUFFS', [
                  ['Spirit of Wolf','DRU'],
                  ['Focus of Spirit','SHM'],
                  ['Brell\'s Stalwart Shield','CLR'],
                ]],
              ].map(([cat, items]) => (
                <div key={cat}>
                  <div style={{ fontSize: 9, letterSpacing: '0.1em', color: T.GOLD, textTransform: 'uppercase', margin: '8px 0 4px', ...cinzel(), display: 'flex', justifyContent: 'space-between' }}>
                    <span>{cat}</span>
                    <span style={{ color: T.MUTED, fontWeight: 400 }}>{items.filter(([n]) => buffs[n]).length}/{items.length}</span>
                  </div>
                  {items.map(([n, s]) => {
                    const on = !!buffs[n];
                    return (
                      <div key={n} onClick={() => toggleBuff(n)} style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '2px 0', fontSize: 11, cursor: 'pointer' }}>
                        <div style={{ width: 12, height: 12, borderRadius: 2, border: `1px solid ${on ? T.GOLD : T.BORDER}`, background: on ? T.GOLD : 'transparent', display: 'flex', alignItems: 'center', justifyContent: 'center', color: T.BG, fontSize: 9, fontWeight: 800 }}>{on && '✓'}</div>
                        <span style={{ color: on ? T.TEXT : T.MUTED, flex: 1 }}>{n}</span>
                        <span style={{ fontSize: 8, color: T.MUTED, letterSpacing: '0.1em', fontWeight: 600 }}>{s}</span>
                      </div>
                    );
                  })}
                </div>
              ))}
              <div style={{ marginTop: 10, padding: '6px 10px', background: 'rgba(212,175,55,0.06)', border: `1px solid ${T.GOLD_BORDER}`, borderRadius: 3, fontSize: 10, display: 'flex', gap: 12, flexWrap: 'wrap' }}>
                <span style={{ color: T.MUTED }}>Haste: <span style={{ color: T.GOLD, fontWeight: 700, ...mono() }}>+60%</span></span>
                <span style={{ color: T.MUTED }}>ATK: <span style={{ color: T.GOLD, fontWeight: 700, ...mono() }}>+95</span></span>
                <span style={{ color: T.MUTED }}>STR: <span style={{ color: T.GOLD, fontWeight: 700, ...mono() }}>+55</span></span>
              </div>
            </CCPanel>
          </div>

          {/* Report — advanced mode only, below AA + Buffs */}
          {advanced && (
            <CCPanel>
              <CCSectionLabel hint="Plaintext · scrollable" action="EXPORT .TXT">Report</CCSectionLabel>
              <div style={{ background: T.INPUT, border: `1px solid ${T.BORDER}`, borderRadius: 3, padding: 10, ...mono(), fontSize: 10, color: T.TEXT_DIM, lineHeight: 1.55, maxHeight: 220, overflowY: 'auto', whiteSpace: 'pre' }}>
{`Weapon skill cap (2hb): 252 (Quarm/TAKP)
Target: Kaas Thox Xi Aten Ha Ra, Lvl 66, AC 800

`}<span style={{ color: T.GOLD }}>═══ Executive Summary ═══</span>{`
  Duration:          6000 seconds
  Runs averaged:     20
  Total DPS:         77.48
  DPS std dev:       0.39
  Total damage:      464,851
  TPS (approx):      100.72
  Critical hits:     390
  Crit DPS gain:     3.37

`}<span style={{ color: T.GOLD }}>═══ Offense & To-Hit Model ═══</span>{`
  Calculated to-hit: 511
  Offense skill:     252 (0-255)
  Offense rating:    467
    From STR:        120
    From other:      347
  Displayed ATK:     1314
  Haste (eff):       100.0%`}
              </div>
            </CCPanel>
          )}
        </div>

        {/* RIGHT: Live results */}
        <div style={{ borderLeft: `1px solid ${T.BORDER}`, background: 'rgba(0,0,0,0.3)', padding: 14, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 14 }}>
          <CCSectionLabel hint="Last run · 20 avg">Results</CCSectionLabel>

          {/* Big number */}
          <div style={{
            padding: 14, background: `linear-gradient(145deg, rgba(212,175,55,0.08), rgba(0,0,0,0.45))`,
            border: `1px solid ${T.GOLD_BORDER}`, borderRadius: 4, textAlign: 'center',
            position: 'relative', overflow: 'hidden',
          }}>
            <div style={{ position: 'absolute', inset: 0, background: 'radial-gradient(ellipse at top, rgba(212,175,55,0.12), transparent 60%)' }} />
            <div style={{ fontSize: 9, letterSpacing: '0.22em', color: T.MUTED, textTransform: 'uppercase', ...cinzel(), fontWeight: 600, position: 'relative' }}>Resulting DPS</div>
            <div style={{ ...cinzel(), fontSize: 52, fontWeight: 700, color: T.GOLD, lineHeight: 1, margin: '6px 0', textShadow: '0 0 24px rgba(212,175,55,0.3)', position: 'relative' }}>77.48</div>
            <div style={{ fontSize: 10, color: T.MUTED, letterSpacing: '0.06em', position: 'relative' }}>σ 0.39 · crit +3.37 · 390 crits · 464,851 dmg</div>
          </div>

          {/* Pie */}
          <div>
            <CCSectionLabel>Damage Breakdown</CCSectionLabel>
            <div style={{ display: 'flex', gap: 14, alignItems: 'center' }}>
              <CCDamagePie size={110} segs={pieSegs} />
              <div style={{ flex: 1, fontSize: 11 }}>
                {pieSegs.map((s) => (
                  <div key={s.label} style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6 }}>
                    <div style={{ width: 10, height: 10, background: s.color, borderRadius: 1 }} />
                    <span style={{ color: T.TEXT }}>{s.label}</span>
                    <span style={{ marginLeft: 'auto', color: T.GOLD, ...mono(), fontWeight: 600 }}>{s.pct}%</span>
                  </div>
                ))}
                <div style={{ marginTop: 8, padding: '6px 8px', background: T.INPUT, borderRadius: 3, fontSize: 10, color: T.MUTED, ...mono() }}>
                  Total: <span style={{ color: T.TEXT }}>464,851</span>
                </div>
              </div>
            </div>
          </div>

          {/* Charts */}
          <div>
            <CCSectionLabel>Per-Swing Damage</CCSectionLabel>
            <div style={{ fontSize: 10, color: T.TEXT, marginBottom: 4, display: 'flex', justifyContent: 'space-between' }}>
              <span>Caen's Bo — 43d/30</span>
              <span style={{ color: T.MUTED, ...mono() }}>4,389 hits · 33–374</span>
            </div>
            <CCHistogram count={36} color={T.GOLD} seed={7} />
            <div style={{ marginTop: 10, fontSize: 10, color: T.TEXT, marginBottom: 4, display: 'flex', justifyContent: 'space-between' }}>
              <span>Flying Kick</span>
              <span style={{ color: T.MUTED, ...mono() }}>941 hits · 48–283</span>
            </div>
            <CCHistogram count={36} color={T.PIE_VIOLET} seed={23} />
          </div>

          {/* Session history */}
          <div>
            <CCSectionLabel hint="2 runs this session" action="CLEAR">Session History</CCSectionLabel>
            <div style={{ background: T.INPUT, border: `1px solid ${T.BORDER}`, borderRadius: 3, ...mono(), fontSize: 10 }}>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 56px 56px 44px 40px', padding: '6px 8px', borderBottom: `1px solid ${T.BORDER}`, color: T.MUTED, letterSpacing: '0.06em', textTransform: 'uppercase', fontSize: 9 }}>
                <span>Weapon</span><span style={{ textAlign: 'right' }}>ATK</span><span style={{ textAlign: 'right' }}>DPS</span><span style={{ textAlign: 'right' }}>Era</span><span style={{ textAlign: 'right' }}>Mode</span>
              </div>
              {[
                ['43d / 30', '1314', '77.48', 'Lucl', 'ADV'],
                ['43d / 30', '1516', '144.89', 'Lucl', 'EZ'],
              ].map((r, i) => (
                <div key={i} style={{ display: 'grid', gridTemplateColumns: '1fr 56px 56px 44px 40px', padding: '6px 8px', borderBottom: i === 0 ? `1px solid ${T.BORDER}` : 'none', fontSize: 10 }}>
                  <span style={{ color: T.TEXT }}>{r[0]}</span>
                  <span style={{ textAlign: 'right', color: T.TEXT }}>{r[1]}</span>
                  <span style={{ textAlign: 'right', color: T.GOLD, fontWeight: 700 }}>{r[2]}</span>
                  <span style={{ textAlign: 'right', color: T.MUTED }}>{r[3]}</span>
                  <span style={{ textAlign: 'right', color: r[4] === 'ADV' ? T.GOLD : '#6ee7b7' }}>{r[4]}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

window.DesktopCommandFinal = DesktopCommandFinal;
