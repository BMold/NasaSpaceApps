"""Bake the tileable close-range surface textures (public/textures/).

Four Martian surfaces, each as two JPEGs that tile seamlessly:
  <name>_n.jpg   R,G = tangent-space normal (x, y), B = height
  <name>_a.jpg   R = albedo variation, G = cavity / ambient occlusion, B = second-colour mask

  soil   dusty regolith with granules and half-buried pebbles     (B = pebble)
  sand   wind ripples with coarse grains on the crests            (B = dark crest grains)
  rock   fractured, laminated bedrock slabs with sulfate veins    (B = vein)
  stone  pitted, dust-coated boulder surface (used triplanar)     (B = pit)

Everything is synthesised (FFT noise, stamped pebbles, periodic Voronoi), so there are
no third-party images.  Run:  python scripts/bake-textures.py [size]
"""
import os
import sys

import numpy as np
from PIL import Image, ImageFile
from scipy import ndimage
from scipy.spatial import cKDTree

N = int(sys.argv[1]) if len(sys.argv) > 1 else 1024
ImageFile.MAXBLOCK = N * N * 4  # large encoder buffer: these images are almost pure noise
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "public", "textures")
os.makedirs(OUT, exist_ok=True)
rng = np.random.default_rng(20261112)

fy = np.fft.fftfreq(N)[:, None] * N
fx = np.fft.fftfreq(N)[None, :] * N
FR = np.hypot(fx, fy)


def fnoise(beta, lo=1.0, hi=None, seed=None, aniso=None):
    """Periodic noise with a 1/f^beta spectrum between lo and hi cycles per tile, in [-1, 1]."""
    r = np.random.default_rng(seed) if seed is not None else rng
    spec = np.fft.fft2(r.standard_normal((N, N)))
    f = FR if aniso is None else np.hypot(fx * aniso[0], fy * aniso[1])
    filt = np.where(f >= lo, np.maximum(f, 1e-6) ** (-beta), 0.0)
    if hi is not None:
        filt *= np.exp(-((f / hi) ** 4))
    out = np.real(np.fft.ifft2(spec * filt))
    return out / (np.abs(out).max() + 1e-9)


def blur(a, s):
    return ndimage.gaussian_filter(a, s, mode="wrap")


def norm01(a):
    return (a - a.min()) / (a.max() - a.min() + 1e-9)


def stamp(height, mask, cx, cy, rx, ry, ang, h, sharp=2.2, tint=None, tintmap=None):
    """Add a rounded ellipsoidal bump (wrapping around the tile edges)."""
    R = int(max(rx, ry) * 1.25) + 2
    ys, xs = np.mgrid[-R : R + 1, -R : R + 1].astype(np.float32)
    c, s = np.cos(ang), np.sin(ang)
    u = (xs * c + ys * s) / rx
    v = (-xs * s + ys * c) / ry
    d = np.sqrt(u * u + v * v)
    prof = np.clip(1 - d**sharp, 0, 1) ** 0.6  # dome with a steep edge
    iy = (np.arange(-R, R + 1) + int(cy)) % N
    ix = (np.arange(-R, R + 1) + int(cx)) % N
    sub = np.ix_(iy, ix)
    height[sub] = np.maximum(height[sub], height[sub] * (1 - prof) + (height[sub] + h) * prof)
    m = np.clip(prof * 3.0, 0, 1)
    mask[sub] = np.maximum(mask[sub], m)
    if tintmap is not None:
        tintmap[sub] = tintmap[sub] * (1 - m) + tint * m


def normal_from(height, strength):
    dx = (np.roll(height, -1, 1) - np.roll(height, 1, 1)) * 0.5
    dy = (np.roll(height, -1, 0) - np.roll(height, 1, 0)) * 0.5
    nx, ny, nz = -dx * strength, -dy * strength, np.ones_like(height)
    l = np.sqrt(nx * nx + ny * ny + nz * nz)
    return nx / l, ny / l


def cavity(height, radius, gain):
    """1 = open surface, darker in pits and at the foot of bumps."""
    return np.clip(1 - np.maximum(0, blur(height, radius) - height) * gain, 0, 1)


def save(name, height, strength, albedo, ao, mask):
    h01 = norm01(height)
    print(f"  {name}: height range {(height.max() - height.min()) * N / 1024:.1f} px of a 1024 px tile")
    # Heights are in pixels (1 px = 2.34 mm on a 2.4 m tile), so the slope is physical; `strength` exaggerates it a little.
    nx, ny = normal_from(height * (N / 1024.0), strength)
    n_img = np.dstack([nx * 0.5 + 0.5, ny * 0.5 + 0.5, h01])
    a_img = np.dstack([np.clip(albedo, 0, 1), np.clip(ao, 0, 1), np.clip(mask, 0, 1)])
    for suffix, img, q in (("n", n_img, 93), ("a", a_img, 90)):
        path = os.path.join(OUT, f"{name}_{suffix}.jpg")
        Image.fromarray((img * 255 + 0.5).astype(np.uint8)).save(path, quality=q, subsampling=0, optimize=True)
        print(f"  {name}_{suffix}.jpg  {os.path.getsize(path) // 1024} KB")


