"""Valida mensajes, registros y paquetes de terreno contra contratos/schemas/.

    python contratos/validar.py logs/sesion-2026-11-12-mision.jsonl     # una linea JSON por mensaje
    python contratos/validar.py contratos/ejemplos/pedido.json          # un mensaje suelto
    python contratos/validar.py --terreno terreno/                      # manifest.json + sitios.json (+ archivos)
    python contratos/validar.py --marcadores logs/sesion-...marcadores.json

Sale con codigo 1 si algo no cumple. Los campos extra se permiten (cambios aditivos): los consumidores los ignoran.
Como libreria:  from contratos.validar import validar_mensaje  ->  lista de errores (vacia = valido).
"""
import json
import sys
from collections import Counter
from pathlib import Path

from jsonschema import Draft202012Validator
from referencing import Registry, Resource
from referencing.jsonschema import DRAFT202012

DIR = Path(__file__).resolve().parent / "schemas"

# `tipo` del mensaje -> esquema. Pedido y plan no llevan `tipo`: se reconocen por sus campos.
POR_TIPO = {"perfil": "perfil", "telemetria_astronauta": "telemetria_astronauta", "telemetria_rover": "telemetria_rover",
            "peligro": "peligro", "ventanas": "ventanas", "SPE": "spe", "hito": "hito", "plan_actualizado": "plan_actualizado",
            "abortar": "abortar", "estado_aborto": "estado_aborto", "control": "control", "reinicio": "reinicio", "error": "error"}

_cache = {}


def _registro():
    if "reg" not in _cache:
        recursos = []
        for f in DIR.glob("*.json"):
            c = json.loads(f.read_text(encoding="utf-8"))
            recursos.append((c["$id"], Resource.from_contents(c, default_specification=DRAFT202012)))
        _cache["reg"] = Registry().with_resources(recursos)
    return _cache["reg"]


def validador(nombre):
    if nombre not in _cache:
        reg = _registro()
        raiz = reg.get_or_retrieve(f"https://ares-twin.local/schemas/{nombre}.json").value.contents
        _cache[nombre] = Draft202012Validator(raiz, registry=reg)
    return _cache[nombre]


def esquema_de(msg):
    if not isinstance(msg, dict):
        return None
    if msg.get("tipo") in POR_TIPO:
        return POR_TIPO[msg["tipo"]]
    if "plan_id" in msg:
        return "plan"
    if "inicio" in msg and "sitios" in msg:
        return "pedido"
    return None


def validar_con(nombre, msg):
    return [f"{'/'.join(map(str, e.absolute_path)) or '(raiz)'}: {e.message[:160]}"
            for e in sorted(validador(nombre).iter_errors(msg), key=lambda e: list(map(str, e.absolute_path)))]


def validar_mensaje(msg):
    """Errores del mensaje (lista vacia = valido). Un tipo desconocido NO es error: se ignora (CLAUDE.md §9)."""
    nombre = esquema_de(msg)
    return [] if nombre is None else validar_con(nombre, msg)


def validar_jsonl(ruta, maximo_errores=15):
    cuenta, malos, orden_t, ultimo_t = Counter(), [], 0, -1.0
    for n, linea in enumerate(Path(ruta).read_text(encoding="utf-8").splitlines()):
        if not linea.strip():
            continue
        try:
            msg = json.loads(linea)
        except json.JSONDecodeError as e:
            malos.append((n, f"JSON invalido: {e}"))
            continue
        cuenta[msg.get("tipo", "?")] += 1
        for err in validar_mensaje(msg):
            malos.append((n, f"{msg.get('tipo')}: {err}"))
        t = msg.get("t")
        if isinstance(t, (int, float)):
            if t < ultimo_t - 1e-9:
                orden_t += 1
            ultimo_t = max(ultimo_t, t)
    return cuenta, malos[:maximo_errores], len(malos), orden_t


def validar_terreno(carpeta):
    """manifest.json + sitios.json + archivos de capa con el tamano que declara el manifiesto."""
    carpeta, errores = Path(carpeta), []
    m = json.loads((carpeta / "manifest.json").read_text(encoding="utf-8"))
    errores += [f"manifest.json: {e}" for e in validar_con("manifest", m)]
    filas, cols = m.get("filas", 0), m.get("columnas", 0)
    for nombre, c in m.get("capas", {}).items():
        f = carpeta / c.get("archivo", "")
        if not f.exists():
            errores.append(f"capa {nombre}: falta el archivo {c.get('archivo')}")
            continue
        dtype = c.get("dtype") or c.get("formato")
        if dtype in ("float32", "uint8"):
            esperado = filas * cols * (4 if dtype == "float32" else 1)
            if f.stat().st_size != esperado:
                errores.append(f"capa {nombre}: {f.stat().st_size} bytes, se esperaban {esperado} ({filas}x{cols} {dtype})")
    ruta_sitios = carpeta / m.get("sitios", "sitios.json")
    if ruta_sitios.exists():
        errores += [f"sitios.json: {e}" for e in validar_con("sitios", json.loads(ruta_sitios.read_text(encoding="utf-8")))]
    return errores


def main(argv):
    mal = False
    i = 0
    while i < len(argv):
        a = argv[i]
        if a == "--terreno":
            i += 1
            err = validar_terreno(argv[i])
            print(f"terreno {argv[i]}: {'OK' if not err else str(len(err)) + ' errores'}")
            for e in err:
                print("  ", e)
            mal |= bool(err)
        elif a == "--marcadores":
            i += 1
            err = validar_con("marcadores", json.loads(Path(argv[i]).read_text(encoding="utf-8")))
            print(f"marcadores {argv[i]}: {'OK' if not err else str(len(err)) + ' errores'}")
            for e in err:
                print("  ", e)
            mal |= bool(err)
        elif a.endswith(".jsonl"):
            cuenta, malos, total, desorden = validar_jsonl(a)
            print(f"{a}: {sum(cuenta.values())} mensajes {dict(cuenta)}")
            print(f"  errores de esquema: {total}; mensajes con t que retrocede: {desorden}")
            for n, e in malos:
                print(f"   linea {n}: {e}")
            mal |= bool(total or desorden)
        else:
            msg = json.loads(Path(a).read_text(encoding="utf-8"))
            err = validar_mensaje(msg) if esquema_de(msg) else ["no se reconoce el tipo de mensaje"]
            print(f"{a}: {'OK' if not err else str(len(err)) + ' errores'}")
            for e in err:
                print("  ", e)
            mal |= bool(err)
        i += 1
    return 1 if mal else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
