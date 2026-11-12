"""Pruebas del nucleo. Sin dependencias: `python -m optimizador.pruebas.test_nucleo`
(tambien las recoge pytest). Requiere haber corrido generate_mocks.py."""
import copy
import json
import math
import time
from pathlib import Path

from optimizador import Motor, pandolf
from optimizador import constantes as K
from optimizador.solver import psi

RAIZ = Path(__file__).resolve().parents[2]
PERFIL = {"version": "1.0", "tipo": "perfil", "escenario_id": "demo-01", "semilla": 42,
          "t0_hora_solar": 10.0, "factor_tiempo": 30, "duracion_eva_s": 14400,
          "astronauta": {"masa_kg": 80, "masa_traje_kg": 150, "v0_m_s": 1.2,
                         "kappa_O2_L_W_min": 0.00298, "O2_inicial_L": 40, "capacidad_muestras_kg": 5},
          "rover": {"v_m_s": 0.8, "R_comm_m": 150}}


def _motor():
    m = Motor(RAIZ / "terreno")
    m.cargar_perfil(PERFIL)
    return m


def _pedido():
    return json.loads((RAIZ / "contratos/ejemplos/pedido.json").read_text(encoding="utf-8"))


def _tele(t, seq, x, y, o2, vo2=0.65, vel=0.85, carga=0.0):
    return {"version": "1.0", "t": t, "hora_solar": 10 + t / 3699, "seq": seq,
            "tipo": "telemetria_astronauta",
            "datos": {"x": x, "y": y, "sigma_m": 0, "O2_restante_L": o2, "VO2_L_min": vo2,
                      "FC_lpm": 105, "velocidad_m_s": vel, "carga_kg": carga}}


def _ev(t, seq, tipo, datos):
    return {"version": "1.0", "t": t, "hora_solar": 10 + t / 3699, "seq": seq, "tipo": tipo, "datos": datos}


def test_pandolf():
    assert pandolf(10, 1.0) > pandolf(0, 1.0) > 0            # subir cuesta mas
    assert pandolf(10, 1.0) != pandolf(-10, 1.0)             # asimetrico
    assert pandolf(0, 2.0) > pandolf(0, 1.0)                 # terreno rugoso cuesta mas
    assert abs(250 * 6 * 0.00298 - 4.47) < 1e-9              # muestreo de 6 min


def test_a_estrella_igual_a_dijkstra():
    m = _motor()
    g, ter = m._grafo, m.terreno
    for s in ter.sitios[:4]:
        c = ter.indice(s["x"], s["y"])
        dist, _ = g.desde([m._h])
        costo, cam = g.a_estrella(m._h, c)
        assert abs(costo - dist[0, c]) < 1e-9 and cam[0] == m._h and cam[-1] == c
        vuelta, _ = g.a_estrella(c, m._h)
        assert abs(vuelta - m._R[c]) < 1e-9                  # campo de retorno
        assert abs(vuelta - costo) > 1e-9                    # D[i][j] != D[j][i]


def test_plan_de_ejemplo():
    m, p = _motor(), _pedido()
    t = time.perf_counter()
    r = m.planificar(p)
    assert time.perf_counter() - t < 2.0
    assert r["factible"] and r["orden"][0] == "H" and r["orden"][-1] == "H"
    assert r["O2_total_L"] <= 40 * (1 - K.RHO) + 1e-6 and r["O2_reserva_L"] == 6.0
    sitios = {s["id"]: s for s in p["sitios"]}
    assert sum(sitios[i]["masa_kg"] for i in r["orden"][1:-1]) <= 5.0 + 1e-9
    # ciencia: recalcular Z con psi; ventanas y tiempos coherentes
    cuenta, Z = {}, 0.0
    for par in r["paradas"]:
        s = sitios[par["id"]]
        cuenta[s["mineral"]] = cuenta.get(s["mineral"], 0) + 1
        Z += s["valor"] * psi(cuenta[s["mineral"]])
        hora = 10.0 + par["llegada_s"] / 3699
        assert s["ventana"][0] - 1e-6 <= hora <= s["ventana"][1] + 1e-6
        assert abs(par["salida_s"] - par["llegada_s"] - 60 * s["perforacion_min"]) < 0.2
    assert abs(Z - r["ciencia_Z"]) < 1e-2
    assert r["polilinea"][0] == [120.0, 120.0] and r["polilinea"][-1] == [120.0, 120.0]
    assert r["ruta_escape"] and m.como_mensaje(r)["motivo"] == "pedido"
    return r


def test_sin_o2():
    m, p = _motor(), _pedido()
    p["O2_disponible_L"] = 2.0
    r = m.planificar(p)
    assert not r["factible"] and r["orden"] == ["H", "H"] and r["paradas"] == []
    assert len(r["polilinea"]) >= 1 and r["ruta_escape"]