# ---------------------------------------------------------------------------
# 1. Regolith: dust matrix, granules, half-buried pebbles (tile ~2.4 m)
# ---------------------------------------------------------------------------
print("soil")
base = fnoise(2.2, 1, 40, seed=11) * 0.9 + fnoise(1.4, 24, 220, seed=12) * 0.22
height = base * 5.0
peb = np.zeros((N, N), np.float32)
tint = np.full((N, N), 0.5, np.float32)
px = N / 2400.0  # pixels per millimetre
# Size-frequency of fragments follows a power law: many granules, few cobbles.
sizes = np.concatenate([
    (rng.pareto(2.3, 6000) + 1) * 2.6,   # granules 3-10 mm
    (rng.pareto(3.2, 260) + 1) * 8.0,    # small pebbles; anything larger is real geometry in the scene
])
sizes = np.clip(sizes, 2.2, 24.0)
order = np.argsort(sizes)  # small first, large on top
for r_mm in sizes[order]:
    rx = r_mm * px * rng.uniform(0.7, 1.3)
    ry = r_mm * px * rng.uniform(0.5, 1.0)
    stamp(height, peb, rng.uniform(0, N), rng.uniform(0, N), rx, ry, rng.uniform(0, np.pi), r_mm * px * rng.uniform(0.28, 0.6) * 0.9,
          sharp=rng.uniform(1.8, 3.2), tint=rng.uniform(0.15, 0.95), tintmap=tint)
# Dust drifts against the stones: blur the field a little and keep the stones proud of it.
drift = blur(height, 5.0)
height = np.where(peb > 0.05, height, height * 0.55 + drift * 0.45)
grain = fnoise(0.2, 120, None, seed=13)
height += grain * 0.55 * (1 - peb * 0.5)
ao = cavity(height, 6, 0.09) * (0.82 + 0.18 * cavity(height, 22, 0.05))
# Albedo: bright dust in the lows, grey-brown stone on the pebbles, random stone to stone.
alb = 0.56 + 0.16 * norm01(blur(base, 3)) + 0.05 * grain
alb = alb * (1 - peb) + (0.30 + 0.36 * tint) * peb
alb = alb * (0.86 + 0.14 * ao)
save("soil", height, 1.15, alb, ao, peb)

# ---------------------------------------------------------------------------
# 2. Sand: wind ripples (wavelength ~10 cm) with defects, coarse grains on the crests
# ---------------------------------------------------------------------------
print("sand")
ys, xs = np.mgrid[0:N, 0:N].astype(np.float32) / N
warp = fnoise(2.6, 1, 9, seed=21) * 0.085 + fnoise(2.0, 6, 30, seed=22) * 0.012
waves = 24  # ripples per tile (2.4 m / 24 = 10 cm)
phase = 2 * np.pi * (waves * ys + 3 * xs) + 2 * np.pi * waves * warp
s = np.sin(phase)
# Asymmetric profile: long gentle windward slope, short steep lee face.
prof = 0.5 + 0.5 * np.sin(phase + 0.55 * np.cos(phase))
amp = 0.62 + 0.38 * norm01(fnoise(2.4, 1, 6, seed=23))
height = prof * amp * 5.0 + fnoise(2.5, 1, 8, seed=24) * 7.0
grain = fnoise(0.15, 140, None, seed=25)
crest = np.clip((prof - 0.62) * 3.2, 0, 1) * amp
coarse = np.clip(fnoise(0.4, 60, 260, seed=26) * 2.2, 0, 1) * crest
height += grain * 0.42 + coarse * 1.1
ao = cavity(height, 9, 0.11)
alb = 0.6 + 0.1 * (1 - prof) + 0.06 * grain - 0.2 * crest * (0.5 + 0.5 * coarse)
alb *= 0.9 + 0.1 * ao
save("sand", height, 1.3, alb, ao, np.clip(crest * 0.7 + coarse * 0.5, 0, 1))

