// Mobile — Tabbed Stepper (final)
// Bottom tab nav: Build · Sim · Report · History. Each tab is a single scroll column.

const MT = window.GSIM_THEME;

function mCinzel() { return { fontFamily: MT.FONT_DISPLAY }; }
function mSatoshi() { return { fontFamily: MT.FONT_BODY }; }
function mZodiak() { return { fontFamily: MT.FONT_SERIF }; }
function mMono() { return { fontFamily: MT.FONT_MONO }; }

function MSection({ title, hint, children, action }) {
  return (
    <div style={{ padding: 12, borderRadius: 8, background: MT.PANEL, border: `1px solid ${MT.BORDER}`, marginBottom: 10 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 8 }}>
        <div style={{ ...mCinzel(), fontSize: 9, letterSpacing: '0.2em', color: MT.GOLD, textTransform: 'uppercase', fontWeight: 700 }}>{title}</div>
        {hint && <div style={{ fontSize: 9, color: MT.MUTED }}>{hint}</div>}
        {action && <div style={{ fontSize: 9, color: MT.GOLD, letterSpacing: '0.1em' }}>{action}</div>}
      </div>
      {children}
    </div>
  );
}

function MStatChip({ k, v }) {
  return (
    <div style={{ background: MT.INPUT, borderRadius: 4, padding: '6px 2px', textAlign: 'center', border: `1px solid ${MT.BORDER}` }}>
      <div style={{ fontSize: 8, color: MT.MUTED, letterSpacing: '0.14em' }}>{k}</div>
      <div style={{ ...mCinzel(), fontSize: 14, color: MT.GOLD, fontWeight: 700, ...mMono() }}>{v}</div>
    </div>
  );
}

function MPie({ size = 90, segs }) {
  const r = size/2; let a = -Math.PI/2;
  const arcs = segs.map((s, i) => {
    const end = a + (s.pct/100)*Math.PI*2;
    const x1 = r + r*Math.cos(a), y1 = r + r*Math.sin(a);
    const x2 = r + r*Math.cos(end), y2 = r + r*Math.sin(end);
    const large = end - a > Math.PI ? 1 : 0;
    const d = `M${r},${r} L${x1},${y1} A${r},${r} 0 ${large} 1 ${x2},${y2} Z`;
    a = end; return <path key={i} d={d} fill={s.color}/>;
  });
  return <svg width={size} height={size}>{arcs}<circle cx={r} cy={r} r={r*0.52} fill={MT.PANEL}/></svg>;
}

function MHistogram({ color, seed = 1 }) {
  const bars = Array.from({ length: 28 }, (_, i) => {
    const t = i / 27;
    const n = Math.sin(seed * 12.9898 + i * 78.233) * 43758.5453;
    const noise = n - Math.floor(n);
    const bell = Math.exp(-Math.pow((t - 0.35) * 2.5, 2)) * 0.85 + 0.1;
    return 5 + bell * 36 + noise * 5;
  });
  return (
    <div style={{ display: 'flex', alignItems: 'flex-end', gap: 1.5, height: 44 }}>
      {bars.map((h, i) => <div key={i} style={{ flex: 1, height: h, background: color, borderRadius: '1.5px 1.5px 0 0', opacity: 0.85 }} />)}
    </div>
  );
}

// ─────────── Tab content ───────────

