"""Bake the real Gale-crater data the visor renders around the 240 m site.

Sources (NASA, public domain):
  * MGS MOLA MEGDR 128 px/deg topography (PDS Geosciences Node), 16-bit metres.
  * NASA Mars Trek WMTS tiles: MRO HiRISE Curiosity mosaic, HiRISE Gale DEM
    (8-bit), MRO CTX Gale mosaic.

Outputs (public/gale/):
  site.json            metadata: position, regional tilt, grid extents
  site-hirise.jpg      240 m site, 0.47 m/px        (near tile albedo)
  mid-hirise.jpg       +-1.28 km, 2.5 m/px          (ground just beyond the tile)
  regional-ctx.jpg     +-5.5 km, 10.7 m/px
  far-ctx.jpg          +-110 km, 215 m/px           (whole crater)
  mid-dem.bin          Int16 LE decimetres, 512 x 512, +-5.5 km (HiRISE DEM, de-terraced, feathered into MOLA)
  far-dem.bin          Int16 LE metres,     384 x 384, +-110 km (MOLA)
Heights are relative to the site elevation. Rows run north -> south, columns west -> east.

Run:  python scripts/bake-gale.py [cache_dir]
"""
import io
import json
import math
import os
import sys
import urllib.request
from concurrent.futures import ThreadPoolExecutor

import numpy as np
from PIL import Image
from scipy import ndimage

LAT, LON, SOL = -4.82525828, 137.3889348, 5069  # Curiosity waypoint (NASA MMGIS, 2026-11-09)
M_PER_DEG = 59157.0
COS = math.cos(math.radians(LAT))
TREK = "https://trek.nasa.gov/tiles/Mars/EQ"
MOLA_URL = "https://pds-geosciences.wustl.edu/mgs/mgs-m-mola-5-megdr-l3-v1/mgsl_300x/meg128/megt00n090hb.img"
GALE_DEM_CAL = (18.613, -4600.0)  # metres per DN, offset (fitted on 174 traverse elevations)

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "public", "gale")
CACHE = sys.argv[1] if len(sys.argv) > 1 else os.path.join(ROOT, ".cache-gale")
os.makedirs(OUT, exist_ok=True)
os.makedirs(CACHE, exist_ok=True)


def get(url, path, headers=None):
    if os.path.exists(path) and os.path.getsize(path) > 0:
        return open(path, "rb").read()
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0", **(headers or {})})
    err = None
    for _ in range(4):
        try:
            data = urllib.request.urlopen(req, timeout=90).read()
            open(path, "wb").write(data)
            return data
        except Exception as e:  # noqa: BLE001
            err = e
    raise RuntimeError(f"{url}: {err}")


