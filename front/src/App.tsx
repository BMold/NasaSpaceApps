// Two roles, one page:  ?role=vr → phone headset · ?role=spectator → laptop.
import { VRCanvas } from './vr/VRCanvas';
import { SpectatorView } from './vr/SpectatorView';
import { SensorTest } from './vr/SensorTest';

function RoleSelect() {
  const here = `${location.protocol}//${location.host}`;
  return (
    <div className="min-h-screen bg-space text-slate-200 flex flex-col items-center justify-center gap-6 p-6">
      <div className="text-center">
        <div className="font-display text-3xl tracking-[0.3em] text-cyan-200">ARES-TWIN</div>
        <div className="text-sm text-slate-400 mt-1">Visor de EVA en Marte · casco VR + espectador en red local</div>
      </div>
      <div className="grid gap-4 sm:grid-cols-2 w-full max-w-3xl">
        <a href="?role=spectator" className="glass p-5 hover:border-cyan-300 block">
          <div className="font-display tracking-[0.2em] text-cyan-100">LAPTOP · ESPECTADOR</div>
          <p className="text-[13px] text-slate-300 mt-2">Pantalla completa con la vista del casco. Teclado WASD / flechas para mover al astronauta. Ruta A* dinámica y dron en la mochila.</p>
        </a>
        <a href="?role=vr" className="glass p-5 hover:border-cyan-300 block">
          <div className="font-display tracking-[0.2em] text-cyan-100">CELULAR · CASCO VR</div>
          <p className="text-[13px] text-slate-300 mt-2">Pantalla dividida para Cardboard. El giroscopio gira la cabeza; el avance llega desde la laptop.</p>
        </a>
      </div>
      <div className="glass p-4 max-w-3xl text-[12px] text-slate-400 leading-relaxed">
        En el celular (misma red Wi-Fi) abrí <span className="font-mono text-slate-200">https://IP-DE-LA-LAPTOP:5173/?role=vr</span> y aceptá el certificado local.
        Esta página está en <span className="font-mono text-slate-200">{here}</span>.
      </div>
      <a href="?role=sensor-test" className="text-[12px] text-cyan-200 underline">¿El celular no gira la vista? Diagnóstico de sensores</a>
    </div>
  );
}

export default function App() {
  const role = new URLSearchParams(location.search).get('role');
  if (role === 'vr') return <VRCanvas />;
  if (role === 'spectator') return <SpectatorView />;
  if (role === 'sensor-test') return <SensorTest />;
  return <RoleSelect />;
}