function MBuildTab() {
  const [easyMode, setEasyMode] = React.useState(false);
  return (
    <>
      <MSection title="Class" hint="Monk · Human · Lvl 60" action="CHANGE ›">
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', padding: '4px 0' }}>
          <div style={{ width: 40, height: 40, border: `1px solid ${MT.GOLD_BORDER}`, background: `linear-gradient(145deg, rgba(139,0,0,0.3), rgba(0,0,0,0.4))`, borderRadius: 4, display: 'flex', alignItems: 'center', justifyContent: 'center', color: MT.GOLD, fontSize: 18 }}>◈</div>
          <div style={{ flex: 1 }}>
            <div style={{ ...mCinzel(), color: MT.GOLD, fontSize: 14, fontWeight: 700, letterSpacing: '0.08em' }}>MONK</div>
            <div style={{ fontSize: 10, color: MT.MUTED }}>Melee · 2H specialist</div>
          </div>
        </div>
      </MSection>

      <MSection title="Character Stats" hint="Auto · +16 pts remaining">
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 6 }}>
          <MStatChip k="STR" v="255" />
          <MStatChip k="AGI" v="209" />
          <MStatChip k="DEX" v="186" />
          <MStatChip k="STA" v="255" />
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 6, marginTop: 6 }}>
          <MStatChip k="AC" v="445" />
          <MStatChip k="HP" v="1820" />
          <MStatChip k="ATK" v="95" />
          <MStatChip k="HASTE" v="41%" />
        </div>
      </MSection>

      <MSection title="Worn Haste" hint={easyMode ? 'EASY · SLIDER' : 'ADVANCED · INPUT'} action={<span onClick={() => setEasyMode(e => !e)}>TOGGLE</span>}>
        {easyMode ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <div style={{ flex: 1, height: 4, background: MT.INPUT, borderRadius: 2, position: 'relative' }}>
              <div style={{ width: '41%', height: '100%', background: `linear-gradient(90deg, ${MT.GOLD_DIM}, ${MT.GOLD})`, borderRadius: 2 }} />
              <div style={{ position: 'absolute', left: '41%', top: -6, width: 16, height: 16, borderRadius: '50%', background: MT.GOLD, boxShadow: '0 0 8px rgba(212,175,55,0.5)', transform: 'translateX(-50%)' }} />
            </div>
            <div style={{ ...mCinzel(), fontSize: 16, fontWeight: 700, color: MT.GOLD, ...mMono() }}>41%</div>
          </div>
        ) : (
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <div style={{ width: 72, height: 34, background: MT.INPUT, border: `1px solid ${MT.GOLD_DIM}`, borderRadius: 4, display: 'flex', alignItems: 'center', justifyContent: 'flex-end', padding: '0 10px', ...mMono(), fontSize: 16, color: MT.GOLD, fontWeight: 700 }}>41%</div>
            <div style={{ flex: 1, fontSize: 10, color: MT.MUTED_DIM, lineHeight: 1.4 }}>Override detected. Applies before caps.</div>
          </div>
        )}
        <div style={{ marginTop: 8, fontSize: 10, color: MT.MUTED, fontStyle: 'italic' }}>Highest: Silver Bracelet of Speed (41%)</div>
      </MSection>

      <MSection title="Equipped Items" hint="20 slots · 445 AC">
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2, fontSize: 11 }}>
          {[
            ['Primary', "Caen's Bo Staff of Fury", '43d/30'],
            ['Head', 'Crown of the Kromzek Kings', '+25 STR'],
            ['Back', 'Cloak of Destruction', '+35 STR'],
            ['Legs', 'Flayed Barbarian Leggings', '+60 STR'],
            ['Wrist', 'Silver Bracelet of Speed', '+41% Haste'],
            ['Fingers', 'Ring of Rage', '+20 STR'],
          ].map(([slot, name, stat]) => (
            <div key={slot} style={{ display: 'grid', gridTemplateColumns: '60px 1fr auto', alignItems: 'baseline', padding: '5px 0', borderBottom: `1px solid rgba(255,255,255,0.04)`, gap: 6 }}>
              <span style={{ color: MT.MUTED, fontSize: 9, letterSpacing: '0.06em', textTransform: 'uppercase' }}>{slot}</span>
              <span style={{ ...mZodiak(), color: MT.TEXT, fontSize: 12, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{name}</span>
              <span style={{ color: MT.GOLD, fontSize: 10, ...mMono() }}>{stat}</span>
            </div>
          ))}
          <div style={{ padding: '8px 0 0', textAlign: 'center', fontSize: 10, color: MT.GOLD, letterSpacing: '0.12em', ...mCinzel() }}>+ VIEW ALL 20 SLOTS</div>
        </div>
      </MSection>

      <MSection title="Buffs" hint="5 of 7 active">
        {[
          ['Visions of Grandeur', 'ENC', true],
          ['Warsong of the Vah Shir', 'BRD', true],
          ['Ancient: Feral Avatar', 'SHM', true],
          ['Speed of the Shissar', 'ENC', false],
          ['Savagery', 'BST', false],
        ].map(([n, s, on]) => (
          <div key={n} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '5px 0', fontSize: 11 }}>
            <div style={{ width: 14, height: 14, borderRadius: 3, border: `1px solid ${on ? MT.GOLD : MT.BORDER}`, background: on ? MT.GOLD : 'transparent', display: 'flex', alignItems: 'center', justifyContent: 'center', color: MT.BG, fontSize: 9, fontWeight: 800 }}>{on && '✓'}</div>
            <span style={{ color: on ? MT.TEXT : MT.MUTED, flex: 1 }}>{n}</span>
            <span style={{ fontSize: 8, color: MT.MUTED, letterSpacing: '0.1em' }}>{s}</span>
          </div>
        ))}
      </MSection>
    </>
  );
}

