// The laptop's "camera": what a real sensor and lens add to the picture.
//   • ambient occlusion (creases, the foot of rocks and of the boots get darker)
//   • a little bloom on the Sun and on glints
//   • filmic tone mapping (AgX) of the physically lit scene, SMAA anti-aliasing
//   • fine sensor grain (more of it in a dust storm) and a soft lens vignette
// The phone renders straight to the screen (two eyes, no post-processing).
import { useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import { Bloom, EffectComposer, N8AO, Noise, SMAA, ToneMapping, Vignette } from '@react-three/postprocessing';
import { BlendFunction, ToneMappingMode } from 'postprocessing';
import { rt } from '../../store/simEngine';
import { Q, toneMap } from '../../render/quality';

const MODE = { agx: ToneMappingMode.AGX, aces: ToneMappingMode.ACES_FILMIC, neutral: ToneMappingMode.NEUTRAL }[toneMap];

export function Effects() {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const noise = useRef<any>(null);
  useFrame(() => {
    const k = rt.stormIntensity;
    if (noise.current?.blendMode?.opacity) noise.current.blendMode.opacity.value = 0.035 + k * 0.1;
  });
  if (Q.post === 'none') return null;
  return (
    <EffectComposer multisampling={Q.msaa} enableNormalPass={false}>
      {Q.ao ? <N8AO aoRadius={0.85} distanceFalloff={1.2} intensity={2.4} quality="performance" halfRes depthAwareUpsampling /> : <></>}
      <Bloom mipmapBlur intensity={0.5} luminanceThreshold={0.55} luminanceSmoothing={0.35} radius={0.72} />
      <ToneMapping mode={MODE} />
      {Q.smaa ? <SMAA /> : <></>}
      <Noise ref={noise} opacity={0.035} blendFunction={BlendFunction.SOFT_LIGHT} />
      <Vignette eskil={false} offset={0.32} darkness={0.42} />
    </EffectComposer>
  );
}
