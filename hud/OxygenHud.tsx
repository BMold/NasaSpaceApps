import { useEffect, type CSSProperties } from 'react';
import { curveTransform } from './helmet';
import { TANK_CAPACITY_L, TIME_SCALES, minutesLeft, percentOf, useOxygenStore } from './oxygenStore';

// ──────────────────────────────LAYOUT─────────────────────────────────────
const LAYOUT = {
  top: 26, 
  topVR: 24, 
  right: 56, 
  rightVR: '12%', 
  scaleVR: 0.6, 
  width: 180,
  padding: 25,
  barHeight: 140, 
};
// ────────────────────────────────────────────────────────────────────────────

const styleFor = (pct: number, empty: boolean) => {
  if (pct > 50) return { color: '#00f3ff', glow: '0 0 18px #00f3ff, inset 0 0 8px #ffffff', status: 'OPTIMAL' };
  if (pct > 20) return { color: '#ff9d00be', glow: '0 0 18prgba(255, 157, 0, 0.84)00, inset 0 0 8px #ffffff', status: 'LOW RESERVE' };
  return { color: '#ff003c', glow: '0 0 25px #ff003c, inset 0 0 10px #ffffff', status: empty ? 'DEPLETED' : 'CRITICAL' };
};

export function OxygenHud({ compact = false }: { compact?: boolean }) {
  const litres = useOxygenStore((s) => s.litres);
  const active = useOxygenStore((s) => s.active);
  const timeScale = useOxygenStore((s) => s.timeScale);
  const setTimeScale = useOxygenStore((s) => s.setTimeScale);
  const toggle = useOxygenStore((s) => s.toggle);
  const reload = useOxygenStore((s) => s.reload);
  const attach = useOxygenStore((s) => s.attach);
  const detach = useOxygenStore((s) => s.detach);
  useEffect(() => {
    attach();
    return detach;
  }, [attach, detach]);

  const pct = percentOf(litres);
  const hud = styleFor(pct, litres <= 0);
  const minutes = Math.round(minutesLeft(litres));

  const panel: CSSProperties = {
    position: 'absolute',
    top: compact ? LAYOUT.topVR : LAYOUT.top,
    right: compact ? LAYOUT.rightVR : LAYOUT.right,
    width: LAYOUT.width,
    boxSizing: 'border-box',
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    padding: LAYOUT.padding,
    border: `1px solid ${hud.color}44`,
    borderRadius: 12,
    height: 400,
    backgroundColor: 'rgba(10, 20, 35, 0.51)',
    boxShadow: `0 0 30px rgba(0, 0, 0, 0.8), inset 0 0 15px ${hud.color}22`,
    color: '#00f3ff',
    fontFamily: "'Courier New', Courier, monospace",
    transform: `${curveTransform('right')}${compact ? ` scale(${LAYOUT.scaleVR})` : ''}` || undefined,
    transformOrigin: 'top right',
    pointerEvents: compact ? 'none' : 'auto',
  };

  const btn: CSSProperties = {
    padding: '7px 10px',
    fontFamily: 'inherit',
    fontSize: 11,
    fontWeight: 'bold',
    cursor: 'pointer',
    borderRadius: 4,
    flex: 1,
  };

  return (
    <div style={panel} onPointerDown={(e) => e.stopPropagation()}>
      <div style={{ width: '100%', display: 'flex', justifyContent: 'space-between', fontSize: 11, marginBottom: 10, opacity: 0.8 }}>
        <span>EVA-SUIT // MK-IV</span>
        <span>O₂ TANK</span>
      </div>
      {!compact && (
        <div style={{ width: '100%', display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 15, fontSize: 11 }}>
          <span style={{ opacity: 0.7 }}>VELOCIDAD:</span>
          <select className="hud-select" value={timeScale} onChange={(e) => { setTimeScale(Number(e.target.value)); e.target.blur(); }}>
            {TIME_SCALES.map((o) => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
        </div>
      )}
      <div style={{ fontSize: 42, fontWeight: 'bold', color: hud.color, textShadow: `0 0 10px ${hud.color}88`, marginBottom: 5 }}>{Math.round(pct)}%</div>
      <div
        className={pct <= 20 && litres > 0 ? 'hud-blink' : ''}
        style={{ fontSize: 13, letterSpacing: 2, color: hud.color, marginBottom: 15, fontWeight: 'bold' }}
      >
        [{hud.status}]
      </div>
      <div
        style={{
          position: 'relative',
          width: 44,
          height: LAYOUT.barHeight,
          backgroundColor: '#02050a',
          border: `2px solid ${hud.color}`,
          borderRadius: 6,
          display: 'flex',
          alignItems: 'flex-end',
          padding: 4,
          boxSizing: 'border-box',
          boxShadow: `0 0 12px ${hud.color}44`,
        }}
      >
        <div
          style={{
            position: 'absolute',
            inset: 0,
            backgroundImage: 'repeating-linear-gradient(to bottom, transparent, transparent 22px, rgba(255,255,255,0.15) 23px)',
            pointerEvents: 'none',
            zIndex: 2,
          }}
        />
        <div
          style={{
            width: '100%',
            height: `${pct}%`,
            backgroundColor: hud.color,
            boxShadow: hud.glow,
            borderRadius: 2,
            transition: 'height 0.15s linear, background-color 0.4s ease, box-shadow 0.4s ease',
          }}
        />
      </div>
      <div style={{ width: '100%', display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginTop: 14, fontSize: 11 }}>
        <span style={{ opacity: 0.7 }}>
          {litres.toFixed(1)} / {TANK_CAPACITY_L} L
        </span>
        <span style={{ fontSize: 15, fontWeight: 'bold', color: hud.color }}>≈ {minutes} min</span>
      </div>
    </div>
  );
}
