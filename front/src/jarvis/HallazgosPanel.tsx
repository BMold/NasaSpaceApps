// Laptop: the findings log of JARVIS (new objects worth documenting), newest first.
import { useEffect, useState } from 'react';
import { CLASE_NOMBRE, field } from './catalog';
import { jarvis } from './detector';

export function HallazgosPanel() {
  const [, force] = useState(0);
  useEffect(() => {
    const id = window.setInterval(() => force((k) => k + 1), 500);
    return () => window.clearInterval(id);
  }, []);
  return (
    <div className="rounded border border-fuchsia-500/30 p-2 space-y-1">
      <div className="flex justify-between">
        <span className="text-fuchsia-200">★ Hallazgos JARVIS ({jarvis.hallazgos.length})</span>
        <span className="text-slate-500">BD orbital simulada: {field.nDb} objetos</span>
      </div>
      {jarvis.hallazgos.length === 0 && <div className="text-[10px] text-slate-500">Todavía nada nuevo a la vista. Los marcos magenta son objetos que no están en la BD.</div>}
      {jarvis.hallazgos.slice(0, 6).map((h) => (
        <div key={h.id} className="text-[10px] leading-snug">
          <b className="text-amber-200">{CLASE_NOMBRE[h.clase]}</b> <span className="text-slate-400">({h.id})</span> · {h.motivo}
          <div className="text-slate-500 font-mono">
            x {h.x.toFixed(1)} · y {h.y.toFixed(1)} m · {h.cuando} · interés {Math.round(h.interes * 100)} %
          </div>
        </div>
      ))}
      <div className="text-[9px] text-slate-500 leading-snug">Detección simulada: el sensor reporta lo que la escena tiene en el campo visual y lo compara con un catálogo orbital simulado (no es una red neuronal sobre la cámara).</div>
    </div>
  );
}
