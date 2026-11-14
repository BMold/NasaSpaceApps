export const HELMET = {
  ENABLED: true, // false 


  RIM: { top: 4, bottom: 6, side: 2.5, radius: 9 },
  RIM_VR: { top: 3, bottom: 4, side: 1.5, radius: 9 },

  CURVE_Y_DEG: 16, 
  CURVE_X_DEG: 4, 
  PERSPECTIVE_PX: 900, 
};

export const visorPath = (vr: boolean) => {
  const r = vr ? HELMET.RIM_VR : HELMET.RIM;
  const x0 = r.side;
  const x1 = 100 - r.side;
  const y0 = r.top;
  const y1 = 100 - r.bottom;
  const k = r.radius;
  return `M${x0 + k} ${y0}H${x1 - k}A${k} ${k} 0 0 1 ${x1} ${y0 + k}V${y1 - k}A${k} ${k} 0 0 1 ${x1 - k} ${y1}H${x0 + k}A${k} ${k} 0 0 1 ${x0} ${y1 - k}V${y0 + k}A${k} ${k} 0 0 1 ${x0 + k} ${y0}Z`;
};

export const curveTransform = (side: 'left' | 'right', strength = 1) =>
  HELMET.ENABLED ? `rotateY(${(side === 'right' ? -1 : 1) * HELMET.CURVE_Y_DEG * strength}deg) rotateX(${-HELMET.CURVE_X_DEG * strength}deg)` : '';
