"""CTOPTW de un agente: branch & bound en profundidad, anytime (CLAUDE.md §8.4-8.5).

Nodos: 0 = inicio, 1..n = sitios, n+1 = habitat. D en litros de O2, T en segundos.
Todos los tiempos son relativos al inicio del plan.
"""
import math
import time

from . import constantes as K

EPS = 1e-9


class _Tope(Exception):
    pass


def psi(n: int, alfa: float = K.ALFA) -> float:
    """Diversidad: n = muestras de la clase, incluida la actual."""
    return math.exp(-alfa * (n - 1))


def resolver(D, T, valor, mineral, masa, o2_muestreo, tau_s, ventana_s,
             o2_util, capacidad_kg, t_max, o2_espera_L_s,
             tope_s=K.TOPE_SOLVER_S, alfa=K.ALFA, lam=K.LAMBDA_RIESGO, riesgo=None):
    """Devuelve dict(orden, Z, O2, optimo, nodos). `orden` = indices de sitio (1..n).

    valor, mineral, masa, o2_muestreo, tau_s, ventana_s: listas indexadas 1..n
    (el indice 0 no se usa). ventana_s[j] = (e_j, l_j) en segundos.
    riesgo: matriz opcional r[i][j]; Z resta lam * r[i][j] por tramo (v1: lam = 0).
    """
    n = len(valor) - 1
    H = n + 1
    fin = time.perf_counter() + tope_s
    mejor = {"Z": -math.inf, "O2": math.inf, "orden": None}
    cuenta = {}
    ruta = []
    nodos = 0

    def dfs(i, o2, t, kg, Z, restantes):
        nonlocal nodos
        nodos += 1
        if nodos & 255 == 0 and time.perf_counter() > fin:
            raise _Tope

        # cerrar la ruta aqui
        o2_fin, t_fin = o2 + D[i][H], t + T[i][H]
        if o2_fin <= o2_util + EPS and t_fin <= t_max + EPS:
            Zc = Z - (lam * riesgo[i][H] if riesgo else 0.0)
            if Zc > mejor["Z"] + EPS or (abs(Zc - mejor["Z"]) <= EPS and o2_fin < mejor["O2"] - EPS):
                mejor.update(Z=Zc, O2=o2_fin, orden=list(ruta))

        cota = 0.0
        cands = []
        for j in restantes:
            if kg + masa[j] > capacidad_kg + EPS:
                continue
            base = o2 + D[i][j] + o2_muestreo[j]
            if base + D[j][H] > o2_util + EPS:        # no podria volver
                continue
            cota += valor[j]                          # psi = 1
            lleg = t + T[i][j]
            e, l = ventana_s[j]
            if lleg > l + EPS:                        # ventana cerrada
                continue
            espera = max(0.0, e - lleg)
            o2_j = base + espera * o2_espera_L_s
            t_j = lleg + espera + tau_s[j]
            if o2_j + D[j][H] > o2_util + EPS or t_j + T[j][H] > t_max + EPS:
                continue
            gan = valor[j] * psi(cuenta.get(mineral[j], 0) + 1, alfa)
            if riesgo:
                gan -= lam * riesgo[i][j]
            cands.append((-gan / (o2_j - o2 + EPS), j, gan, o2_j, t_j))
        if Z + cota <= mejor["Z"] + EPS:
            return
        cands.sort()
        for _, j, gan, o2_j, t_j in cands:
            cuenta[mineral[j]] = cuenta.get(mineral[j], 0) + 1
            ruta.append(j)
            dfs(j, o2_j, t_j, kg + masa[j], Z + gan, restantes - {j})
            ruta.pop()
            cuenta[mineral[j]] -= 1

    optimo = True
    try:
        dfs(0, 0.0, 0.0, 0.0, 0.0, frozenset(range(1, n + 1)))
    except _Tope:
        optimo = False
    return {"orden": mejor["orden"], "Z": mejor["Z"], "O2": mejor["O2"], "optimo": optimo, "nodos": nodos}
