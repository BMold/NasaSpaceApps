// Hillshade (optionally tinted with the Mars Trek albedo) for the radar mini-map.
import { HALF, HF_RES, WORLD_SIZE, albedoAt, heightAt, sandAt } from './terrain';

export function renderMinimap(size = 240): string {
  const c = document.createElement('canvas');
  c.width = size;
  c.height = size;
  const ctx = c.getContext('2d')!;
  const img = ctx.createImageData(size, size);
  const alb = [0, 0, 0];
  const step = WORLD_SIZE / size;
  for (let j = 0; j < size; j++) {
    for (let i = 0; i < size; i++) {
      const x = -HALF + (i + 0.5) * step;
      const z = -HALF + (j + 0.5) * step;
      const h = heightAt(x, z);
      const dx = heightAt(x + 1, z) - heightAt(x - 1, z);
      const dz = heightAt(x, z + 1) - heightAt(x, z - 1);
      // light from the west-northwest
      const shade = Math.max(0, Math.min(1, 0.62 - dx * 0.22 - dz * 0.12));
      const sand = sandAt(x, z);
      let r = 120 + h * 3 + sand * 40;
      let g = 58 + h * 1.5 + sand * 26;
      let b = 32 + h + sand * 14;
      if (albedoAt(x, z, alb)) {
        r = r * 0.55 + alb[0] * 255 * 0.45;
        g = g * 0.55 + alb[1] * 255 * 0.45;
        b = b * 0.55 + alb[2] * 255 * 0.45;
      }
      const k = (j * size + i) * 4;
      img.data[k] = Math.max(0, Math.min(255, r * (0.45 + shade)));
      img.data[k + 1] = Math.max(0, Math.min(255, g * (0.45 + shade)));
      img.data[k + 2] = Math.max(0, Math.min(255, b * (0.45 + shade)));
      img.data[k + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  return c.toDataURL('image/png');
}

export const MINIMAP_RES = HF_RES;
