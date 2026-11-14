// The laptop's "camera": what a real sensor and lens add to the picture.
//   • ambient occlusion (creases, the foot of rocks and of the boots get darker)
//   • a little bloom on the Sun and on glints
//   • filmic tone mapping (AgX) of the physically lit scene, SMAA anti-aliasing
//   • fine sensor grain (more of it in a dust storm) and a soft lens vignette
//   • sensory damage (hud/VisorHud.tsx · crisis): colour fringing, washed-out
//     colour and blur when the biodata are in crisis (hypoxia, racing heart)
// The phone renders straight to the screen (two eyes, no post-processing): there
// the visor lens layer of hud/VisorHud.tsx does the frost / red / tunnel part.
import { useEffect, useMemo, useRef, useState } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import { Bloom, ChromaticAberration, DepthOfField, EffectComposer, HueSaturation, N8AO, Noise, SMAA, ToneMapping, Vignette } from '@react-three/postprocessing';
import { crisis } from '../../hud/VisorHud';
import { BlendFunction, ToneMappingMode } from 'postprocessing';
import { rt } from '../../store/simEngine';
import { Q, toneMap } from '../../render/quality';

const MODE = { agx: ToneMappingMode.AGX, aces: ToneMappingMode.ACES_FILMIC, neutral: ToneMappingMode.NEUTRAL }[toneMap];

export function Effects() {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const noise = useRef<any>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const hue = useRef<any>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const dof = useRef<any>(null);
  const fringe = useMemo(() => new THREE.Vector2(0, 0), []);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const ca = useRef<any>(null);
  // The blur pass is only mounted during a crisis (it costs a depth-of-field pass every frame).
  const [blurOn, setBlurOn] = useState(false);
  useEffect(() => {
    const id = window.setInterval(() => setBlurOn(crisis.blur > 0.04), 250);
    return () => window.clearInterval(id);
  }, []);
  useFrame(() => {
    const k = rt.stormIntensity;
    if (noise.current?.blendMode?.opacity) noise.current.blendMode.opacity.value = 0.035 + k * 0.1;
    // Lens damage grows with the crisis: fringing beats with the heart, colour drains with hypoxia.
    const c = Math.min(1, crisis.red * 0.6 + crisis.hyp);
    const f = 0.0035 * c * (0.6 + 0.4 * crisis.beat);
    fringe.set(f, f * 0.6);
    ca.current?.offset?.copy?.(fringe);
    if (hue.current) hue.current.saturation = -0.85 * crisis.hyp - 0.25 * crisis.frost;
    if (dof.current) dof.current.bokehScale = 6 * crisis.blur;
  });
  if (Q.post === 'none') return null;
  return (
    <EffectComposer multisampling={Q.msaa} enableNormalPass={false}>
      {Q.ao ? <N8AO aoRadius={0.85} distanceFalloff={1.2} intensity={2.4} quality="performance" halfRes depthAwareUpsampling /> : <></>}
      <Bloom mipmapBlur intensity={0.5} luminanceThreshold={0.55} luminanceSmoothing={0.35} radius={0.72} />
      <ToneMapping mode={MODE} />
      {Q.smaa ? <SMAA /> : <></>}
      {blurOn ? <DepthOfField ref={dof} focusDistance={0} focalLength={0.02} bokehScale={0} /> : <></>}
      <ChromaticAberration ref={ca} offset={fringe} radialModulation modulationOffset={0.25} />
      <HueSaturation ref={hue} saturation={0} />
      <Noise ref={noise} opacity={0.035} blendFunction={BlendFunction.SOFT_LIGHT} />
      <Vignette eskil={false} offset={0.32} darkness={0.42} />
    </EffectComposer>
  );
}
