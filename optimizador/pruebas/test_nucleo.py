"""Pruebas del optimizador sobre el terreno REAL de terreno/.

    python -m optimizador.pruebas.test_nucleo        (tambien las recoge pytest)

No dependen de coordenadas fijas: leen el habitat y los sitios del paquete de terreno.
"""
import copy
import functools
import json
import math
import shutil
import sys
import tempfile
import time
from pathlib import Path

from optimizador import Motor, pandolf
from optimizador import constantes as K
from optimizador.solver import psi

RAIZ = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(RAIZ))

# Perfil con las constantes del contrato (40 L). El guion de mision usa su propio perfil (170 L).
PERFIL = {"version": "1.0", "tipo": "perfil", "escenario_id": "prueba-01", "semilla": 42,
          "t0_hora_solar": 10.0, "factor_tiempo": 30, "duracion_eva_s": 14400,
          "astronauta": {"masa_kg": 80, "masa_traje_kg": 150, "v0_m_s": 1.2,
                         "kappa_O2_L_W_min": 0.00298, "O2_inicial_L": 40, "capacidad_muestras_kg": 5}}


def _motor(terreno=None):
    m = Motor(terreno or RAIZ / "terreno")
    m.cargar_perfil(PERFIL)
    return m


def _hab(m):
    return float(m.terreno.habitat["x"]), float(m.terreno.habitat["y"])


def _pedido():
    return json.loads((RAIZ / "contratos/ejemplos/pedido.json").read_text(encoding="utf-8"))


def _tele(t, seq, x, y, o2, vo2=0.65, vel=0.85, carga=0.0):
    return {"version": "1.0", "t": t, "hora_solar": 10 + t / 3699, "seq": seq,
            "tipo": "estado_astronauta",
            "datos": {"x": x, "y": y, "sigma_m": 0, "O2_restante_L": o2, "VO2_L_min": vo2,
                      "FC_lpm": 105, "velocidad_m_s": vel, "carga_kg": carga}}


def _ev(t, seq, tipo, datos):
    return {"version": "1.0", "t": t, "hora_solar": 10 + t / 3699, "seq": seq, "tipo": tipo, "datos": datos}


@functools.lru_cache(maxsize=None)
def _mision():
    """Una corrida completa del guion de mision (se reutiliza entre pruebas)."""
    from optimizador.pruebas.simular_guion import simular
    g = json.loads((RAIZ / "contratos/ejemplos/guion_mision.json").read_text(encoding="utf-8"))
    return simular(g)


def test_pandolf():
    assert pandolf(10, 1.0) > pandolf(0, 1.0) > 0            # subir cuesta mas
    assert pandolf(10, 1.0) != pandolf(-10, 1.0)             # asimetrico
    assert pandolf(0, 2.0) > pandolf(0, 1.0)                 # terreno rugoso cuesta mas
    assert abs(250 * 6 * 0.00298 - 4.47) < 1e-9              # muestreo de 6 min


def test_terreno_real():
    ter = _motor().terreno
    m = ter.manifest
    assert "SINTETICO" not in m["sitio"].upper() and "USGS" in m["fuente_dem"]
    assert ter.elevacion.shape == (m["filas"], m["columnas"]) and 1.0 <= ter.eta.min() and ter.eta.max() <= 2.0
    assert 0 < ter.peligro.mean() < 0.2                      # hay bloqueos reales, pero el terreno es transitable
    assert 1 <= len(ter.sitios) <= K.N_MAX_SITIOS and len({s["mineral"] for s in ter.sitios}) >= 2
    for s in ter.sitios:                                     # ningun sitio ni el habitat sobre una celda bloqueada
        i, j = ter.celda(s["x"], s["y"])
        assert ter.peligro[i, j] == 0 and "CRISM" in s["fuente"]
    i, j = ter.celda(*[ter.habitat[k] for k in ("x", "y")])
    assert ter.peligro[i, j] == 0


def test_a_estrella_igual_a_dijkstra():
    m = _motor()
    g, ter = m._grafo, m.terreno
    dist, _ = g.desde([m._h])
    for s in ter.sitios[:3]:
        c = ter.indice(s["x"], s["y"])
        costo, cam = g.a_estrella(m._h, c)
        assert abs(costo - dist[0, c]) < 1e-9 and cam[0] == m._h and cam[-1] == c
        vuelta, _ = g.a_estrella(c, m._h)
        assert abs(vuelta - m._R[c]) < 1e-9                  # campo de retorno
        assert abs(vuelta - costo) > 1e-9                    # D[i][j] != D[j][i]