function MSimTab() {
  return (
    <>
      {/* Hero DPS */}
      <div style={{
        position: 'relative', padding: 16, borderRadius: 10,
        background: `radial-gradient(circle at 50% 0%, rgba(212,175,55,0.14), ${MT.PANEL})`,
        border: `1px solid ${MT.GOLD_BORDER}`, textAlign: 'center', marginBottom: 12,
        boxShadow: '0 4px 20px rgba(0,0,0,0.4)',
      }}>
        <div style={{ fontSize: 9, letterSpacing: '0.25em', color: MT.MUTED, textTransform: 'uppercase', ...mCinzel(), fontWeight: 600 }}>Total DPS</div>
        <div style={{ ...mCinzel(), fontSize: 58, fontWeight: 700, color: MT.GOLD, lineHeight: 1, margin: '4px 0', textShadow: '0 0 30px rgba(212,175,55,0.3)' }}>77.48</div>
        <div style={{ display: 'flex', justifyContent: 'center', gap: 14, marginTop: 6, fontSize: 10, color: MT.MUTED, letterSpacing: '0.08em' }}>
          <span>TPS <span style={{ color: MT.TPS_BLUE, fontWeight: 700 }}>100.72</span></span>
          <span>σ <span style={{ color: MT.TEXT }}>0.39</span></span>
          <span>Crits <span style={{ color: MT.TEXT }}>390</span></span>
        </div>
      </div>

      <MSection title="Target & Fight">
        <div style={{ ...mZodiak(), fontSize: 14, color: MT.TEXT, marginBottom: 4 }}>Kaas Thox Xi Aten Ha Ra</div>
        <div style={{ fontSize: 10, color: MT.MUTED }}>Lvl 66 · AC 800 · 6000s · 20 runs · Group</div>
      </MSection>

      <MSection title="Damage Breakdown">
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <MPie segs={[
            { pct: 61.1, color: MT.PIE_BLUE },
            { pct: 23.1, color: MT.PIE_BLUE_DARK },
            { pct: 15.8, color: MT.PIE_VIOLET },
          ]}/>
          <div style={{ flex: 1, fontSize: 11 }}>
            {[['Primary',61.1,MT.PIE_BLUE],['Bonus',23.1,MT.PIE_BLUE_DARK],['Flying Kick',15.8,MT.PIE_VIOLET]].map(([n,p,c]) => (
              <div key={n} style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 5 }}>
                <div style={{ width: 9, height: 9, background: c, borderRadius: 1 }} />
                <span style={{ color: MT.TEXT }}>{n}</span>
                <span style={{ marginLeft: 'auto', color: MT.GOLD, ...mMono(), fontSize: 10, fontWeight: 600 }}>{p}%</span>
              </div>
            ))}
          </div>
        </div>
      </MSection>

      <MSection title="Per-Swing Damage">
        <div style={{ fontSize: 10, color: MT.TEXT, marginBottom: 4, display: 'flex', justifyContent: 'space-between' }}>
          <span>Caen's Bo — 43d/30</span><span style={{ color: MT.MUTED, ...mMono() }}>4,389 · 33–374</span>
        </div>
        <MHistogram color={MT.GOLD} seed={7} />
        <div style={{ marginTop: 10, fontSize: 10, color: MT.TEXT, marginBottom: 4, display: 'flex', justifyContent: 'space-between' }}>
          <span>Flying Kick</span><span style={{ color: MT.MUTED, ...mMono() }}>941 · 48–283</span>
        </div>
        <MHistogram color={MT.PIE_VIOLET} seed={23} />
      </MSection>

      {/* Re-sim button */}
      <div style={{
        marginTop: 6, padding: '14px 18px',
        background: `linear-gradient(135deg, ${MT.GOLD} 0%, #6b4800 100%)`,
        border: `1px solid rgba(139,0,0,0.6)`, borderRadius: 8, textAlign: 'center',
        ...mCinzel(), fontSize: 13, letterSpacing: '0.2em', color: '#fff', fontWeight: 700,
        textTransform: 'uppercase', boxShadow: '0 4px 20px rgba(184,134,11,0.35)',
      }}>
        ⚡ Re-Simulate
      </div>
    </>
  );
}

