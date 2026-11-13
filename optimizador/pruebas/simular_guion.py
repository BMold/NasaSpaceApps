"""Reproduce un guion (contratos/ejemplos/guion_*.json) contra el Motor con un astronauta
simulado minimo y SIN ruido (el simulador real es el de Dana, CLAUDE.md §10.4).

    python -m optimizador.pruebas.simular_guion [guion_mision.json]

El astronauta sigue la polilinea del ultimo plan_actualizado / abortar interpolando con
llegada_s; consume Pandolf al caminar y 250 W al perforar o esperar.

Formato del guion (campos extra respecto al contrato, solo para esta herramienta):
    terreno          carpeta del terreno (por defecto "terreno")
    fatiga           {t_ini, t_fin, factor} o una lista de ellos: multiplica el VO2 medido
    eventos[]        {t, tipo, datos, titulo?, detalle?, sobre_ruta_m?, sitio_en_plan?, cierra_en_min?}
        sobre_ruta_m   (peligro) coloca el circulo a esa distancia por delante, sobre la ruta vigente
        sitio_en_plan  (ventanas) k-esimo sitio pendiente del plan; su ventana se cierra en
                       `cierra_en_min` minutos simulados (antes de que llegue)

Salida del registro (una linea JSON por mensaje, en orden): eventos de entrada, estado_aborto,
plan_actualizado, abortar y `hito` (auxiliar de la simulacion; tipo desconocido = se ignora).
"""
import json
import math
import sys
from pathlib import Path

from optimizador import Motor, potencia
from optimizador import constantes as K
from optimizador.rutas import desde_mas_cercano

RAIZ = Path(__file__).resolve().parents[2]
DT = 10.0
V_VUELTA = 0.6      # m/s en el tramo final y en el escape (el plan no trae la llegada a H)

TITULOS = {
    "recalibracion": ("Fatiga detectada", "VO2 medido muy por encima del previsto: se recalibra kappa y se replanifica."),
    "peligro": ("Peligro en la ruta", "Se replanifica rodeando la zona."),
    "ventana": ("Ventana cerrada", "Un sitio del plan quedo fuera de su ventana."),
    "spe_alerta": ("Alerta de tormenta solar", "Reserva de aborto al 25 % y plan recortado."),
    "spe_critico": ("Tormenta solar critica", "Aborto: ruta de escape."),
    "no_retorno": ("Punto de no retorno", "Margen de O2 agotado: vuelta inmediata."),
}


class Astronauta:
    def __init__(self, motor, perfil):
        self.ter = motor.terreno
        a = perfil["astronauta"]
        self.astro, self.kappa = a, a["kappa_O2_L_W_min"]
        self.x, self.y = float(self.ter.habitat["x"]), float(self.ter.habitat["y"])
        self.o2, self.carga, self.t = float(a["O2_inicial_L"]), 0.0, 0.0
        self.tramos = []            # (t_ini, t_fin, puntos) ; puntos de 1 elemento = quieto
        self.hitos = []             # (t, clase, id_sitio) del plan vigente
        self.llegadas, self.hechos = set(), set()
        self.masas = {s["id"]: s["masa_kg"] for s in self.ter.sitios}
        self.vo2 = self.vel = 0.0
        self.en_casa = False

    def seguir(self, polilinea, paradas, t):
        """Arma el horario a partir de un plan (o de una ruta de escape, sin paradas)."""
        self.tramos, self.hitos = [], []
        k, t_ini = 0, t
        for p in paradas:
            fin = next(i for i in range(k, len(polilinea))
                       if abs(polilinea[i][0] - p["x"]) < 0.02 and abs(polilinea[i][1] - p["y"]) < 0.02)
            self.tramos.append((t_ini, p["llegada_s"], polilinea[k:fin + 1]))
            self.tramos.append((p["llegada_s"], p["salida_s"], [polilinea[fin]]))
            self.hitos += [(p["llegada_s"], "llegada", p["id"]), (p["salida_s"], "muestra", p["id"])]
            k, t_ini = fin, p["salida_s"]
        resto = polilinea[k:]
        self.tramos.append((t_ini, t_ini + _largo(resto) / V_VUELTA, resto))

    def paso(self, t, fatiga):
        """Avanza hasta `t`. Devuelve los hitos (t, clase, id) cumplidos en (t - DT, t]."""
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
        cumplidos = []
        for ts, clase, sid in sorted(self.hitos):
            if not t - DT < ts <= t:
                continue
            if clase == "llegada" and sid not in self.llegadas:
                self.llegadas.add(sid)
                cumplidos.append((ts, clase, sid))
            if clase == "muestra" and sid not in self.hechos:
                self.hechos.add(sid)
                self.carga += self.masas.get(sid, 0.0)
                cumplidos.append((ts, clase, sid))
        self.t = t
        return cumplidos


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