def test_plan_de_ejemplo():
    m, p = _motor(), _pedido()
    hab = [round(v, 2) for v in _hab(m)]
    t = time.perf_counter()
    r = m.planificar(p)
    assert time.perf_counter() - t < 2.0
    assert r["factible"] and r["orden"][0] == "H" and r["orden"][-1] == "H"
    assert r["O2_total_L"] <= p["O2_disponible_L"] * (1 - K.RHO) + 1e-6
    assert abs(r["O2_reserva_L"] - K.RHO * p["O2_disponible_L"]) < 1e-6
    sitios = {s["id"]: s for s in p["sitios"]}
    assert sum(sitios[i]["masa_kg"] for i in r["orden"][1:-1]) <= p["capacidad_kg"] + 1e-9
    cuenta, Z = {}, 0.0
    for par in r["paradas"]:                                 # ciencia recalculada con psi; ventanas y tiempos
        s = sitios[par["id"]]
        cuenta[s["mineral"]] = cuenta.get(s["mineral"], 0) + 1
        Z += s["valor"] * psi(cuenta[s["mineral"]])
        hora = p["hora_solar"] + par["llegada_s"] / 3699
        assert s["ventana"][0] - 1e-6 <= hora <= s["ventana"][1] + 1e-6
        assert abs(par["salida_s"] - par["llegada_s"] - 60 * s["perforacion_min"]) < 0.2
    assert abs(Z - r["ciencia_Z"]) < 1e-2
    assert r["polilinea"][0] == hab and r["polilinea"][-1] == hab
    # la ruta nunca pisa una celda bloqueada del terreno real
    ter = m.terreno
    assert all(ter.peligro[ter.celda(x, y)] == 0 for x, y in r["polilinea"])
    assert r["ruta_escape"] and m.como_mensaje(r)["motivo"] == "pedido"
    return r


def test_sin_o2():
    m, p = _motor(), _pedido()
    p["O2_disponible_L"] = 2.0
    r = m.planificar(p)
    assert not r["factible"] and r["orden"] == ["H", "H"] and r["paradas"] == []
    assert len(r["polilinea"]) >= 1 and r["ruta_escape"]


