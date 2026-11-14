// Suit HUD: holographic biodata, survival barrier and sensory lens effects.
//   bio.ts            biodata (CLAUDE.md §10.4) and the return field R(p) (§8.3, §9)
//   VisorHud.tsx      holograms on the visor + the lens layer (frost, red vignette, hypoxia)
//   ReturnBarrier.tsx R(p) as a wall of light on the ground
// The laptop's post-processing reads `crisis` (components/canvas/Effects.tsx).
export { bio, applyBio, bioSnapshot, resetBio, stepBio, type BioNet } from './bio';
export { VisorHud, crisis } from './VisorHud';
export { ReturnBarrier } from './ReturnBarrier';
