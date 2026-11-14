// Laptop controls for the mission modes, and the hook that starts the source.
//   ?modo=mision[&registro=<nombre>]  replay logs/<nombre>.jsonl (default: the reference mission)
//   ?modo=vivo                        backend WebSocket
//   (no modo)                         free walk, as before
import { useEffect, useState } from 'react';
import { formatHours } from '../lib/marsTime';
import { LEVEL_COLOR, level, margenPct } from '../hud/bio';
import { bio } from '../hud/bio';
import { mission } from './mission';
import { DEFAULT_LOG, connectLive, jump, jumpToMarker, live, loadReplay, player } from './sources';
import { displayTime } from './driver';

const params = new URLSearchParams(location.search);
const MODO = params.get('modo');
if (MODO === 'mision') mission.modo = 'mision';
if (MODO === 'vivo') mission.modo = 'vivo';

/** Start the mission source once the scene is ready. */
export function useMissionSource(ready: boolean) {
  useEffect(() => {
    if (!ready) return;
    if (MODO === 'mision')
      loadReplay(params.get('registro') ?? DEFAULT_LOG).catch((e: unknown) => {
        mission.estadoFuente = `No se pudo cargar el registro: ${e instanceof Error ? e.message : e}`;
      });
    else if (MODO === 'vivo') connectLive();
  }, [ready]);
}

const href = (modo: string | null) => {
  const p = new URLSearchParams(location.search);
  if (modo) p.set('modo', modo);
  else p.delete('modo');
  return `?${p.toString()}`;
};

/** Mode links (also shown in free mode). */
export function ModeLinks() {
  const cur = mission.modo;
  const cls = (on: boolean) => `px-2 py-0.5 rounded border ${on ? 'border-cyan-300 text-cyan-100' : 'border-slate-600 text-slate-400 hover:text-slate-200'}`;
  return (
    <div className="flex items-center gap-1.5">
      <span className="text-slate-400 mr-1">Fuente</span>
      <a href={href(null)} className={cls(cur === 'libre')}>Libre</a>
      <a href={href('mision')} className={cls(cur === 'mision')}>Misión registrada</a>
      <a href={href('vivo')} className={cls(cur === 'vivo')}>Backend en vivo</a>
    </div>
  );
}

export function MissionPanel() {
  const [, force] = useState(0);
  useEffect(() => {
    const id = window.setInterval(() => force((k) => k + 1), 250);
    return () => window.clearInterval(id);
  }, []);
  const t = displayTime();
  const lv = level();
  const m = margenPct();
  const replay = mission.modo === 'mision';
  return (
    <div className="rounded border border-slate-700/80 p-2 space-y-1.5">
      <div className="text-slate-300 leading-snug">{mission.estadoFuente}</div>
      <div className="flex items-center justify-between font-mono">
        <span>
          min <b className="text-cyan-200">{(t / 60).toFixed(1)}</b>
          {Number.isFinite(mission.horaSolar) && <> · {formatHours(mission.horaSolar)} LTST</>}
        </span>
        <span style={{ color: LEVEL_COLOR[lv] }}>
          O₂ {Number.isFinite(bio.O2) ? bio.O2.toFixed(1) : '—'} L · margen {Number.isFinite(m) ? `${Math.round(m)} %` : '> 999 %'}
        </span>
      </div>
      <div className="font-mono text-slate-400">
        plan {mission.plan?.plan_id ?? '—'} · muestras {mission.nMuestras} · carga {mission.carga.toFixed(1)} kg
        {mission.spe && <span className="text-amber-300"> · SPE {mission.spe.nivel}</span>}
        {mission.abortado && <span className="text-red-300"> · ABORTADO</span>}
      </div>
      {replay && (
        <>
          <input
            type="range"
            min={0}
            max={Math.max(1, player.duration)}
            step={10}
            value={player.clock}
            onChange={(e) => jump(+e.target.value)}
            className="w-full accent-cyan-400"
          />
          <div className="flex items-center gap-1.5">
            <button onClick={() => (player.playing = !player.playing)} className="px-2 py-0.5 rounded border border-cyan-400/60 text-cyan-100">
              {player.playing ? '❚❚ Pausa' : '▶ Seguir'}
            </button>
            {[10, 30, 60, 120].map((k) => (
              <button key={k} onClick={() => (player.factor = k)} className={`px-2 py-0.5 rounded border ${player.factor === k ? 'border-cyan-300 text-cyan-100' : 'border-slate-600 text-slate-400'}`}>
                ×{k}
              </button>
            ))}
          </div>
          <div className="flex flex-wrap gap-1">
            {player.marcadores
              .filter((mk) => mk.nivel === 1)
              .map((mk) => (
                <button
                  key={mk.id}
                  title={mk.detalle}
                  onClick={() => jumpToMarker(mk)}
                  className={`px-1.5 py-0.5 rounded border text-[10px] ${player.clock >= mk.t ? 'border-slate-500 text-slate-300' : 'border-slate-700 text-slate-500'}`}
                >
                  {mk.min.toFixed(0)}′ {mk.titulo}
                </button>
              ))}
          </div>
        </>
      )}
      {mission.modo === 'vivo' && (
        <div className="font-mono text-slate-400">
          {live.connected ? <span className="text-emerald-300">● conectado</span> : <span className="text-red-300">● sin conexión</span>} · {live.mensajes} mensajes · ×{live.factor}
        </div>
      )}
    </div>
  );
}