def fetch_box(layer, ext, z, lat_min, lat_max, lon_min, lon_max):
    """Stitch the tiles covering a box; returns (grey+alpha array, lat_top, lon_left, deg_per_px)."""
    deg = 180.0 / 2**z
    c0, c1 = int((lon_min + 180) // deg), int((lon_max + 180) // deg)
    r0, r1 = int((90 - lat_max) // deg), int((90 - lat_min) // deg)
    d = os.path.join(CACHE, layer, str(z))
    os.makedirs(d, exist_ok=True)
    jobs = [(r, c) for r in range(r0, r1 + 1) for c in range(c0, c1 + 1)]

    def one(rc):
        r, c = rc
        try:
            raw = get(f"{TREK}/{layer}/1.0.0/default/default028mm/{z}/{r}/{c}.{ext}", os.path.join(d, f"{r}_{c}.{ext}"))
            return rc, Image.open(io.BytesIO(raw)).convert("LA")
        except Exception:  # noqa: BLE001
            return rc, None

    mosaic = np.zeros(((r1 - r0 + 1) * 256, (c1 - c0 + 1) * 256, 2), np.uint8)
    missing = 0
    with ThreadPoolExecutor(12) as ex:
        for (r, c), img in ex.map(one, jobs):
            if img is None:
                missing += 1
                continue
            mosaic[(r - r0) * 256 : (r - r0 + 1) * 256, (c - c0) * 256 : (c - c0 + 1) * 256] = np.asarray(img.resize((256, 256)))
    print(f"  {layer} z{z}: {len(jobs)} tiles ({missing} missing) -> {mosaic.shape[1]} x {mosaic.shape[0]} px")
    return mosaic, 90 - r0 * deg, c0 * deg - 180, deg / 256


def local_grid(n, half_m):
    """lat/lon of the centres of an n x n grid covering +-half_m around the site (row 0 = north)."""
    t = (np.arange(n) + 0.5) / n * 2 - 1
    lon = LON + t * half_m / (M_PER_DEG * COS)
    lat = LAT - t * half_m / M_PER_DEG
    return lat, lon


def sample(band, lat_top, lon_left, dpp, lat, lon, order=1):
    rows = (lat_top - lat) / dpp - 0.5
    cols = (lon - lon_left) / dpp - 0.5
    rr, cc = np.meshgrid(rows, cols, indexing="ij")
    return ndimage.map_coordinates(band.astype(np.float32), [rr, cc], order=order, mode="nearest")


def crop_resize(band, lat_top, lon_left, dpp, half_m, n):
    """Affine crop of a +-half_m box, resampled with an antialiasing filter."""
    lat_max, lat_min = LAT + half_m / M_PER_DEG, LAT - half_m / M_PER_DEG
    lon_min, lon_max = LON - half_m / (M_PER_DEG * COS), LON + half_m / (M_PER_DEG * COS)
    box = ((lon_min - lon_left) / dpp, (lat_top - lat_max) / dpp, (lon_max - lon_left) / dpp, (lat_top - lat_min) / dpp)
    return np.asarray(Image.fromarray(band).resize((n, n), Image.LANCZOS, box=box)).astype(np.float32)


def save_gray(arr01, name, q=88):
    path = os.path.join(OUT, name)
    Image.fromarray((np.clip(arr01, 0, 1) * 255 + 0.5).astype(np.uint8), "L").save(path, quality=q, optimize=True)
    print(f"  wrote {name} ({os.path.getsize(path) // 1024} KB)")


# ---------------------------------------------------------------------------
print("1/5 near-tile HiRISE (240 m site)")
dlat, dlon = 400 / M_PER_DEG, 400 / (M_PER_DEG * COS)
hi, top, left, dpp = fetch_box("curiosity_hirise_mosaic", "png", 16, LAT - dlat, LAT + dlat, LON - dlon, LON + dlon)
site_img = crop_resize(hi[..., 0], top, left, dpp, 120.0, 512)
lo, hi_v = float(site_img.min()), float(site_img.max())
# Grey scale shared by every image: the site spans 0.12 .. 0.74, which leaves room for the
# brighter outcrops and darker dunes around it without clipping them.
G0, G1 = 0.12, 0.62


def grey(img):
    return np.clip(G0 + G1 * (img - lo) / max(1.0, hi_v - lo), 0, 1)


site01 = grey(site_img)
save_gray(site01, "site-hirise.jpg", 90)

print("2/5 mid HiRISE (+-1.28 km)")
MID_IMG_HALF = 1280.0
dlat, dlon = 1500 / M_PER_DEG, 1500 / (M_PER_DEG * COS)
hi14, top, left, dpp = fetch_box("curiosity_hirise_mosaic", "png", 14, LAT - dlat, LAT + dlat, LON - dlon, LON + dlon)
mid_img = crop_resize(hi14[..., 0], top, left, dpp, MID_IMG_HALF, 1024)
# Same grey scale as the site crop, so the tile and its surroundings match in tone.
mid01 = grey(mid_img)
print(f"  site grey mean {site01.mean():.3f}, surroundings mean {mid01.mean():.3f}, clipped {100 * (mid01 >= 0.999).mean():.2f} %")
save_gray(mid01, "mid-hirise.jpg")

print("3/5 CTX regional (+-5.5 km) and whole crater (+-110 km)")
REG_HALF, FAR_HALF = 5500.0, 110000.0
dlat, dlon = 6000 / M_PER_DEG, 6000 / (M_PER_DEG * COS)
ctx12, top, left, dpp = fetch_box("Gale_CTX_BlockAdj_dd", "png", 12, LAT - dlat, LAT + dlat, LON - dlon, LON + dlon)
reg = crop_resize(ctx12[..., 0], top, left, dpp, REG_HALF, 1024)
# Match the CTX tone to HiRISE over the area both cover (+-1.28 km).
k = int(1024 * MID_IMG_HALF / REG_HALF / 2)
inner = reg[512 - k : 512 + k, 512 - k : 512 + k]
reg01 = np.clip((reg - inner.mean()) * (mid01.std() / max(1e-3, inner.std())) + mid01.mean(), 0, 1)
save_gray(reg01, "regional-ctx.jpg")

dlat, dlon = 118000 / M_PER_DEG, 118000 / (M_PER_DEG * COS)
ctx8, top, left, dpp = fetch_box("Gale_CTX_BlockAdj_dd", "png", 8, LAT - dlat, LAT + dlat, LON - dlon, LON + dlon)
far = crop_resize(ctx8[..., 0], top, left, dpp, FAR_HALF, 1024)
far_a = crop_resize(ctx8[..., 1], top, left, dpp, FAR_HALF, 1024) > 128
k = max(4, int(1024 * REG_HALF / FAR_HALF / 2))
inner = far[512 - k : 512 + k, 512 - k : 512 + k]
far01 = np.clip((far - inner.mean()) * (reg01.std() / max(1e-3, far[far_a].std())) + reg01.mean(), 0, 1)
far01[~far_a] = float(np.median(far01[far_a]))  # outside the mosaic: neutral tone
save_gray(far01, "far-ctx.jpg")

# ---------------------------------------------------------------------------
print("4/5 MOLA topography (+-110 km)")
PPD = 128
l0, l1 = int(-(LAT + 2.05) * PPD), int(-(LAT - 2.05) * PPD) + 1
raw = get(MOLA_URL, os.path.join(CACHE, f"mola_{l0}_{l1}.bin"), {"Range": f"bytes={l0 * 11520 * 2}-{l1 * 11520 * 2 - 1}"})
mola = np.frombuffer(raw, ">i2").reshape(l1 - l0, 11520).astype(np.float32)


def mola_at(lat, lon):
    rr, cc = np.meshgrid(-lat * PPD - 0.5 - l0, (lon - 90) * PPD - 0.5, indexing="ij")
    return ndimage.map_coordinates(mola, [rr, cc], order=3, mode="nearest")


FAR_N = 384
far_dem = mola_at(*local_grid(FAR_N, FAR_HALF))
print(f"  MOLA range {far_dem.min():.0f} .. {far_dem.max():.0f} m")

print("5/5 HiRISE Gale DEM (+-5.5 km), de-terraced")
dlat, dlon = 5700 / M_PER_DEG, 5700 / (M_PER_DEG * COS)
gd, top, left, dpp = fetch_box("Gale_DEM_SMG_1m", "png", 14, LAT - dlat, LAT + dlat, LON - dlon, LON + dlon)
WORK = 1100  # 10 m working grid
lat, lon = local_grid(WORK, REG_HALF)
dn = np.rint(sample(gd[..., 0], top, left, dpp, lat, lon, order=0)).astype(np.int32)
alpha = sample(gd[..., 1], top, left, dpp, lat, lon, order=0) > 200
print(f"  DEM coverage {alpha.mean() * 100:.0f} %, DN {dn[alpha].min()} .. {dn[alpha].max()}")
# Each DN is an 18.6 m terrace: rebuild a smooth surface by interpolating between its two contour lines.
h = dn.astype(np.float32)
for L in np.unique(dn[alpha]):
    m = (dn == L) & alpha
    lower, upper = (dn < L) & alpha, (dn > L) & alpha
    if lower.any() and upper.any():
        d_low = ndimage.distance_transform_edt(~lower)
        d_up = ndimage.distance_transform_edt(~upper)
        f = d_low / np.maximum(1e-6, d_low + d_up)
    elif lower.any():
        f = np.minimum(1.0, ndimage.distance_transform_edt(~lower) / 40.0) * 0.5
    elif upper.any():
        f = 1 - np.minimum(1.0, ndimage.distance_transform_edt(~upper) / 40.0) * 0.5
    else:
        f = np.full(h.shape, 0.5, np.float32)
    h[m] = (L - 0.5 + f)[m]
h = ndimage.gaussian_filter(h, 1.5)
mid_abs = GALE_DEM_CAL[1] + GALE_DEM_CAL[0] * h

# MOLA on the same grid, to fill gaps and feather the borders.
mola_mid = mola_at(lat, lon)
bias = float(np.median((mid_abs - mola_mid)[alpha]))
print(f"  HiRISE DEM - MOLA median offset: {bias:.1f} m (added to MOLA so the two join)")
t = (np.arange(WORK) + 0.5) / WORK * 2 - 1
edge = np.maximum(np.abs(t)[None, :], np.abs(t)[:, None])
w = np.clip((1 - edge) / 0.18, 0, 1)
w = w * w * (3 - 2 * w)
w = w * np.clip(ndimage.gaussian_filter(alpha.astype(np.float32), 8) * 2 - 1, 0, 1)
mid_final = mola_mid + bias + w * (mid_abs - (mola_mid + bias))

# Site elevation and regional tilt: plane fitted on +-600 m (as the live loader does).
c = WORK // 2
step = 2 * REG_HALF / WORK
r = int(600 / step)
win = mid_abs[c - r : c + r, c - r : c + r]
yy, xx = np.mgrid[-r:r, -r:r]
A = np.c_[(xx.ravel() + 0.5) * step, -(yy.ravel() + 0.5) * step, np.ones(win.size)]
(tilt_e, tilt_n, _plane0), *_ = np.linalg.lstsq(A, win.ravel(), rcond=None)
site_elev = float(mid_final[c - 1 : c + 1, c - 1 : c + 1].mean())
print(f"  site elevation {site_elev:.0f} m, tilt east {tilt_e:.4f}, north {tilt_n:.4f} ({math.degrees(math.atan(math.hypot(tilt_e, tilt_n))):.1f} deg)")

MID_N = 512
mid_small = np.asarray(Image.fromarray((mid_final - site_elev).astype(np.float32)).resize((MID_N, MID_N), Image.LANCZOS))
np.clip(np.rint(mid_small * 10), -32768, 32767).astype("<i2").tofile(os.path.join(OUT, "mid-dem.bin"))
far_rel = far_dem + bias - site_elev
np.clip(np.rint(far_rel), -32768, 32767).astype("<i2").tofile(os.path.join(OUT, "far-dem.bin"))
print(f"  mid range {mid_small.min():.0f} .. {mid_small.max():.0f} m rel., far range {far_rel.min():.0f} .. {far_rel.max():.0f} m rel.")

json.dump(
    {
        "lat": LAT,
        "lon": LON,
        "sol": SOL,
        "elevation": round(site_elev, 1),
        "tilt": {"east": round(float(tilt_e), 5), "north": round(float(tilt_n), 5)},
        "siteHalf": 120,
        "midImageHalf": MID_IMG_HALF,
        "regionalHalf": REG_HALF,
        "farHalf": FAR_HALF,
        "midDem": {"n": MID_N, "half": REG_HALF, "unit": 0.1},
        "farDem": {"n": FAR_N, "half": FAR_HALF, "unit": 1},
        "sources": [
            "MGS MOLA MEGDR 128 ppd (PDS Geosciences Node)",
            "MRO HiRISE Curiosity mosaic and Gale DEM (NASA Mars Trek)",
            "MRO CTX Gale mosaic (NASA Mars Trek)",
        ],
    },
    open(os.path.join(OUT, "site.json"), "w"),
    indent=1,
)


def hillshade(z, cell):
    gy, gx = np.gradient(z, cell)
    n = np.dstack([-gx, gy, np.ones_like(z)])
    n /= np.linalg.norm(n, axis=2, keepdims=True)
    light = np.array([-0.5, 0.5, 0.7])
    return np.clip(n @ (light / np.linalg.norm(light)), 0, 1)


# Previews, to check the result by eye.
Image.fromarray((hillshade(mid_final, step) * 255).astype(np.uint8)).resize((700, 700)).save(os.path.join(CACHE, "preview-mid-dem.png"))
Image.fromarray((hillshade(far_dem, 2 * FAR_HALF / FAR_N * 0.15) * 255).astype(np.uint8)).resize((700, 700)).save(os.path.join(CACHE, "preview-far-dem.png"))
print("done")