def _guion(m):
    """Mini guion: telemetria, peligro sobre la ruta, ventana, SPE alerta y critico."""
    sal = []
    hab = m.terreno.habitat
    sal += m.procesar_evento(_tele(0, 1, hab["x"], hab["y"], 40.0))
    plan = sal[-1]["plan"]
    pol = plan["polilinea"]
    medio = pol[len(pol) // 3]
    sal += m.procesar_evento(_ev(10, 2, "peligro", {"id": "p1", "forma": "circulo", "x": medio[0],
                                                    "y": medio[1], "radio_m": 6, "efecto": "bloqueo", "factor": 1}))
    ultimo = sal[-1]["plan"]["paradas"][-1]["id"]
    sal += m.procesar_evento(_ev(20, 3, "ventanas", {"sitios": [{"id": ultimo, "ventana": [9.0, 9.5]}]}))
    sal += m.procesar_evento(_ev(30, 4, "SPE", {"nivel": "alerta", "llegada_s": 600}))
    sal += m.procesar_evento(_ev(40, 5, "telemetria_rover", {"x": 1, "y": 1, "bateria_pct": 90}))
    sal += m.procesar_evento(_ev(50, 6, "SPE", {"nivel": "critico", "llegada_s": 0}))
    sal += m.procesar_evento(_tele(60, 7, hab["x"], hab["y"], 39.0))
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
    assert sal[4]["plan"]["O2_reserva_L"] == 10.0                                 # rho = 0,25
    assert sal[4]["plan"]["O2_total_L"] <= 30.0 + 1e-6
    assert sal[5]["ruta_escape"] and m.estado()["abortado"]


def test_no_retorno_y_recalibracion():
    m = _motor()
    s = m.terreno.sitios[0]
    m.procesar_evento(_tele(0, 1, 120.0, 120.0, 40.0))
    R = float(m._R[m.terreno.indice(s["x"], s["y"])])
    sal = m.procesar_evento(_tele(10, 2, s["x"], s["y"], R * 1.10))
    assert [x["tipo"] for x in sal] == ["estado_aborto", "abortar"] and sal[1]["motivo"] == "no_retorno"
    assert sal[0]["margen_pct"] <= 15 and abs(sal[0]["O2_minimo_L"] - 1.15 * sal[0]["R_L"]) < 2e-3

    m = _motor()
    m.procesar_evento(_tele(0, 1, 120.0, 120.0, 40.0))
    kappa = m.estado()["kappa_O2_L_W_min"]
    motivos = []
    for k in range(1, 12):                                   # parado, VO2 x1,3 del previsto
        for x in m.procesar_evento(_tele(10 * k, k + 1, 120.0, 120.0, 40 - 0.15 * k,
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
    m.procesar_evento(_tele(0, 1, 120.0, 120.0, 40.0))
    t = time.perf_counter()
    for k in range(1, 201):
        m.procesar_evento(_tele(10 * k, k + 1, 120.0 + 0.1 * k, 120.0, 40.0 - 0.01 * k, vo2=0.66))
    ms = 1000 * (time.perf_counter() - t) / 200
    assert ms < 5.0, ms
    return ms


def test_guion_demo():
    from optimizador.pruebas.simular_guion import correr
    reg, fin = correr()
    assert [m["motivo"] for m in reg] == ["inicial", "peligro", "recalibracion", "ventana",
                                          "spe_alerta", "spe_critico"], [m["motivo"] for m in reg]
    assert all(math.hypot(x - 197.5, y - 85.5) > 4.0 for x, y in reg[1]["plan"]["polilinea"])
    assert 6 in reg[2]["plan"]["orden"] and 6 not in reg[3]["plan"]["orden"]
    assert reg[4]["plan"]["O2_reserva_L"] > reg[3]["plan"]["O2_reserva_L"] * 0.25 / 0.15 * 0.7
    assert reg[5]["tipo"] == "abortar" and fin["O2_final_L"] > 6.0 and fin["margen_min_pct"] > 15
    reg2, fin2 = correr()
    quitar = lambda r: [{k: v for k, v in m.get("plan", m).items() if k != "tiempo_calculo_ms"} for m in r]
    assert quitar(reg) == quitar(reg2) and fin == fin2


if __name__ == "__main__":
    for nombre, f in list(globals().items()):
        if nombre.startswith("test_"):
            r = f()
            print(f"ok  {nombre}" + (f"  ({r:.3f} ms/telemetria)" if isinstance(r, float) else ""))
    r = test_plan_de_ejemplo()
    print(json.dumps({k: v for k, v in r.items() if k not in ("polilinea", "ruta_escape")}, indent=1))
    print("puntos en la polilinea:", len(r["polilinea"]))
