// Quality tiers. The phone renders the scene twice (stereo), so it gets the
// light tier; the laptop gets the full one. `?q=low|medium|high` overrides it.
export type Tier = 'low' | 'medium' | 'high';

const params = new URLSearchParams(typeof location === 'undefined' ? '' : location.search);

function detectTier(): Tier {
  const q = params.get('q');
  if (q === 'low' || q === 'medium' || q === 'high') return q;
  const mobile = typeof navigator !== 'undefined' && /Android|iPhone|iPad|Mobile/i.test(navigator.userAgent);
  if (params.get('role') === 'vr' || mobile) return 'low';
  return integratedGpu() ? 'medium' : 'high';
}

/** Laptops with integrated graphics run out of fill rate long before they run out of geometry. */
function integratedGpu(): boolean {
  try {
    const gl = document.createElement('canvas').getContext('webgl');
    const ext = gl?.getExtension('WEBGL_debug_renderer_info');
    const name = String(gl && ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : '');
    if (/RTX|GTX|Quadro|Radeon (RX|Pro)|Arc\(TM\)|Apple M\d/i.test(name)) return false;
    return /Intel|UHD|Iris|Radeon|Vega|SwiftShader|llvmpipe|Mali|Adreno|PowerVR/i.test(name) || name === '';
  } catch {
    return true;
  }
}

export const tier: Tier = detectTier();

const TIERS = {
  low: {
    dprMax: 1.25,
    antialias: false,
    shadowMap: 1024,
    shadowHalf: 20, // metres covered by the real-time shadow map around the crew
    shadeRes: 256, // baked sun / sky-occlusion map of the whole site
    aniso: 2,
    groundTwoScales: false,
    rockDetail: 3, // icosahedron subdivisions of the boulders
    clutter: 900, // loose stones kept around the crew
    clutterRadius: 12,
    clutterShadows: false,
    farRings: 120,
    farSegs: 224,
    farDetail: false,
    footprints: 48,
    dust: 24,
    suitSegs: 12,
    post: 'none' as 'none' | 'basic' | 'full',
    msaa: 0,
    smaa: false,
    ao: false,
    envSize: 64,
  },
  medium: {
    dprMax: 1,
    antialias: true,
    shadowMap: 2048,
    shadowHalf: 28,
    shadeRes: 512,
    aniso: 4,
    groundTwoScales: true,
    rockDetail: 4,
    clutter: 2600,
    clutterRadius: 20,
    clutterShadows: true,
    farRings: 170,
    farSegs: 360,
    farDetail: true,
    footprints: 96,
    dust: 60,
    suitSegs: 18,
    post: 'basic' as 'none' | 'basic' | 'full',
    msaa: 0,
    smaa: true,
    ao: false,
    envSize: 128,
  },
  high: {
    dprMax: 1.5,
    antialias: true,
    shadowMap: 2048,
    shadowHalf: 32,
    shadeRes: 512,
    aniso: 4,
    groundTwoScales: true,
    rockDetail: 5,
    clutter: 4200,
    clutterRadius: 26,
    clutterShadows: true,
    farRings: 200,
    farSegs: 480,
    farDetail: true,
    footprints: 140,
    dust: 90,
    suitSegs: 24,
    post: 'full' as 'none' | 'basic' | 'full',
    msaa: 0,
    smaa: true,
    ao: true,
    envSize: 256,
  },
};

export const Q = { ...TIERS[tier] };
// Fine overrides for testing, e.g. ?post=none&clutter=0&shadow=1024
const post = params.get('post');
if (post === 'none' || post === 'basic' || post === 'full') Q.post = post;
for (const key of ['clutter', 'shadowMap', 'farRings', 'farSegs', 'rockDetail', 'dprMax', 'msaa'] as const) {
  const v = params.get(key);
  if (v !== null && !Number.isNaN(+v)) Q[key] = +v;
}
if (params.get('twoScales') === '0') Q.groundTwoScales = false;
if (params.get('ao') !== null) Q.ao = params.get('ao') === '1';
if (params.get('smaa') !== null) Q.smaa = params.get('smaa') === '1';

/** Tone curve of the "camera": agx (default), aces or neutral. */
export const toneMap = (params.get('tm') ?? 'agx') as 'agx' | 'aces' | 'neutral';
if (params.get('clutterShadows') === '0') Q.clutterShadows = false;
export const isPhoneTier = tier === 'low';
