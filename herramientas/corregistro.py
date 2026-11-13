"""Mide el desfase de HiRISE y de CRISM respecto al DEM de USGS (la referencia).

    python herramientas/corregistro.py

HiRISE RDR y CRISM MTRDR se proyectan con la orientacion de la nave, sin control de terreno: en esta zona
quedan desplazados ~100 m respecto al mosaico de USGS (atado a MOLA). Los desfases que imprime este script
son las constantes REG_HIRISE y REG_CRISM de construir_terreno.py:
    coordenada en el producto = coordenada DEM + desfase  (este, norte) en metros

Metodo: correlacion cruzada normalizada (NCC).
  - HiRISE: sombreado sintetico del DEM con el sol de la imagen (azimut 209, elevacion 38,5) contra la banda RED.
  - CRISM:  reflectancia R770 contra la banda RED de HiRISE (ya corregida) promediada a 18 m.
"""
import json
import math
from pathlib import Path

import numpy as np
import rasterio
from rasterio.enums import Resampling
from rasterio.windows import Window
from scipy.ndimage import gaussian_filter
from scipy.signal import fftconvolve

RAIZ = Path(__file__).resolve().parents[1]
CRUDOS = RAIZ / "datos_crudos"
R = 3396190.0
HIRISE = CRUDOS / "hirise/mrohr_0001/rdr/esp/orb_087100_087199/esp_087149_1750/esp_087149_1750_color.jp2"
CRISM = CRUDOS / "crism/frt0000b6f1_07_su165j_mtr3_bandas.npz"
CX0, CY0, CT = 8138478.6, -278195.96, 18.0
SOL_AZ_DEG, SOL_EL_DEG = 209.0, 38.5          # SUB_SOLAR_AZIMUTH (horario desde el este) y 90 - INCIDENCE_ANGLE
BUSQUEDA_M = 250


def desfase_hirise():
    meta = json.loads((CRUDOS / "usgs/dem_gale_1m_ventana.json").read_text())
    dem = np.load(CRUDOS / "usgs/dem_gale_1m_ventana.npy").astype(float)
    M, L = meta["margen_px"], dem.shape[0]
    xw, ys = meta["x_sw_m"] - M, meta["y_sw_m"] - M
    gy, gx = np.gradient(gaussian_filter(dem, 1.5), 1.0)
    gy = -gy                                                     # filas hacia el sur -> dz/dnorte
    az, el = math.radians(-SOL_AZ_DEG), math.radians(SOL_EL_DEG)
    sol = (math.cos(el) * math.cos(az), math.cos(el) * math.sin(az), math.sin(el))
    sombra = (-gx * sol[0] - gy * sol[1] + sol[2]) / np.sqrt(gx ** 2 + gy ** 2 + 1)
    with rasterio.open(HIRISE) as ds:
        hx0, hy0 = ds.transform.c + R * math.pi, ds.transform.f
        B, n = BUSQUEDA_M, L + 2 * BUSQUEDA_M
        c0 = int(round((xw - hx0) / 0.25)) - B * 4
        f0 = int(round((hy0 - (ys + L)) / 0.25)) - B * 4
        assert c0 >= 0 and f0 >= 0
        ancho = min(n * 4, ds.width - c0)
        img = ds.read(2, window=Window(c0, f0, ancho, n * 4), out_shape=(n, ancho // 4), resampling=Resampling.average).astype(float)
    val = img > 0
    paso_alto = lambda a: a - gaussian_filter(a, 25)
    I = paso_alto(np.where(val, img, img[val].mean())) * val
    T = paso_alto(sombra)[20:-20, 20:-20]
    T -= T.mean()
    num = fftconvolve(I, T[::-1, ::-1], mode="valid")
    den = np.sqrt(np.maximum(fftconvolve(I ** 2, np.ones_like(T), mode="valid"), 1e-9) * (T ** 2).sum())
    cob = fftconvolve(val.astype(float), np.ones_like(T), mode="valid") / T.size
    ncc = np.where(cob > 0.97, num / den, -1)
    r, c = np.unravel_index(np.argmax(ncc), ncc.shape)
    r0 = c0_ = B + 20
    return (float(c - c0_), float(-(r - r0))), float(ncc[r, c]), float(ncc[r0, c0_])


def desfase_crism(reg_hirise):
    cr = np.load(CRISM)["R770"]
    with rasterio.open(HIRISE) as ds:
        f = 8
        h = ds.read(2, out_shape=(ds.height // f, ds.width // f), resampling=Resampling.average).astype(float)
        hx0 = ds.transform.c + R * math.pi - reg_hirise[0]       # HiRISE llevada al marco del DEM
        hy0 = ds.transform.f - reg_hirise[1]
    hv, k = h > 0, 9
    Hh, Wh = (h.shape[0] // k) * k, (h.shape[1] // k) * k
    s = (h * hv)[:Hh, :Wh].reshape(Hh // k, k, Wh // k, k).sum((1, 3))
    n = hv[:Hh, :Wh].reshape(Hh // k, k, Wh // k, k).sum((1, 3))
    h18 = np.where(n == k * k, s / np.maximum(n, 1), np.nan)
    x18 = hx0 + (np.arange(Wh // k) + 0.5) * 18.0
    y18 = hy0 - (np.arange(Hh // k) + 0.5) * 18.0
    paso_alto = lambda a: a - gaussian_filter(np.nan_to_num(a, nan=np.nanmean(a)), 6)
    crh, h18h = paso_alto(cr), paso_alto(h18)
    res = []
    for df in range(-14, 15):
        for dc in range(-14, 15):
            c = np.floor((x18 - CX0) / CT).astype(int) + dc
            r = np.floor((CY0 - y18) / CT).astype(int) + df
            okr, okc = (r >= 0) & (r < cr.shape[0]), (c >= 0) & (c < cr.shape[1])
            m = np.isfinite(cr[np.ix_(r[okr], c[okc])]) & np.isfinite(h18[np.ix_(okr, okc)])
            if m.sum() < 3000:
                continue
            a, b = crh[np.ix_(r[okr], c[okc])][m], h18h[np.ix_(okr, okc)][m]
            a, b = a - a.mean(), b - b.mean()
            res.append((float((a * b).sum() / np.sqrt((a * a).sum() * (b * b).sum())), dc, df))
    mejor = max(res)
    cero = next(x[0] for x in res if x[1] == 0 and x[2] == 0)
    return (mejor[1] * CT, -mejor[2] * CT), mejor[0], cero


if __name__ == "__main__":
    reg_h, ncc, ncc0 = desfase_hirise()
    print(f"REG_HIRISE = {reg_h}   NCC {ncc:.2f} (sin corregir {ncc0:.2f})")
    reg_c, ncc, ncc0 = desfase_crism(reg_h)
    print(f"REG_CRISM  = {reg_c}   NCC {ncc:.2f} (sin corregir {ncc0:.2f})")
