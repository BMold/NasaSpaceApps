"""Genera el entorno de datos sinteticos (CLAUDE.md §6): terreno/ y un pedido de ejemplo.

    python generate_mocks.py [--salida terreno] [--semilla 42] [--filas 96] [--columnas 96]

Salida:
    terreno/manifest.json
    terreno/elevacion.bin     float32 LE, fila por fila (fila 0 = sur), metros
    terreno/eta_terreno.bin   float32 LE, factor de terreno en [1, 2]
    terreno/peligro.bin       uint8: 0 libre, 1 bloqueo estatico
    terreno/sitios.json       12 sitios cientificos
    contratos/ejemplos/pedido.json

Todo es SINTETICO: no representa el relieve real de Mount Sharp.
"""
import argparse
import json
from pathlib import Path

import numpy as np
from scipy.ndimage import gaussian_filter

from optimizador.constantes import MINERALES, N_MAX_SITIOS, VERSION
from optimizador.terreno import calcular_eta

TAM = 2.5


def generar(salida: Path, semilla: int, filas: int, columnas: int) -> None:
    rng = np.random.default_rng(semilla)
    ancho, alto = columnas * TAM, filas * TAM
    x = (np.arange(columnas) + 0.5) * TAM
    y = (np.arange(filas) + 0.5) * TAM
    X, Y = np.meshgrid(x, y)                      # [fila, columna]; fila 0 = sur

    # Elevacion: rampa regional + lomas y hondonadas + rugosidad fina
    z = 0.04 * Y + 0.015 * X
    for _ in range(7):
        cx, cy = rng.uniform(0, ancho), rng.uniform(0, alto)
        amp, sig = rng.uniform(-4.0, 6.0), rng.uniform(18.0, 40.0)
        z += amp * np.exp(-((X - cx) ** 2 + (Y - cy) ** 2) / (2 * sig ** 2))
    ruido = gaussian_filter(rng.normal(size=z.shape), sigma=1.5)
    parches = gaussian_filter(rng.normal(size=z.shape), sigma=10.0)
    parches = (parches - parches.min()) / (parches.max() - parches.min())
    z += 0.6 * ruido / np.abs(ruido).max() * parches   # zonas lisas y zonas rugosas
    z -= z.min()

    eta = calcular_eta(z, TAM)

    # Peligros estaticos: un crater circular y una grieta alargada
    hx, hy = ancho / 2, alto / 2
    peligro = np.zeros(z.shape, dtype=np.uint8)
    peligro[np.hypot(X - 0.30 * ancho, Y - 0.64 * alto) <= 9.0] = 1
    peligro[(np.abs(Y - 0.27 * alto) <= 3.0) & (X >= 0.58 * ancho) & (X <= 0.82 * ancho)] = 1

    # Sitios: lejos del habitat, separados entre si y fuera de los peligros
    sitios = []
    while len(sitios) < N_MAX_SITIOS:
        sx = float(rng.uniform(0.06 * ancho, 0.94 * ancho))
        sy = float(rng.uniform(0.06 * alto, 0.94 * alto))
        i, j = int(sy // TAM), int(sx // TAM)
        if peligro[max(0, i - 1):i + 2, max(0, j - 1):j + 2].any():
            continue
        if np.hypot(sx - hx, sy - hy) < 30.0:
            continue
        if any(np.hypot(sx - s["x"], sy - s["y"]) < 18.0 for s in sitios):
            continue
        k = len(sitios)
        ventana = [[10.0, 13.5], [10.0, 13.5], [10.0, 10.4], [10.25, 12.0]][k % 4]
        sitios.append({
            "id": k + 1, "x": round(sx, 1), "y": round(sy, 1),
            "valor": int(rng.integers(3, 11)),
            "mineral": MINERALES[int(rng.integers(0, len(MINERALES)))],
            "masa_kg": round(float(rng.uniform(0.3, 1.4)), 1),
            "perforacion_min": int(rng.choice([4, 6, 8])),
            "ventana": ventana,
        })

    salida.mkdir(parents=True, exist_ok=True)
    z.astype("<f4").tofile(salida / "elevacion.bin")
    eta.astype("<f4").tofile(salida / "eta_terreno.bin")
    peligro.tofile(salida / "peligro.bin")
    manifest = {
        "version": VERSION,
        "sitio": "Mount Sharp, crater Gale (SINTETICO)",
        "fuente_dem": f"sintetico: generate_mocks.py, semilla {semilla}",
        "origen": {"x": 0.0, "y": 0.0, "nota": "pendiente: esquina suroeste de la malla"},
        "marco": "ENU local (x = Este, y = Norte, z = arriba), metros",
        "tam_celda_m": TAM, "filas": filas, "columnas": columnas, "fila_0": "sur",
        "capas": {
            "elevacion": {"archivo": "elevacion.bin", "dtype": "float32", "unidad": "m"},
            "eta_terreno": {"archivo": "eta_terreno.bin", "dtype": "float32", "rango": [1, 2]},
            "peligro": {"archivo": "peligro.bin", "dtype": "uint8", "valores": {"0": "libre", "1": "bloqueo"}},
        },
        "sitios": "sitios.json",
        "habitat": {"id": "H", "x": hx, "y": hy},
    }
    _json(salida / "manifest.json", manifest)
    _json(salida / "sitios.json", {"version": VERSION, "sitios": sitios})

    pedido = {"version": VERSION, "inicio": {"x": hx, "y": hy}, "hora_solar": 10.0,
              "O2_disponible_L": 40.0, "capacidad_kg": 5.0, "sitios": sitios}
    _json(Path("contratos/ejemplos/pedido.json"), pedido)

    print(f"{salida}/: malla {filas}x{columnas} de {TAM} m, z en [0, {z.max():.1f}] m, "
          f"eta media {eta.mean():.2f}, {int(peligro.sum())} celdas bloqueadas, {len(sitios)} sitios")


def _json(ruta: Path, datos) -> None:
    ruta.parent.mkdir(parents=True, exist_ok=True)
    ruta.write_text(json.dumps(datos, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")


if __name__ == "__main__":
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--salida", default="terreno")
    ap.add_argument("--semilla", type=int, default=42)
    ap.add_argument("--filas", type=int, default=96)
    ap.add_argument("--columnas", type=int, default=96)
    a = ap.parse_args()
    generar(Path(a.salida), a.semilla, a.filas, a.columnas)