function MReportTab() {
  const lines = [
    '',
    '  Weapon skill cap (2hb): 252 (Quarm/TAKP)',
    '  Target: Kaas Thox Xi Aten Ha Ra, Lvl 66, AC 800',
    '',
    '═══ Executive Summary ═══',
    '',
    '  Duration:           6000 seconds',
    '  Runs averaged:      20',
    '  Total DPS:          77.48',
    '  DPS std dev:        0.39',
    '  Total damage:       464,851',
    '  TPS (approx):       100.72',
    '  Critical hits:      390',
    '  Crit DPS gain:      3.37',
    '',
    '═══ Offense & To-Hit Model ═══',
    '',
    '  Calculated to-hit:  511',
    '  Offense skill:      252  (0-255)',
    '  Offense rating:     467',
    '    From STR:         120',
    '    From other:       347',
    '  Displayed ATK:      1314',
    '  Haste (eff):        100.0%',
    '',
    '═══ Weapon Overview ═══',
    '',
    '  Weapon 1: 43d/30 (Caen\'s Bo)',
    '    Damage bonus:     29',
    '    Bonus damage:     127,603',
    '    Total damage:     464,851',
    '    Weapon DPS:       77.48',
  ];
  return (
    <>
      <div style={{ display: 'flex', gap: 6, marginBottom: 10, overflowX: 'auto' }}>
        {['Combat Log', 'Detailed', 'Export .txt', 'Export .csv'].map((b, i) => (
          <div key={b} style={{
            padding: '6px 10px', border: `1px solid ${i === 0 ? MT.GOLD_BORDER : MT.BORDER}`,
            background: i === 0 ? MT.GOLD_FAINT : MT.INPUT, borderRadius: 4,
            fontSize: 10, letterSpacing: '0.1em', textTransform: 'uppercase',
            color: i === 0 ? MT.GOLD : MT.MUTED, ...mCinzel(), whiteSpace: 'nowrap', fontWeight: 600,
          }}>{b}</div>
        ))}
      </div>
      <div style={{
        background: MT.INPUT, border: `1px solid ${MT.BORDER}`, borderRadius: 6,
        padding: 10, ...mMono(), fontSize: 10, color: MT.TEXT_DIM, lineHeight: 1.55,
        whiteSpace: 'pre', overflowX: 'auto',
      }}>
        {lines.map((l, i) => (
          <div key={i} style={{
            color: l.startsWith('═══') ? MT.GOLD : (l.trim().startsWith('DPS') || /Total DPS|TPS|damage:/.test(l) ? MT.TEXT : MT.TEXT_DIM),
          }}>{l || '\u00a0'}</div>
        ))}
      </div>
    </>
  );
}

function MHistoryTab() {
  return (
    <>
      <div style={{ display: 'flex', gap: 10, marginBottom: 10, fontSize: 10 }}>
        <span style={{ color: MT.MUTED }}>Easy: <span style={{ color: MT.TEXT }}>1</span></span>
        <span style={{ color: MT.MUTED }}>Advanced: <span style={{ color: MT.TEXT }}>1</span></span>
        <span style={{ color: MT.MUTED }}>Total: <span style={{ color: MT.GOLD, fontWeight: 700 }}>2</span></span>
        <div style={{ flex: 1 }} />
        <span style={{ color: MT.MUTED, letterSpacing: '0.1em', ...mCinzel(), fontSize: 9 }}>CLEAR</span>
      </div>
      {[
        { dps: '77.48', atk: 1314, mode: 'ADV', era: 'Luclin', time: '2m ago', color: MT.GOLD },
        { dps: '144.89', atk: 1516, mode: 'EZ', era: 'Luclin', time: '5m ago', color: '#6ee7b7' },
      ].map((r, i) => (
        <div key={i} style={{ padding: 12, background: MT.PANEL, border: `1px solid ${MT.BORDER}`, borderRadius: 8, marginBottom: 8 }}>
          <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 6 }}>
            <div style={{ ...mCinzel(), fontSize: 26, color: r.color, fontWeight: 700, lineHeight: 1 }}>{r.dps}</div>
            <div style={{ fontSize: 9, color: r.color, letterSpacing: '0.12em', ...mCinzel(), padding: '2px 8px', border: `1px solid ${r.color}`, borderRadius: 3, fontWeight: 700 }}>{r.mode}</div>
          </div>
          <div style={{ fontSize: 10, color: MT.MUTED, display: 'flex', gap: 10, ...mMono() }}>
            <span>43d/30</span>
            <span>ATK {r.atk}</span>
            <span>{r.era}</span>
            <span style={{ marginLeft: 'auto' }}>{r.time}</span>
          </div>
        </div>
      ))}
    </>
  );
}