def _adelante(polilinea, x, y, d):
    """Punto a `d` metros por delante de (x, y) siguiendo la polilinea vigente."""
    pts = [(x, y)] + [tuple(p) for p in desde_mas_cercano(polilinea, x, y)]
    for a, b in zip(pts, pts[1:]):
        l = math.hypot(b[0] - a[0], b[1] - a[1])
        if l > 0 and d <= l:
            return a[0] + (b[0] - a[0]) * d / l, a[1] + (b[1] - a[1]) * d / l
        d -= l
    return pts[-1]


def simular(guion=None, verboso=False):
    """Devuelve (log, marcadores, resumen). `log` lleva cada mensaje en orden."""
    guion = guion or json.loads((RAIZ / "contratos/ejemplos/guion_mision.json").read_text(encoding="utf-8"))
    perfil = guion["perfil"]
    motor = Motor(RAIZ / guion.get("terreno", "terreno"))
    motor.cargar_perfil(perfil)
    sitios = {s["id"]: s for s in motor.terreno.sitios}
    ast = Astronauta(motor, perfil)
    pendientes = sorted(guion["eventos"], key=lambda e: e["t"])
    fat = guion.get("fatiga") or []
    fat = [fat] if isinstance(fat, dict) else fat
    log, marcas = [], []
    estado = {"seq": 0, "t": 0.0, "margen_min": math.inf, "destino": None, "recogidas": 0}
    t0h = perfil["t0_hora_solar"]
    total_plan = len(sitios)

    def marca(t, clase, titulo, detalle, linea, nivel=1, **extra):
        marcas.append({"id": f"m{len(marcas) + 1:02d}", "t": t, "min": round(t / 60.0, 1), "clase": clase,
                       "titulo": titulo, "detalle": detalle, "linea": linea, "nivel": nivel, **extra})

    def enviar(tipo, datos, spec=None):
        estado["seq"] += 1
        t = estado["t"]
        ev = {"version": "1.0", "t": t, "hora_solar": round(t0h + t / K.SEG_POR_HORA_SOLAR, 4),
              "seq": estado["seq"], "tipo": tipo, "datos": datos}
        linea_ev = len(log)
        log.append(ev)
        salidas = motor.procesar_evento(ev)
        con_titulo = bool(spec and spec.get("titulo"))
        reaccion = None
        for m in salidas:
            log.append(m)
            if m["tipo"] == "estado_aborto":
                if m["R_L"] > 0.05:
                    estado["margen_min"] = min(estado["margen_min"], m["margen_pct"])
                continue
            reaccion = reaccion or m["motivo"]
            if m["tipo"] == "plan_actualizado":
                ast.seguir(m["plan"]["polilinea"], m["plan"]["paradas"], t)
            else:
                ast.seguir(m["ruta_escape"], [], t)
                estado["destino"] = m["destino"]
            if not con_titulo and m["motivo"] in TITULOS and m["motivo"] != "inicial":
                tit, det = TITULOS[m["motivo"]]
                marca(t, m["motivo"], tit, det, len(log) - 1)
            if verboso:
                p = m.get("plan", {})
                print(f"t={t:6.0f} s (min {t / 60:5.1f})  {m['tipo']:16s} {m['motivo']:14s} "
                      + (f"orden={p['orden']} O2_total={p['O2_total_L']} Z={p['ciencia_Z']} "
                         f"({p['tiempo_calculo_ms']} ms, optimo={p['optimo']})" if p
                         else f"destino={m['destino']['id']} O2_previsto={m['O2_previsto_L']}"))
        if con_titulo:
            marca(t, spec.get("clase", tipo), spec["titulo"], spec.get("detalle", ""), linea_ev,
                  reaccion=reaccion)
        return salidas

    def preparar(e):
        d = dict(e.get("datos", {}))
        if e["tipo"] == "peligro" and "sobre_ruta_m" in e:
            plan = motor.estado()["plan"]
            px, py = _adelante(plan["polilinea"], ast.x, ast.y, e["sobre_ruta_m"])
            d.update(x=round(px, 1), y=round(py, 1))
            d.setdefault("forma", "circulo")
            d.setdefault("factor", 1)
        if e["tipo"] == "ventanas" and "sitio_en_plan" in e:
            est = motor.estado()
            cierra = float(e.get("cierra_en_min", 5))
            cand = [p for p in est["plan"]["paradas"] if p["id"] not in est["visitados"]
                    and p["llegada_s"] > estado["t"] + 60 * cierra + 600]
            if cand:
                p = cand[min(e["sitio_en_plan"], len(cand) - 1)]
                fin = t0h + (estado["t"] + 60 * cierra) / K.SEG_POR_HORA_SOLAR
                d["sitios"] = [{"id": p["id"], "ventana": [sitios[p["id"]]["ventana"][0], round(fin, 3)]}]
                e["_sitio"] = p["id"]
            else:
                d["sitios"] = []
        return d

    t, marca_inicio, destino_hecho = 0.0, True, False
    while t <= perfil["duracion_eva_s"]:
        estado["t"] = t
        if t > 0:
            f = next((x["factor"] for x in fat if x["t_ini"] < t <= x["t_fin"]), 1.0)
            for ts, clase, sid in ast.paso(t, f):
                s = sitios[sid]
                if clase == "llegada":
                    log.append({"version": "1.0", "tipo": "hito", "t": round(ts, 1), "clase": "llegada",
                                "sitio_id": sid, "mineral": s["mineral"]})
                    marca(ts, "llegada", f"Llega al sitio {sid}",
                          f"{s['mineral']}, valor {s['valor']}, perforacion {s['perforacion_min']} min.",
                          len(log) - 1, nivel=2, sitio_id=sid)
                else:
                    estado["recogidas"] += 1
                    log.append({"version": "1.0", "tipo": "hito", "t": round(ts, 1), "clase": "muestra",
                                "sitio_id": sid, "mineral": s["mineral"], "masa_kg": s["masa_kg"],
                                "n_muestras": estado["recogidas"], "carga_kg": round(ast.carga, 2)})
                    marca(ts, "muestra", f"Muestra {estado['recogidas']}: {s['mineral']} (sitio {sid})",
                          f"Valor {s['valor']}, {s['masa_kg']} kg. Carga acumulada {ast.carga:.2f} kg.",
                          len(log) - 1, sitio_id=sid, mineral=s["mineral"])
        if marca_inicio:
            marca(0.0, "inicio", "Salida del habitat", "Plan inicial calculado por el optimizador.", 0)
            marca_inicio = False
        enviar("telemetria_astronauta", {
            "x": round(ast.x, 2), "y": round(ast.y, 2), "sigma_m": 0, "O2_restante_L": round(ast.o2, 4),
            "VO2_L_min": round(ast.vo2, 4), "FC_lpm": round(min(190, max(60, 70 + 55 * ast.vo2))),
            "velocidad_m_s": round(ast.vel, 3), "carga_kg": round(ast.carga, 2)})
        while pendientes and pendientes[0]["t"] <= t:
            e = pendientes.pop(0)
            enviar(e["tipo"], preparar(e), e)
        if ast.en_casa and not pendientes:
            d = estado["destino"] or {"tipo": "habitat", "id": "H"}
            log.append({"version": "1.0", "tipo": "hito", "t": t, "clase": "fin", "destino": d,
                        "O2_restante_L": round(ast.o2, 2)})
            if d["tipo"] == "refugio":
                marca(t, "fin", f"A salvo en el crater {d['id']}",
                      f"Resguardado con {ast.o2:.1f} L de O2 restantes.", len(log) - 1)
            else:
                marca(t, "fin", "Regreso al habitat", f"Mision completa con {ast.o2:.1f} L de O2 restantes.",
                      len(log) - 1)
            break
        t += DT
    marcas.sort(key=lambda m: (m["t"], m["linea"]))
    for i, m in enumerate(marcas, 1):
        m["id"] = f"m{i:02d}"
    resumen = {"t_fin_s": t, "O2_final_L": round(ast.o2, 2), "carga_kg": round(ast.carga, 2),
               "margen_min_pct": estado["margen_min"], "muestras": estado["recogidas"],
               "visitados": motor.estado()["visitados"], "destino": estado["destino"]}
    if verboso:
        print("fin:", resumen)
    return log, marcas, resumen


def correr(guion=None, verboso=False):
    """Compatibilidad: (mensajes plan_actualizado/abortar, resumen)."""
    log, _, resumen = simular(guion, verboso)
    return [m for m in log if m["tipo"] in ("plan_actualizado", "abortar")], resumen


if __name__ == "__main__":
    nombre = sys.argv[1] if len(sys.argv) > 1 else "guion_mision.json"
    simular(json.loads((RAIZ / "contratos/ejemplos" / nombre).read_text(encoding="utf-8")), verboso=True)
