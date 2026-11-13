"""Motor del optimizador: interfaz de CLAUDE.md §12 y reglas en vivo de §9."""
import copy
import math
import time
from collections import deque

import numpy as np

from . import constantes as K
from .errores import PedidoInvalido, SinPerfil, VersionNoSoportada
from .fisica import astronauta_de, o2_reposo_L_s, potencia
from .grafo import Grafo
from .rutas import cruza_circulo, desde_mas_cercano, suavizar
from .solver import resolver
from .terreno import Terreno

_CAMPOS_SITIO = ("id", "x", "y", "valor", "mineral", "masa_kg", "perforacion_min", "ventana")


class Motor:
    def __init__(self, ruta_terreno="terreno/"):
        self.terreno = Terreno.cargar(ruta_terreno)
        self._perfil = None

    # ------------------------------------------------------------------ sesion
    def cargar_perfil(self, perfil: dict) -> None:
        self._version(perfil)
        self._perfil = copy.deepcopy(perfil)
        self._astro = astronauta_de(perfil)
        self._t0_hora = float(perfil.get("t0_hora_solar", 10.0))
        self._duracion = float(perfil.get("duracion_eva_s", K.DURACION_EVA_S))
        self._rho = K.RHO
        self._sitios = {s["id"]: copy.deepcopy(s) for s in self.terreno.sitios}
        self._visitados = set()
        self._llegados = set()       # sitios a los que ya llego (a <= 5 m)
        self._peligros = {}
        self._plan = None
        self._n_plan = 0
        self._tele = None            # ultima telemetria: dict(t, x, y, O2, carga)
        self._tele_prev = None
        self._ultimo_estado = None
        self._abortado = False
        self._vo2 = deque()          # (t, medido / previsto)
        self._t_recal = -math.inf
        self._reconstruir()

    def _reconstruir(self):
        """Recalcula el grafo y el campo de retorno con los peligros activos y kappa actual."""
        ter = self.terreno
        mult = bloq = None
        if self._peligros:
            idx = np.arange(ter.n)
            xs = ter.x0 + (idx % ter.columnas + 0.5) * ter.tam
            ys = ter.y0 + (idx // ter.columnas + 0.5) * ter.tam
            mult = np.ones(ter.n)
            bloq = np.zeros(ter.n, dtype=bool)
            for p in self._peligros.values():
                dentro = np.hypot(xs - p["x"], ys - p["y"]) <= p["radio_m"]
                if p["efecto"] == "bloqueo":
                    bloq |= dentro
                else:
                    f = min(5.0, max(1.0, float(p.get("factor", 1.0))))
                    mult[dentro] = np.maximum(mult[dentro], f)
            forma = (ter.filas, ter.columnas)
            mult, bloq = mult.reshape(forma), bloq.reshape(forma)
        self._grafo = Grafo(ter, self._astro, mult, bloq)
        self._h = ter.indice(ter.habitat["x"], ter.habitat["y"])
        self._R, self._sig = self._grafo.campo_retorno(self._h)
        # campos de retorno a cada refugio: (refugio, R, sig, celda)
        self._refugios = []
        for r in ter.refugios:
            c = ter.indice(r["x"], r["y"])
            R, sig = self._grafo.campo_retorno(c)
            self._refugios.append((r, R, sig, c))

    # ----------------------------------------------------------------- pedidos
    def planificar(self, pedido: dict) -> dict:
        self._con_perfil()
        self._version(pedido)
        self._validar(pedido)
        self._sitios = {s["id"]: copy.deepcopy(s) for s in pedido["sitios"]}
        self._visitados = set()
        self._llegados = set()       # sitios a los que ya llego (a <= 5 m)
        ini = pedido["inicio"]
        self._plan = self._calcular(ini["x"], ini["y"], pedido["hora_solar"],
                                    pedido["O2_disponible_L"], pedido["capacidad_kg"],
                                    pedido["sitios"])
        return copy.deepcopy(self._plan)

    def como_mensaje(self, respuesta: dict) -> dict:
        self._con_perfil()
        return self._msg_plan(respuesta, "pedido", self._t_actual(), None)

    def estado(self) -> dict:
        self._con_perfil()
        return {
            "version": K.VERSION,
            "plan": copy.deepcopy(self._plan),
            "estado_aborto": copy.deepcopy(self._ultimo_estado),
            "peligros": [copy.deepcopy(p) for p in self._peligros.values()],
            "abortado": self._abortado,
            "rho": self._rho,
            "kappa_O2_L_W_min": self._astro["kappa_O2_L_W_min"],
            "visitados": sorted(self._visitados),
        }

    # ----------------------------------------------------------------- eventos
    def procesar_evento(self, evento: dict) -> list:
        self._con_perfil()
        self._version(evento)
        tipo, d = evento.get("tipo"), evento.get("datos", {})
        t, seq = float(evento.get("t", 0.0)), evento.get("seq")
        if tipo == "telemetria_astronauta":
            return self._telemetria(d, t, seq)
        if tipo == "peligro":
            return self._peligro(d, t, seq)
        if tipo == "ventanas":
            return self._ventanas(d, t, seq)
        if tipo == "SPE":
            return self._spe(d, t, seq)
        return []                    # telemetria_rover y tipos desconocidos

    def _telemetria(self, d, t, seq):
        ter = self.terreno
        x, y, o2 = float(d["x"]), float(d["y"]), float(d["O2_restante_L"])
        self._tele_prev, self._tele = self._tele, {
            "t": t, "x": x, "y": y, "O2": o2, "carga": float(d.get("carga_kg", 0.0))}

        R = float(self._R[ter.indice(x, y)])
        margen = 9999.0 if R < 1e-9 else (math.inf if math.isinf(R) else 100.0 * (o2 / R - 1.0))
        if math.isinf(R):            # sin camino de vuelta: se trata como margen agotado
            R, margen = o2, 0.0
        self._ultimo_estado = {
            "version": K.VERSION, "tipo": "estado_aborto", "t": t,
            "O2_restante_L": round(o2, 3), "R_L": round(R, 3),
            "O2_minimo_L": round(K.FACTOR_O2_MINIMO * R, 3), "margen_pct": round(margen, 1)}
        salida = [copy.deepcopy(self._ultimo_estado)]
        if self._abortado:
            return salida

        # sitios ya muestreados segun el plan vigente
        if self._plan:
            for p in self._plan["paradas"]:
                if p["id"] in self._visitados:
                    continue
                if math.hypot(x - p["x"], y - p["y"]) <= K.RADIO_VISITA_M:
                    self._llegados.add(p["id"])
                if p["id"] in self._llegados and t >= p["salida_s"] - 1e-6:
                    self._visitados.add(p["id"])

        if margen <= K.MARGEN_ABORTO_PCT:
            salida.append(self._abortar("no_retorno", t, seq))
            return salida

        if self._plan is None:
            salida.append(self._replanificar("inicial", t, seq))
            return salida

        if self._desvio_vo2(d, t):
            self._reconstruir()
            salida.append(self._replanificar("recalibracion", t, seq))
        return salida

    def _desvio_vo2(self, d, t) -> bool:
        """Acumula medido/previsto; True si hubo que recalibrar kappa."""
        if "VO2_L_min" not in d:
            return False
        kappa = self._astro["kappa_O2_L_W_min"]
        ter, a, b = self.terreno, self._tele_prev, self._tele
        if float(d.get("velocidad_m_s", 0.0)) > 0.05:
            G = 0.0
            if a:
                dist = math.hypot(b["x"] - a["x"], b["y"] - a["y"])
                if dist > 0.1:
                    G = 100.0 * (ter.z(b["x"], b["y"]) - ter.z(a["x"], a["y"])) / dist
            i, j = ter.celda(b["x"], b["y"])
            previsto = float(potencia(G, ter.eta[i, j], self._astro)) * kappa
        else:
            previsto = K.M_PERFORACION_W * kappa
        self._vo2.append((t, float(d["VO2_L_min"]) / previsto))
        while self._vo2 and t - self._vo2[0][0] > K.VENTANA_VO2_S + 1e-6:
            self._vo2.popleft()
        if t - self._vo2[0][0] < K.VENTANA_VO2_S - 1e-6:
            return False
        media = sum(r for _, r in self._vo2) / len(self._vo2)
        if abs(media - 1.0) <= K.DESVIO_VO2 or t - self._t_recal < K.ENFRIAMIENTO_RECAL_S:
            return False
        self._astro["kappa_O2_L_W_min"] = kappa * media
        self._t_recal = t
        self._vo2.clear()
        return True

    def _peligro(self, d, t, seq):
        if float(d.get("radio_m", 0.0)) <= 0.0:
            if self._peligros.pop(d["id"], None) is not None:
                self._reconstruir()
            return []
        self._peligros[d["id"]] = copy.deepcopy(d)
        self._reconstruir()
        if self._abortado or not self._plan:
            return []
        x, y = self._posicion()
        tramo = desde_mas_cercano(self._plan["polilinea"], x, y)
        if cruza_circulo(tramo, float(d["x"]), float(d["y"]), float(d["radio_m"])):
            return [self._replanificar("peligro", t, seq)]
        return []

    def _ventanas(self, d, t, seq):
        cambiados = set()
        for s in d.get("sitios", []):
            if s["id"] in self._sitios:
                self._sitios[s["id"]]["ventana"] = list(s["ventana"])
                cambiados.add(s["id"])
        if self._abortado or not self._plan:
            return []
        for p in self._plan["paradas"]:
            if p["id"] in cambiados and p["id"] not in self._visitados:
                ini, fin = self._sitios[p["id"]]["ventana"]
                hora = self._t0_hora + p["llegada_s"] / K.SEG_POR_HORA_SOLAR
                if not ini - 1e-9 <= hora <= fin + 1e-9:
                    return [self._replanificar("ventana", t, seq)]
        return []

    def _spe(self, d, t, seq):
        if self._abortado:
            return []
        if d.get("nivel") == "critico":
            return [self._abortar("spe_critico", t, seq)]
        if d.get("nivel") == "alerta":
            self._rho = K.RHO_SPE
            return [self._replanificar("spe_alerta", t, seq)]
        return []

    # ---------------------------------------------------------------- internos
    def _posicion(self):
        if self._tele:
            return self._tele["x"], self._tele["y"]
        return float(self.terreno.habitat["x"]), float(self.terreno.habitat["y"])

    def _t_actual(self) -> float:
        return self._tele["t"] if self._tele else 0.0

    def _replanificar(self, motivo, t, seq) -> dict:
        """Siempre desde la posicion actual y con el O2 restante, nunca desde el plan original."""
        x, y = self._posicion()
        o2 = self._tele["O2"] if self._tele else self._astro["O2_inicial_L"]
        carga = self._tele["carga"] if self._tele else 0.0
        pendientes = [s for i, s in self._sitios.items() if i not in self._visitados]
        # Si ya esta perforando un sitio del plan, solo le queda el tiempo restante
        for p in (self._plan["paradas"] if self._plan else []):
            if (p["id"] not in self._visitados and t >= p["llegada_s"]
                    and math.hypot(x - p["x"], y - p["y"]) <= K.RADIO_VISITA_M):
                resto = max(0.0, p["salida_s"] - t) / 60.0
                pendientes = [dict(s, perforacion_min=resto) if s["id"] == p["id"] else s
                              for s in pendientes]
        self._plan = self._calcular(
            x, y, self._t0_hora + t / K.SEG_POR_HORA_SOLAR, o2,
            max(0.0, self._astro["capacidad_muestras_kg"] - carga), pendientes)
        return self._msg_plan(self._plan, motivo, t, seq)

    def _abortar(self, motivo, t, seq) -> dict:
        self._abortado = True
        x, y = self._posicion()
        c = self.terreno.indice(x, y)
        hab = self.terreno.habitat
        R, sig, meta = float(self._R[c]), self._sig, self._h
        destino = {"tipo": "habitat", "id": "H", "x": hab["x"], "y": hab["y"]}
        if motivo == "spe_critico":
            # tormenta solar: el refugio (crater) mas barato en O2, si es mejor que el habitat
            for r, Rr, sr, cr in self._refugios:
                if float(Rr[c]) < R:
                    R, sig, meta = float(Rr[c]), sr, cr
                    destino = {"tipo": "refugio", "id": r["id"], "x": r["x"], "y": r["y"]}
        o2 = self._tele["O2"] if self._tele else self._astro["O2_inicial_L"]
        return {"version": K.VERSION, "tipo": "abortar", "t": t, "motivo": motivo,
                "seq_evento": seq, "destino": destino,
                "ruta_escape": self._escape(x, y, sig, meta, destino),
                "O2_previsto_L": round(o2 - R, 3) if math.isfinite(R) else 0.0}

    def _escape(self, x, y, sig=None, meta=None, destino=None):
        """Polilinea de vuelta (por defecto al habitat) desde (x, y) por el campo de retorno."""
        d = destino or self.terreno.habitat
        cam = Grafo.camino_retorno(self._sig if sig is None else sig,
                                   self.terreno.indice(x, y), self._h if meta is None else meta)
        return self._polilinea(cam, (x, y), (d["x"], d["y"]))

    def _polilinea(self, cam, ini, fin):
        """Puntos exactos en los extremos, centros de celda en el medio. Sin camino: recta."""
        medio = [self.terreno.centro(c) for c in cam[1:-1]] if cam else []
        return suavizar([tuple(ini)] + medio + [tuple(fin)], K.SUAVIZADO_PASADAS)

    def _msg_plan(self, plan, motivo, t, seq) -> dict:
        return {"version": K.VERSION, "tipo": "plan_actualizado", "t": t, "motivo": motivo,
                "seq_evento": seq, "plan": copy.deepcopy(plan)}

    def _calcular(self, x, y, hora_solar, o2_disp, capacidad, sitios) -> dict:
        t_ini_calc = time.perf_counter()
        ter, g, hab = self.terreno, self._grafo, self.terreno.habitat
        sitios = sorted(sitios, key=lambda s: s["id"])[:K.N_MAX_SITIOS]
        n = len(sitios)
        H = n + 1
        celdas = [ter.indice(x, y)] + [ter.indice(s["x"], s["y"]) for s in sitios] + [self._h]
        xy = [(x, y)] + [(s["x"], s["y"]) for s in sitios] + [(hab["x"], hab["y"])]

        # Matrices asimetricas D (O2) y T (tiempo) y caminos
        dist, pred = g.desde(celdas[:-1])
        D = [[math.inf] * (n + 2) for _ in range(n + 2)]
        T = [[math.inf] * (n + 2) for _ in range(n + 2)]
        caminos = {}
        for a in range(n + 1):
            for b in range(1, n + 2):
                if a == b or not math.isfinite(dist[a, celdas[b]]):
                    continue
                if b != H and g.bloqueada.flat[celdas[b]] and celdas[a] != celdas[b]:
                    continue
                cam = Grafo.camino(pred[a], celdas[a], celdas[b])
                D[a][b] = float(dist[a, celdas[b]])
                T[a][b] = g.tiempo_camino(cam)
                caminos[a, b] = cam

        reposo = o2_reposo_L_s(self._astro)
        t_ini = max(0.0, (hora_solar - self._t0_hora) * K.SEG_POR_HORA_SOLAR)
        tau = [0.0] + [60.0 * s["perforacion_min"] for s in sitios]
        ventana_s = [(0.0, 0.0)] + [
            ((s["ventana"][0] - hora_solar) * K.SEG_POR_HORA_SOLAR,
             (s["ventana"][1] - hora_solar) * K.SEG_POR_HORA_SOLAR) for s in sitios]
        o2_util = o2_disp * (1.0 - self._rho)
        tope = max(0.05, K.TOPE_SOLVER_S - 0.3 - (time.perf_counter() - t_ini_calc))
        sol = resolver(
            D, T,
            valor=[0.0] + [float(s["valor"]) for s in sitios],
            mineral=[None] + [s["mineral"] for s in sitios],
            masa=[0.0] + [float(s["masa_kg"]) for s in sitios],
            o2_muestreo=[0.0] + [reposo * ts for ts in tau[1:]],
            tau_s=tau, ventana_s=ventana_s,
            o2_util=o2_util, capacidad_kg=capacidad,
            t_max=self._duracion - t_ini, o2_espera_L_s=reposo, tope_s=tope)
        orden = sol["orden"] or []

        # Recorrido: paradas, O2 acumulado y polilinea
        paradas, polilinea = [], []
        i, t, o2 = 0, 0.0, 0.0
        for j in orden + [H]:
            tramo = self._polilinea(caminos.get((i, j)), xy[i], xy[j])
            polilinea += tramo[1:] if polilinea else tramo
            if j == H:
                o2 += D[i][H] if math.isfinite(D[i][H]) else 0.0
                break
            lleg = t + T[i][j]
            espera = max(0.0, ventana_s[j][0] - lleg)
            t = lleg + espera + tau[j]
            o2 += D[i][j] + reposo * (espera + tau[j])
            s = sitios[j - 1]
            paradas.append({"id": s["id"], "x": s["x"], "y": s["y"],
                            "llegada_s": round(t_ini + lleg + espera, 1),
                            "salida_s": round(t_ini + t, 1), "O2_acum_L": round(o2, 3)})
            i = j

        en_habitat = celdas[0] == self._h
        factible = bool(orden)
        ids = [sitios[j - 1]["id"] for j in orden]
        self._n_plan += 1
        return {
            "version": K.VERSION,
            "plan_id": f"pl-{self._n_plan:04d}",
            "factible": factible,
            "orden": (["H"] if en_habitat or not factible else []) + ids + ["H"],
            "polilinea": polilinea,
            "paradas": paradas,
            "O2_total_L": round(o2, 3),
            "O2_reserva_L": round(o2_disp * self._rho, 3),
            "ciencia_Z": round(max(sol["Z"], 0.0), 3) if orden else 0.0,
            "ruta_escape": self._escape(x, y),
            "tiempo_calculo_ms": int(round(1000 * (time.perf_counter() - t_ini_calc))),
            "optimo": sol["optimo"],
        }

    # ------------------------------------------------------------ validaciones
    def _con_perfil(self):
        if self._perfil is None:
            raise SinPerfil("falta cargar_perfil()")

    @staticmethod
    def _version(msg):
        if not isinstance(msg, dict) or msg.get("version") != K.VERSION:
            v = msg.get("version") if isinstance(msg, dict) else None
            raise VersionNoSoportada(f"version {v!r}; se esperaba {K.VERSION!r}")

    @staticmethod
    def _validar(p):
        def num(v):
            return isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v)
        try:
            ok = (num(p["inicio"]["x"]) and num(p["inicio"]["y"]) and num(p["hora_solar"])
                  and num(p["O2_disponible_L"]) and p["O2_disponible_L"] >= 0
                  and num(p["capacidad_kg"]) and p["capacidad_kg"] >= 0
                  and isinstance(p["sitios"], list))
        except (KeyError, TypeError) as e:
            raise PedidoInvalido(f"falta el campo {e}") from e
        if not ok:
            raise PedidoInvalido("campos del pedido con tipo o valor invalido")
        if len(p["sitios"]) > K.N_MAX_SITIOS:
            raise PedidoInvalido(f"mas de {K.N_MAX_SITIOS} sitios")
        ids = set()
        for s in p["sitios"]:
            falta = [c for c in _CAMPOS_SITIO if c not in s]
            if falta:
                raise PedidoInvalido(f"sitio {s.get('id')!r}: faltan {falta}")
            if type(s["id"]) is not int or s["id"] in ids:
                raise PedidoInvalido(f"id de sitio invalido o repetido: {s['id']!r}")
            ids.add(s["id"])
            if not (num(s["x"]) and num(s["y"]) and num(s["valor"]) and 1 <= s["valor"] <= 10
                    and num(s["masa_kg"]) and s["masa_kg"] >= 0
                    and num(s["perforacion_min"]) and s["perforacion_min"] >= 0):
                raise PedidoInvalido(f"sitio {s['id']}: valores fuera de rango")
            if s["mineral"] not in K.MINERALES:
                raise PedidoInvalido(f"sitio {s['id']}: mineral {s['mineral']!r} desconocido")
            v = s["ventana"]
            if not (isinstance(v, list) and len(v) == 2 and num(v[0]) and num(v[1]) and v[0] <= v[1]):
                raise PedidoInvalido(f"sitio {s['id']}: ventana invalida")
