"""Georreferencia y lectura de recortes del DEM / ortofoto de Gale (USGS Astrogeology, dominio publico).

Proyeccion: equirectangular, radio 3 396 190 m, longitud positiva al este, centro en lon 0 / lat 0
(etiqueta ISIS del producto). DEM de 1 m: origen X = 8127993.9928 m, Y = -244781.5752 m (esquina sup. izq.).
Un recorte lee SOLO las filas necesarias (el DEM esta guardado por filas completas, LZW).
"""
import math

import numpy as np
import tifffile
import zarr

from remoto import RangeFile

R_MARTE = 3396190.0
URL_DEM = "https://planetarymaps.usgs.gov/mosaic/Mars/MSL/MSL_Gale_DEM_Mosaic_1m_v3.tif"
X0_DEM, Y0_DEM, TAM_DEM = 8127993.992786024, -244781.575189438, 1.0
NODATA = -32767.0


def lonlat_a_xy(lon, lat):
    return math.radians(lon) * R_MARTE, math.radians(lat) * R_MARTE


def xy_a_lonlat(x, y):
    return math.degrees(x / R_MARTE), math.degrees(y / R_MARTE)


def lonlat_a_pix(lon, lat, x0=X0_DEM, y0=Y0_DEM, tam=TAM_DEM):
    x, y = lonlat_a_xy(lon, lat)
    return (y0 - y) / tam, (x - x0) / tam        # fila, columna (flotantes)


def leer_dem(fila0, fila1, col0, col1, paso=1, url=URL_DEM, remoto=None):
    """Elevacion [m] de filas fila0:fila1 y columnas col0:col1 (indices de pixel), con paso. Devuelve array, RangeFile."""
    f = remoto or RangeFile(url)
    with tifffile.TiffFile(f) as tf:
        z = zarr.open(tf.pages[0].aszarr(), mode="r")
        a = np.asarray(z[fila0:fila1:paso, col0:col1:paso], dtype=np.float32)
    a[a == NODATA] = np.nan
    return a, f
