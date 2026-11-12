"""Reproduce contratos/ejemplos/guion_demo.json contra el Motor con un astronauta simulado
minimo y SIN ruido (el simulador real es el de Dana, CLAUDE.md §10.4).

    python -m optimizador.pruebas.simular_guion

El astronauta sigue la polilinea del ultimo plan_actualizado / abortar interpolando con
llegada_s; consume Pandolf al caminar y 250 W al perforar o esperar.
"""
import json
import math
from pathlib import Path

from optimizador import Motor, potencia
from optimizador import constantes as K

RAIZ = Path(__file__).resolve().parents[2]
DT = 10.0
V_VUELTA = 0.6      # m/s en el tramo final y en el escape (el plan no trae la llegada a H)


class Astronauta:
    def __init__(self, motor, perfil):
        self.ter = motor.terreno
        a = perfil["astronauta"]
        self.astro, self.kappa = a, a["kappa_O2_L_W_min"]
        self.x, self.y = float(self.ter.habitat["x"]), float(self.ter.habitat["y"])
        self.o2, self.carga, self.t = float(a["O2_inicial_L"]), 0.0, 0.0
        self.tramos = []            # (t_ini, t_fin, puntos) ; puntos de 1 elemento = quieto
        self.recogidas = []         # (t_salida, masa_kg)
        self.vo2 = self.vel = 0.0
        self.en_casa = False

    def seguir(self, polilinea, paradas, t, masas):
        """Arma el horario a partir de un plan (o de una ruta de escape, sin paradas)."""
        self.tramos, self.recogidas = [], []
        k, t_ini = 0, t
        for p in paradas:
            fin = next(i for i in range(k, len(polilinea))
                       if abs(polilinea[i][0] - p["x"]) < 0.02 and abs(polilinea[i][1] - p["y"]) < 0.02)
            self.tramos.append((t_ini, p["llegada_s"], polilinea[k:fin + 1]))
            self.tramos.append((p["llegada_s"], p["salida_s"], [polilinea[fin]]))
            self.recogidas.append((p["salida_s"], masas.get(p["id"], 0.0)))
            k, t_ini = fin, p["salida_s"]
        resto = polilinea[k:]
        self.tramos.append((t_ini, t_ini + _largo(resto) / V_VUELTA, resto))

    def paso(self, t, fatiga):
        x0, y0 = self.x, self.y
        for t_ini, t_fin, pts in self.tramos:
            if t <= t_fin or pts is self.tramos[-1][2]:
                u = 1.0 if t_fin <= t_ini else min(1.0, max(0.0, (t - t_ini) / (t_fin - t_ini)))
                self.x, self.y = _punto(pts, u)
                self.en_casa = pts is self.tramos[-1][2] and u >= 1.0
                break
        dist = math.hypot(self.x - x0, self.y - y0)
        self.vel = dist / DT
        if self.vel > 0.05:
            G = 100.0 * (self.ter.z(self.x, self.y) - self.ter.z(x0, y0)) / dist
            i, j = self.ter.celda(self.x, self.y)
            M = float(potencia(G, self.ter.eta[i, j], self.astro))
        else:
            M = K.M_PERFORACION_W
        self.vo2 = M * self.kappa * fatiga
        self.o2 -= self.vo2 * DT / 60.0
        for ts, masa in self.recogidas:
            if t - DT < ts <= t:
                self.carga += masa
        self.t = t


def _largo(pts):
    return sum(math.hypot(b[0] - a[0], b[1] - a[1]) for a, b in zip(pts, pts[1:]))


def _punto(pts, u):
    if len(pts) == 1:
        return pts[0][0], pts[0][1]
    meta = u * _largo(pts)
    for a, b in zip(pts, pts[1:]):
        d = math.hypot(b[0] - a[0], b[1] - a[1])
        if meta <= d and d > 0:
            return a[0] + (b[0] - a[0]) * meta / d, a[1] + (b[1] - a[1]) * meta / d
        meta -= d
    return pts[-1][0], pts[-1][1]


def correr(guion=None, verboso=False):
    """Devuelve (mensajes sin estado_aborto, resumen final)."""
    guion = guion or json.loads((RAIZ / "contratos/ejemplos/guion_demo.json").read_text(encoding="utf-8"))
    perfil = guion["perfil"]
    motor = Motor(RAIZ / "terreno")
    motor.cargar_perfil(perfil)
    masas = {s["id"]: s["masa_kg"] for s in motor.terreno.sitios}
    ast = Astronauta(motor, perfil)
    pendientes = sorted(guion["eventos"], key=lambda e: e["t"])
    fat = guion.get("fatiga")
    seq, registro, margen_min, t = 0, [], math.inf, 0.0

    def enviar(tipo, datos):
        nonlocal seq, margen_min
        seq += 1
        ev = {"version": "1.0", "t": t, "hora_solar": perfil["t0_hora_solar"] + t / K.SEG_POR_HORA_SOLAR,
              "seq": seq, "tipo": tipo, "datos": datos}
        for m in motor.procesar_evento(ev):
            if m["tipo"] == "estado_aborto":
                if m["R_L"] > 0.05:
                    margen_min = min(margen_min, m["margen_pct"])
                continue
            registro.append(m)
            if m["tipo"] == "plan_actualizado":
                ast.seguir(m["plan"]["polilinea"], m["plan"]["paradas"], t, masas)
            else:
                ast.seguir(m["ruta_escape"], [], t, masas)
            if verboso:
                p = m.get("plan", {})
                print(f"t={t:6.0f} s (min {t / 60:4.1f})  {m['tipo']:16s} {m['motivo']:14s} "
                      + (f"orden={p['orden']} O2_total={p['O2_total_L']} Z={p['ciencia_Z']}" if p
                         else f"O2_previsto={m['O2_previsto_L']}"))

    while t <= perfil["duracion_eva_s"]:
        if t > 0:
            f = fat["factor"] if fat and fat["t_ini"] < t <= fat["t_fin"] else 1.0
            ast.paso(t, f)
        enviar("telemetria_astronauta", {
            "x": round(ast.x, 2), "y": round(ast.y, 2), "sigma_m": 0, "O2_restante_L": round(ast.o2, 4),
            "VO2_L_min": round(ast.vo2, 4), "FC_lpm": round(min(190, max(60, 70 + 55 * ast.vo2))),
            "velocidad_m_s": round(ast.vel, 3), "carga_kg": round(ast.carga, 2)})
        while pendientes and pendientes[0]["t"] <= t:
            e = pendientes.pop(0)
            enviar(e["tipo"], e["datos"])
        if ast.en_casa and not pendientes:
            break
        t += DT
    resumen = {"t_llegada_s": t, "O2_final_L": round(ast.o2, 2), "carga_kg": round(ast.carga, 2),
               "margen_min_pct": margen_min, "visitados": motor.estado()["visitados"]}
    if verboso:
        print("fin:", resumen)
    return registro, resumen


if __name__ == "__main__":
    correr(verboso=True)