def _guion(m):
    """Mini guion: estado del astronauta, peligro sobre la ruta, ventana, SPE alerta y critico."""
    sal = []
    hx, hy = _hab(m)
    sal += m.procesar_evento(_tele(0, 1, hx, hy, 40.0))
    plan = sal[-1]["plan"]
    pol = plan["polilinea"]
    medio = pol[len(pol) // 3]
    sal += m.procesar_evento(_ev(10, 2, "peligro", {"id": "p1", "forma": "circulo", "x": medio[0],
                                                    "y": medio[1], "radio_m": 6, "efecto": "bloqueo", "factor": 1}))
    ultimo = sal[-1]["plan"]["paradas"][-1]["id"]
    sal += m.procesar_evento(_ev(20, 3, "ventanas", {"sitios": [{"id": ultimo, "ventana": [9.0, 9.5]}]}))
    sal += m.procesar_evento(_ev(30, 4, "SPE", {"nivel": "alerta", "llegada_s": 600}))
    sal += m.procesar_evento(_ev(40, 5, "tipo_desconocido", {"x": 1}))        # se ignora: lista vacia
    sal += m.procesar_evento(_ev(50, 6, "SPE", {"nivel": "critico", "llegada_s": 0}))
    sal += m.procesar_evento(_tele(60, 7, hx, hy, 39.0))
    sal += m.procesar_evento(_ev(70, 8, "SPE", {"nivel": "alerta", "llegada_s": 600}))
    return sal, medio, ultimo


def test_eventos():
    m = _motor()
    sal, medio, ultimo = _guion(m)
    tipos = [(s["tipo"], s.get("motivo")) for s in sal]
    assert tipos == [("estado_aborto", None), ("plan_actualizado", "inicial"),
                     ("plan_actualizado", "peligro"), ("plan_actualizado", "ventana"),
                     ("plan_actualizado", "spe_alerta"), ("abortar", "spe_critico"),
                     ("estado_aborto", None)], tipos
    rodeo = sal[2]["plan"]["polilinea"]
    assert all(math.hypot(x - medio[0], y - medio[1]) > 4.0 for x, y in rodeo)   # rodea el bloqueo
    assert ultimo not in sal[3]["plan"]["orden"]                                  # ventana cerrada
    assert sal[4]["plan"]["O2_reserva_L"] == 10.0                                 # rho = 0,25 de 40 L
    assert sal[4]["plan"]["O2_total_L"] <= 30.0 + 1e-6
    assert sal[5]["ruta_escape"] and sal[5]["destino"]["tipo"] == "habitat" and m.estado()["abortado"]


def test_refugio_en_spe_critico():
    """El terreno real no tiene depresiones de refugio: se prueba con una copia a la que se le anade una."""
    base = _motor().terreno
    s = base.sitios[0]
    with tempfile.TemporaryDirectory() as tmp:
        copia = Path(tmp) / "terreno"
        shutil.copytree(RAIZ / "terreno", copia)
        man = json.loads((copia / "manifest.json").read_text(encoding="utf-8"))
        man["refugios"] = [{"id": "r1", "x": s["x"], "y": s["y"], "radio_m": 10.0, "profundidad_m": 2.0}]
        (copia / "manifest.json").write_text(json.dumps(man), encoding="utf-8")
        m = _motor(copia)
        m.procesar_evento(_tele(0, 1, *_hab(m), 40.0))
        m.procesar_evento(_tele(10, 2, s["x"] + 5.0, s["y"], 39.0))
        ab = m.procesar_evento(_ev(20, 3, "SPE", {"nivel": "critico", "llegada_s": 0}))[0]
        assert ab["destino"] == {"tipo": "refugio", "id": "r1", "x": s["x"], "y": s["y"]}
        assert ab["ruta_escape"][-1] == [s["x"], s["y"]] and ab["O2_previsto_L"] > 38.0


def test_no_retorno_y_recalibracion():
    m = _motor()
    hx, hy = _hab(m)
    s = max(m.terreno.sitios, key=lambda q: float(m._R[m.terreno.indice(q["x"], q["y"])]))   # el mas caro de volver
    m.procesar_evento(_tele(0, 1, hx, hy, 40.0))
    R = float(m._R[m.terreno.indice(s["x"], s["y"])])
    sal = m.procesar_evento(_tele(10, 2, s["x"], s["y"], R * 1.10))
    assert [x["tipo"] for x in sal] == ["estado_aborto", "abortar"] and sal[1]["motivo"] == "no_retorno"
    assert sal[0]["margen_pct"] <= 15 and abs(sal[0]["O2_minimo_L"] - 1.15 * sal[0]["R_L"]) < 2e-3

    m = _motor()
    m.procesar_evento(_tele(0, 1, hx, hy, 40.0))
    kappa = m.estado()["kappa_O2_L_W_min"]
    motivos = []
    for k in range(1, 12):                                   # parado, VO2 x1,3 del previsto
        for x in m.procesar_evento(_tele(10 * k, k + 1, hx, hy, 40 - 0.15 * k,
                                         vo2=1.3 * 250 * kappa, vel=0.0)):
            if x["tipo"] == "plan_actualizado":
                motivos.append((10 * k, x["motivo"]))
    # 60 s completos de desvio (t = 10..70) y una sola vez: enfriamiento de 300 s
    assert motivos == [(70, "recalibracion")], motivos
    assert abs(m.estado()["kappa_O2_L_W_min"] / kappa - 1.3) < 1e-6


def test_determinismo_y_latencia():
    def limpio(sal):
        sal = copy.deepcopy(sal)
        for s in sal:
            s.get("plan", {}).pop("tiempo_calculo_ms", None)
        return json.dumps(sal, sort_keys=True)
    assert limpio(_guion(_motor())[0]) == limpio(_guion(_motor())[0])

    m = _motor()
    hx, hy = _hab(m)
    m.procesar_evento(_tele(0, 1, hx, hy, 40.0))
    t = time.perf_counter()
    for k in range(1, 201):
        m.procesar_evento(_tele(10 * k, k + 1, hx + 0.05 * k, hy, 40.0 - 0.01 * k, vo2=0.66))
    ms = 1000 * (time.perf_counter() - t) / 200
    assert ms < 5.0, ms
    return ms


def test_mision_completa():
    log, marcas, fin = _mision()
    sal = [m for m in log if m["tipo"] in ("plan_actualizado", "abortar")]
    assert [m["motivo"] for m in sal] == ["inicial", "peligro", "ventana", "recalibracion", "peligro",
                                          "spe_alerta", "spe_critico"], [m["motivo"] for m in sal]
    assert all(m["plan"]["tiempo_calculo_ms"] < 2000 for m in sal if "plan" in m)
    p1 = next(m for m in log if m["tipo"] == "peligro")["datos"]
    assert all(math.hypot(x - p1["x"], y - p1["y"]) > p1["radio_m"] for x, y in sal[1]["plan"]["polilinea"])
    o2_alerta = [m for m in log if m["tipo"] == "estado_astronauta" and m["t"] == sal[5]["t"]][0]["datos"]["O2_restante_L"]
    assert abs(sal[5]["plan"]["O2_reserva_L"] - 0.25 * o2_alerta) < 0.01      # rho = 0,25 sobre el O2 restante
    ab = sal[-1]
    assert ab["ruta_escape"][-1] == [ab["destino"]["x"], ab["destino"]["y"]]
    assert fin["muestras"] >= 6 and fin["O2_final_L"] > 6.0 and fin["margen_min_pct"] > 15
    assert len({m["mineral"] for m in marcas if m["clase"] == "muestra"}) >= 2   # diversidad real de minerales
    assert [m["t"] for m in log] == sorted(m["t"] for m in log)                # el visor depende de este orden
    assert sum(m["clase"] == "muestra" for m in marcas) == fin["muestras"]
    assert all(0 <= m["linea"] < len(log) for m in marcas)
    # el astronauta nunca pisa una celda bloqueada
    ter = _motor().terreno
    assert all(ter.peligro[ter.celda(m["datos"]["x"], m["datos"]["y"])] == 0
               for m in log if m["tipo"] == "estado_astronauta")


def test_mision_determinista():
    from optimizador.pruebas.simular_guion import simular
    g = json.loads((RAIZ / "contratos/ejemplos/guion_mision.json").read_text(encoding="utf-8"))
    quitar = lambda r: json.dumps([{k: v for k, v in (m.get("plan") or m).items() if k != "tiempo_calculo_ms"}
                                   for m in r], sort_keys=True)
    assert quitar(_mision()[0]) == quitar(simular(g)[0])


def test_esquemas():
    from contratos.validar import validar_jsonl, validar_mensaje, validar_terreno
    log = _mision()[0]
    # 1) todo lo que produce el sistema valida
    assert all(not validar_mensaje(m) for m in log), [validar_mensaje(m) for m in log if validar_mensaje(m)][:2]
    assert not validar_mensaje(_pedido()) and not validar_mensaje(PERFIL)
    assert not validar_terreno(RAIZ / "terreno")
    for f in sorted((RAIZ / "logs").glob("*.jsonl")):
        _, _, malos, desorden = validar_jsonl(f)
        assert malos == 0 and desorden == 0, f
    # 2) los esquemas rechazan lo incorrecto
    plan = next(m for m in log if m["tipo"] == "plan_actualizado")
    tele = next(m for m in log if m["tipo"] == "estado_astronauta")

    def roto(m, ruta, valor):
        m = copy.deepcopy(m)
        d = m
        for k in ruta[:-1]:
            d = d[k]
        if valor is KeyError:
            del d[ruta[-1]]
        else:
            d[ruta[-1]] = valor
        return validar_mensaje(m)
    assert roto(plan, ["motivo"], "inventado")
    assert roto(plan, ["plan", "orden"], ["H"])
    assert roto(plan, ["plan", "tiempo_calculo_ms"], 2500)
    assert roto(plan, ["version"], "2.0")
    assert roto(tele, ["datos", "O2_restante_L"], "mucho")
    assert roto(tele, ["datos", "x"], KeyError)
    assert roto(tele, ["seq"], 0)
    assert not validar_mensaje({"version": "1.0", "tipo": "tipo_futuro", "t": 1})          # tipo desconocido: se ignora
    assert validar_mensaje({"version": "1.0", "tipo": "SPE", "t": 1, "hora_solar": 10, "seq": 1, "datos": {"nivel": "grave", "llegada_s": 1}})
    # 3) mensajes de transporte propuestos
    assert not validar_mensaje({"version": "1.0", "tipo": "control", "accion": "saltar", "t": 600})
    assert validar_mensaje({"version": "1.0", "tipo": "control", "accion": "saltar"})
    assert not validar_mensaje({"version": "1.0", "tipo": "reinicio", "t": 600, "motivo": "saltar"})
    assert not validar_mensaje({"version": "1.0", "tipo": "error", "codigo": "sin_perfil", "detalle": "falta perfil"})


if __name__ == "__main__":
    for nombre, f in list(globals().items()):
        if nombre.startswith("test_"):
            t0 = time.perf_counter()
            r = f()
            print(f"ok  {nombre}  ({time.perf_counter() - t0:.1f} s)" + (f"  [{r:.3f} ms por estado_astronauta]" if isinstance(r, float) else ""))
