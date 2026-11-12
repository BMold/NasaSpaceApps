"""Grafo de vecindad 8 sobre la malla: costos en O2, tiempos, caminos minimos.

- `desde(fuentes)`: un Dijkstra por fuente (scipy, en C). Da los mismos costos
  optimos que un A* por par y es mucho mas rapido para llenar la matriz D.
- `a_estrella(a, b)`: A* de un solo par con heuristica admisible d_euclid * w_min.
- `campo_retorno(h)`: Dijkstra inverso desde el habitat -> R(p) y siguiente celda.
"""
import heapq
import math

import numpy as np
from scipy.sparse import csr_matrix
from scipy.sparse.csgraph import dijkstra

from .fisica import pandolf, velocidad
from .terreno import Terreno

DIRS = ((-1, -1), (-1, 0), (-1, 1), (0, -1), (0, 1), (1, -1), (1, 0), (1, 1))
SIN_PRED = -9999


class Grafo:
    def __init__(self, terreno: Terreno, perfil=None, multiplicador=None, bloqueo=None):
        """`multiplicador`: array [filas, columnas] >= 1 sobre el costo de entrar a la celda.
        `bloqueo`: mascara booleana de celdas a las que no se puede entrar."""
        self.t = terreno
        F, C, tam = terreno.filas, terreno.columnas, terreno.tam
        z, eta = terreno.elevacion, terreno.eta
        bloq = terreno.peligro > 0
        if bloqueo is not None:
            bloq = bloq | bloqueo
        self.bloqueada = bloq

        idx = np.arange(F * C).reshape(F, C)
        origenes, destinos, costos, tiempos = [], [], [], []
        w_min = math.inf
        for di, dj in DIRS:
            dd = tam * math.hypot(di, dj)
            a = (slice(max(0, -di), F - max(0, di)), slice(max(0, -dj), C - max(0, dj)))
            b = (slice(max(0, di), F - max(0, -di)), slice(max(0, dj), C - max(0, -dj)))
            G = 100.0 * (z[b] - z[a]) / dd                 # pendiente firmada a -> b
            e = eta[b]
            costo = pandolf(G, e, perfil, dd)
            if multiplicador is not None:
                costo = costo * multiplicador[b]
            tiempo = dd / velocidad(G, e, perfil)
            ok = ~bloq[b]
            if ok.any():
                w_min = min(w_min, float((costo[ok] / dd).min()))
            origenes.append(idx[a][ok])
            destinos.append(idx[b][ok])
            costos.append(costo[ok])
            tiempos.append(tiempo[ok])

        n = F * C
        fil = np.concatenate(origenes)
        col = np.concatenate(destinos)
        self.csr = csr_matrix((np.concatenate(costos), (fil, col)), shape=(n, n))
        self.csr_t = self.csr.T.tocsr()
        self._tiempos = csr_matrix((np.concatenate(tiempos), (fil, col)), shape=(n, n))
        self.w_min = w_min if math.isfinite(w_min) else 0.0
        self._ady = None

    # --- caminos minimos ---
    def desde(self, fuentes):
        """dist[k, celda], pred[k, celda] desde cada fuente."""
        return dijkstra(self.csr, directed=True, indices=list(fuentes), return_predecessors=True)

    def campo_retorno(self, h: int):
        """R[celda] = O2 para ir de la celda a h; sig[celda] = siguiente celda hacia h."""
        return dijkstra(self.csr_t, directed=True, indices=h, return_predecessors=True)

    @staticmethod
    def camino(pred_fila, origen: int, destino: int):
        """Celdas origen..destino usando los predecesores de `desde`. None si no hay."""
        cam = [destino]
        c = destino
        while c != origen:
            c = int(pred_fila[c])
            if c == SIN_PRED:
                return None
            cam.append(c)
        cam.reverse()
        return cam

    @staticmethod
    def camino_retorno(sig, origen: int, h: int):
        """Celdas origen..h siguiendo el campo de retorno. None si no hay."""
        cam = [origen]
        c = origen
        while c != h:
            c = int(sig[c])
            if c == SIN_PRED:
                return None
            cam.append(c)
        return cam

    def tiempo_camino(self, cam) -> float:
        if len(cam) < 2:
            return 0.0
        return float(self._tiempos[cam[:-1], cam[1:]].sum())

    def a_estrella(self, origen: int, destino: int):
        """(costo_O2, camino) de un solo par. (inf, None) si no hay camino."""
        if self._ady is None:
            self._ady = (self.csr.indptr.tolist(), self.csr.indices.tolist(), self.csr.data.tolist())
        ptr, ind, dat = self._ady
        C, tam, w = self.t.columnas, self.t.tam, self.w_min
        di, dj = divmod(destino, C)

        def h(c):
            i, j = divmod(c, C)
            return math.hypot(i - di, j - dj) * tam * w

        g = {origen: 0.0}
        pred = {}
        cerrados = set()
        cola = [(h(origen), origen)]
        while cola:
            _, c = heapq.heappop(cola)
            if c in cerrados:
                continue
            if c == destino:
                cam = [c]
                while c != origen:
                    c = pred[c]
                    cam.append(c)
                return g[destino], cam[::-1]
            cerrados.add(c)
            gc = g[c]
            for k in range(ptr[c], ptr[c + 1]):
                v = ind[k]
                nuevo = gc + dat[k]
                if nuevo < g.get(v, math.inf):
                    g[v] = nuevo
                    pred[v] = c
                    heapq.heappush(cola, (nuevo + h(v), v))
        return math.inf, None
