import { HELMET } from './helmet';
import { OxygenHud } from './OxygenHud';
export function Hud({ vr = false }: { vr?: boolean }) {
  return (
    <div
      className="absolute inset-0 pointer-events-none overflow-hidden"
      style={{ perspective: HELMET.ENABLED ? HELMET.PERSPECTIVE_PX : undefined, perspectiveOrigin: '50% 50%' }}
    >
      <OxygenHud compact={vr} />
    </div>
  );
}
