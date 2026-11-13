"""Paquete de terreno: manifest.json + capas binarias (CLAUDE.md §6).

El optimizador es agnostico al origen de los mapas: solo lee este directorio.
"""
import json
from pathlib import Path

import numpy as np
from scipy.ndimage import uniform_filter


def calcular_eta(elevacion: np.ndarray, tam_celda_m: float) -> np.ndarray:
    """Factor de terreno eta en [1, 2]: desviacion estandar de la pendiente (%)
    en una ventana movil de 3x3 celdas, normalizada min-max."""
    dz_dy, dz_dx = np.gradient(elevacion.astype(np.float64), tam_celda_m)
    pend = 100.0 * np.hypot(dz_dx, dz_dy)
    media = uniform_filter(pend, size=3, mode="nearest")
    media2 = uniform_filter(pend ** 2, size=3, mode="nearest")
    desv = np.sqrt(np.maximum(media2 - media ** 2, 0.0))
    rango = desv.max() - desv.min()
    if rango < 1e-12:
        return np.ones_like(desv, dtype=np.float32)
    return (1.0 + (desv - desv.min()) / rango).astype(np.float32)


class Terreno:
    def __init__(self, manifest: dict, elevacion, eta, peligro, sitios):
        self.manifest = manifest
        self.filas = int(manifest["filas"])
        self.columnas = int(manifest["columnas"])
        self.tam = float(manifest["tam_celda_m"])
        origen = manifest.get("origen") or {}
        self.x0 = float(origen.get("x", 0.0))
        self.y0 = float(origen.get("y", 0.0))
        self.elevacion = elevacion      # [fila, columna], fila 0 = sur
        self.eta = eta
        self.peligro = peligro          # u8: 0 libre, >0 bloqueo estatico
        self.habitat = manifest["habitat"]
        self.refugios = manifest.get("refugios", [])    # propuesta: crateres de refugio (SPE)
        self.sitios = sitios

    @classmethod
    def cargar(cls, ruta) -> "Terreno":
        ruta = Path(ruta)
        manifest = json.loads((ruta / "manifest.json").read_text(encoding="utf-8"))
        forma = (int(manifest["filas"]), int(manifest["columnas"]))
        al_norte = manifest.get("fila_0", "sur") == "norte"

        def capa(nombre, dtype_defecto):
            info = manifest["capas"][nombre]
            if isinstance(info, str):
                info = {"archivo": info}
            dtype = {"float32": "<f4", "uint8": "u1"}[info.get("dtype", dtype_defecto)]
            a = np.fromfile(ruta / info["archivo"], dtype=dtype)
            if a.size != forma[0] * forma[1]:
                raise ValueError(f"capa {nombre}: {a.size} valores, se esperaban {forma}")
            a = a.reshape(forma)
            return a[::-1].copy() if al_norte else a

        elevacion = capa("elevacion", "float32").astype(np.float64)
        if "eta_terreno" in manifest["capas"]:
            eta = capa("eta_terreno", "float32").astype(np.float64)
        else:
            eta = calcular_eta(elevacion, float(manifest["tam_celda_m"])).astype(np.float64)
        eta = np.clip(eta, 1.0, 2.0)
        if "peligro" in manifest["capas"]:
            peligro = capa("peligro", "uint8")
        else:
            peligro = np.zeros(forma, dtype=np.uint8)

        sitios = []
        archivo_sitios = ruta / manifest.get("sitios", "sitios.json")
        if archivo_sitios.exists():
            datos = json.loads(archivo_sitios.read_text(encoding="utf-8"))
            sitios = datos["sitios"] if isinstance(datos, dict) else datos
        return cls(manifest, elevacion, eta, peligro, sitios)

    # --- conversiones ---
    @property
    def n(self) -> int:
        return self.filas * self.columnas

    def celda(self, x: float, y: float):
        j = int((x - self.x0) // self.tam)
        i = int((y - self.y0) // self.tam)
        return min(max(i, 0), self.filas - 1), min(max(j, 0), self.columnas - 1)

    def indice(self, x: float, y: float) -> int:
        i, j = self.celda(x, y)
        return i * self.columnas + j

    def centro(self, idx: int):
        i, j = divmod(idx, self.columnas)
        return self.x0 + (j + 0.5) * self.tam, self.y0 + (i + 0.5) * self.tam

    def z(self, x: float, y: float) -> float:
        i, j = self.celda(x, y)
        return float(self.elevacion[i, j])