# ---------------------------------------------------------------------------
# 3. Bedrock: fractured, finely laminated slabs with sand-filled joints and bright veins
# ---------------------------------------------------------------------------
print("rock")
n_cells = 46
pts = rng.uniform(0, N, (n_cells, 2))
# Periodic Voronoi: replicate the seeds around the tile.
tiles = np.concatenate([pts + np.array([dx, dy]) * N for dx in (-1, 0, 1) for dy in (-1, 0, 1)])
tree = cKDTree(tiles)
yy, xx = np.mgrid[0:N, 0:N]
warp_x = fnoise(2.2, 2, 30, seed=31) * 22
warp_y = fnoise(2.2, 2, 30, seed=32) * 22
q = np.c_[(xx + warp_x).ravel(), (yy + warp_y).ravel()]
d, idx = tree.query(q, k=2)
d1, d2 = d[:, 0].reshape(N, N), d[:, 1].reshape(N, N)
cell = (idx[:, 0] % n_cells).reshape(N, N)
edge = d2 - d1  # distance to the joint, pixels
cell_rand = rng.uniform(0, 1, n_cells)
tilt_x = rng.uniform(-1, 1, n_cells)[cell]
tilt_y = rng.uniform(-1, 1, n_cells)[cell]
local = pts[cell]
relx = ((xx - local[..., 0] + N / 2) % N - N / 2) / N
rely = ((yy - local[..., 1] + N / 2) % N - N / 2) / N
plate = cell_rand[cell] * 9.0 + (tilt_x * relx + tilt_y * rely) * 60.0
joint = np.clip(edge / 9.0, 0, 1) ** 0.55  # 0 in the crack, 1 on the slab
# Laminations: thin layers exposed as steps across each slab.
lam_dir = rng.uniform(0, np.pi, n_cells)[cell]
lam_coord = (np.cos(lam_dir) * xx + np.sin(lam_dir) * yy) / N * 70 + fnoise(2.0, 2, 20, seed=33) * 2.2
lam = np.abs((lam_coord % 1.0) - 0.5) * 2
steps = np.floor(lam_coord) % 3 * 0.9
pits = np.clip(-fnoise(0.9, 30, 200, seed=34) - 0.28, 0, 1) ** 1.2 * 6.0
fine = fnoise(0.4, 80, None, seed=35)
height = (plate + steps * 1.6 + lam * 0.6 - pits + fine * 0.5) * joint + (joint - 1) * 16.0
# Sand in the joints: flat fill a little below the slab surface.
fill = np.clip(1 - edge / 5.0, 0, 1)
height = height * (1 - fill * 0.45) + (blur(height, 6) - 3.0) * fill * 0.45
# Calcium-sulfate veins: thin bright lines crossing the slabs.
v1 = np.abs(fnoise(2.4, 2, 14, seed=36))
v2 = np.abs(fnoise(2.4, 3, 18, seed=37))
vein = np.clip(1 - np.minimum(v1, v2) * 110, 0, 1) ** 2 * joint * (fnoise(2.0, 1, 5, seed=38) > 0.25)
height += vein * 1.6
ao = cavity(height, 5, 0.07) * (0.8 + 0.2 * cavity(height, 18, 0.04))
alb = 0.52 + 0.2 * cell_rand[cell] * 0.6 + 0.07 * lam + 0.05 * fine - 0.12 * np.clip(pits / 6, 0, 1)
alb = alb * (1 - fill * 0.35)  # darker sand in the joints
alb = alb * (1 - vein) + 0.97 * vein
alb *= 0.84 + 0.16 * ao
save("rock", height, 1.0, alb, ao, vein)

# ---------------------------------------------------------------------------
# 4. Boulder surface: wind-pitted, faintly layered, dusty in the hollows
# ---------------------------------------------------------------------------
print("stone")
body = fnoise(2.0, 1, 30, seed=41) * 5.0 + fnoise(1.2, 20, 160, seed=42) * 1.4
# Vesicles / ventifact pits of several sizes.
pit = np.zeros((N, N), np.float32)
for scale, count in ((9, 260), (4.5, 900), (2.2, 2600)):
    p = rng.uniform(0, N, (count, 2))
    t = cKDTree(np.concatenate([p + np.array([dx, dy]) * N for dx in (-1, 0, 1) for dy in (-1, 0, 1)]))
    dd, _ = t.query(np.c_[xx.ravel(), yy.ravel()], k=1)
    pit = np.maximum(pit, np.clip(1 - dd.reshape(N, N) / scale, 0, 1) ** 0.7 * (scale / 9) ** 0.5)
layers = np.sin((yy / N * 34 + fnoise(2.2, 1, 12, seed=43) * 1.4) * 2 * np.pi) * 0.5 + 0.5
fine = fnoise(0.3, 100, None, seed=44)
height = body + layers * 1.1 - pit * 4.2 + fine * 0.5
ao = cavity(height, 5, 0.1) * (0.85 + 0.15 * cavity(height, 20, 0.05))
alb = 0.5 + 0.14 * norm01(body) + 0.08 * layers + 0.05 * fine + 0.1 * pit  # dust sits in the pits
alb *= 0.82 + 0.18 * ao
save("stone", height, 1.2, alb, ao, pit)
print("done")
