// Shared theme tokens for gSim overhaul
const GSIM_THEME = {
  GOLD: '#d4af37',
  GOLD_BRIGHT: '#e8c547',
  GOLD_DIM: 'rgba(212,175,55,0.35)',
  GOLD_FAINT: 'rgba(212,175,55,0.14)',
  GOLD_BORDER: 'rgba(212,175,55,0.22)',
  CRIMSON: '#8b0000',
  CRIMSON_GLOW: 'rgba(139,0,0,0.35)',
  BG: '#0a0a0c',
  BG_2: '#0d0d10',
  PANEL: '#141418',
  PANEL_2: '#17171c',
  INPUT: '#101013',
  BORDER: 'rgba(255,255,255,0.08)',
  BORDER_STRONG: 'rgba(255,255,255,0.14)',
  TEXT: '#e6e6e6',
  TEXT_DIM: '#b8bac0',
  MUTED: '#7d828c',
  MUTED_DIM: '#5a5e66',
  TPS_BLUE: '#7eb8c9',
  PIE_BLUE: '#7aa8e0',
  PIE_BLUE_DARK: '#4d78b5',
  PIE_VIOLET: '#b892d6',
  DANGER: '#d07070',
  FONT_DISPLAY: '"Cinzel", serif',
  FONT_BODY: '"Satoshi", system-ui, sans-serif',
  FONT_SERIF: '"Zodiak", Georgia, serif',
  FONT_MONO: 'ui-monospace, "Cascadia Code", "SF Mono", monospace',
};

// Gold corner brackets — the signature ornament
function GsimCorners({ children, style = {}, size = 10, color }) {
  const g = color || GSIM_THEME.GOLD;
  const b = `1.5px solid ${g}`;
  const C = (s) => <div style={{ position: 'absolute', width: size, height: size, pointerEvents: 'none', ...s }} />;
  return (
    <div style={{ position: 'relative', ...style }}>
      <C style={{ top: -1, left: -1, borderTop: b, borderLeft: b }} />
      <C style={{ top: -1, right: -1, borderTop: b, borderRight: b }} />
      <C style={{ bottom: -1, left: -1, borderBottom: b, borderLeft: b }} />
      <C style={{ bottom: -1, right: -1, borderBottom: b, borderRight: b }} />
      {children}
    </div>
  );
}

window.GSIM_THEME = GSIM_THEME;
window.GsimCorners = GsimCorners;