function MobileStepperFinal() {
  const [tab, setTab] = React.useState('Sim');
  const tabs = [
    { l: 'Build', ic: '⚔' },
    { l: 'Sim', ic: '◉' },
    { l: 'Report', ic: '≡' },
    { l: 'History', ic: '◷' },
  ];

  return (
    <div style={{ width: '100%', height: '100%', background: MT.BG, color: MT.TEXT, ...mSatoshi(), display: 'flex', flexDirection: 'column', overflow: 'hidden', position: 'relative' }}>
      {/* Top nav */}
      <div style={{ padding: '54px 16px 12px', borderBottom: `1px solid ${MT.GOLD_BORDER}`, background: 'linear-gradient(180deg, rgba(0,0,0,0.5), transparent)', flexShrink: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div>
            <div style={{ ...mCinzel(), fontSize: 18, fontWeight: 700, color: MT.GOLD, letterSpacing: '0.03em' }}>gSim</div>
            <div style={{ fontSize: 8, letterSpacing: '0.2em', color: MT.MUTED, textTransform: 'uppercase' }}>Project Quarm · {tab}</div>
          </div>
          <div style={{ display: 'flex', gap: 6, alignItems: 'center', padding: '4px 10px', background: 'rgba(0,0,0,0.5)', border: `1px solid ${MT.GOLD_BORDER}`, borderRadius: 4 }}>
            <div style={{ textAlign: 'right' }}>
              <div style={{ fontSize: 7, color: MT.MUTED, letterSpacing: '0.14em', ...mCinzel() }}>DPS</div>
              <div style={{ ...mCinzel(), fontSize: 14, color: MT.GOLD, fontWeight: 700, lineHeight: 1 }}>77.48</div>
            </div>
          </div>
        </div>
        <div style={{ marginTop: 10, display: 'flex', gap: 2, padding: 3, background: MT.INPUT, borderRadius: 6, border: `1px solid ${MT.BORDER}` }}>
          {['Melee','Ranged','Tank'].map((m, i) => (
            <div key={m} style={{
              flex: 1, textAlign: 'center', padding: '5px 0', ...mCinzel(),
              fontSize: 10, letterSpacing: '0.14em', textTransform: 'uppercase', fontWeight: 600,
              borderRadius: 4, background: i === 0 ? MT.GOLD_FAINT : 'transparent',
              color: i === 0 ? MT.GOLD : MT.MUTED,
            }}>{m}</div>
          ))}
        </div>
      </div>

      {/* Content */}
      <div style={{ flex: 1, overflowY: 'auto', padding: '14px 14px 90px', minHeight: 0 }}>
        {tab === 'Build' && <MBuildTab />}
        {tab === 'Sim' && <MSimTab />}
        {tab === 'Report' && <MReportTab />}
        {tab === 'History' && <MHistoryTab />}
      </div>

      {/* Bottom tab bar */}
      <div style={{
        position: 'absolute', bottom: 0, left: 0, right: 0,
        background: 'rgba(10,10,12,0.94)', borderTop: `1px solid ${MT.GOLD_BORDER}`,
        backdropFilter: 'blur(12px)', paddingBottom: 30,
      }}>
        <div style={{ display: 'flex', padding: '10px 0 6px' }}>
          {tabs.map(t => {
            const active = tab === t.l;
            return (
              <div key={t.l} onClick={() => setTab(t.l)} style={{ flex: 1, textAlign: 'center', ...mCinzel(), cursor: 'pointer' }}>
                <div style={{ fontSize: 18, color: active ? MT.GOLD : MT.MUTED, lineHeight: 1, marginBottom: 3 }}>{t.ic}</div>
                <div style={{ fontSize: 9, letterSpacing: '0.14em', textTransform: 'uppercase', color: active ? MT.GOLD : MT.MUTED, fontWeight: 600 }}>{t.l}</div>
                {active && <div style={{ width: 20, height: 2, background: MT.GOLD, borderRadius: 2, margin: '3px auto 0' }} />}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

window.MobileStepperFinal = MobileStepperFinal;
