// Laptop: choose the package layer draped over the relief (the phone follows), and the TES value.
import { useEffect, useState } from 'react';
import { CAPAS, layerState, loadTes, setLayer, type CapaId } from './layers';
import { onWorldChange } from '../vr/vrEngine';

export function LayerControls() {
  const [cur, setCur] = useState<CapaId>(layerState.actual);
  const [, force] = useState(0);
  useEffect(() => {
    loadTes().then(() => force((k) => k + 1));
  }, []);
  const choose = (id: CapaId) => {
    setCur(id);
    setLayer(id).then(() => force((k) => k + 1));
    onWorldChange?.(); // the phone shows the same layer
  };
  const tes = layerState.tes;
  return (
    <div className="rounded border border-slate-700/80 p-2 space-y-1.5">
      <div className="flex flex-wrap items-center gap-1">
        <span className="text-slate-400 mr-1">Capa</span>
        {CAPAS.map((c) => (
          <button
            key={c.id}
            onClick={() => choose(c.id)}
            className={`px-1.5 py-0.5 rounded border text-[10px] ${cur === c.id ? 'border-cyan-300 text-cyan-100' : 'border-slate-600 text-slate-400'}`}
          >
            {c.nombre}
          </button>
        ))}
      </div>
      {layerState.nota && <div className="text-[10px] text-slate-400 leading-snug">{layerState.nota}</div>}
      {tes && (
        <div className="text-[10px] text-slate-400 leading-snug">
          Inercia térmica TES: <b className="text-slate-200">{Math.round(tes.valor)}</b> {tes.unidad} en toda la ventana (un píxel de ~3 km, Putzig y Mellon 2007)
        </div>
      )}
    </div>
  );
}
