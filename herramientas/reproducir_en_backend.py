"""Hace de telemetria (Dana) contra el backend en vivo: manda el perfil y, al ritmo de la mision, los
eventos de ENTRADA de un registro .jsonl (telemetria, peligro, ventanas, SPE, hito). Las salidas del
optimizador (planes, estado_aborto, abortar) NO se mandan: las calcula el Motor del backend en vivo.

    python herramientas/reproducir_en_backend.py                       # mision de referencia a x30
    python herramientas/reproducir_en_backend.py --factor 60 --url ws://127.0.0.1:8000/ws

Sirve para probar el modo "Backend en vivo" del visor (front/?role=spectator&modo=vivo) sin la
telemetria real. Requiere el paquete `websockets` (pip install websockets).
"""
import argparse
import asyncio
import json
import time
from pathlib import Path

import websockets

RAIZ = Path(__file__).resolve().parents[1]
ENTRADAS = {"telemetria_astronauta", "telemetria_rover", "peligro", "ventanas", "SPE", "hito"}


async def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--registro", default=str(RAIZ / "logs/sesion-2026-11-12-mision.jsonl"))
    ap.add_argument("--guion", default=str(RAIZ / "contratos/ejemplos/guion_mision.json"), help="de aqui sale el perfil")
    ap.add_argument("--url", default="ws://127.0.0.1:8000/ws")
    ap.add_argument("--token", default="", help="ARES_WRITE_TOKEN del backend, si lo tiene")
    ap.add_argument("--factor", type=float, default=None, help="segundos simulados por segundo real (por defecto, el del perfil)")
    a = ap.parse_args()

    perfil = json.loads(Path(a.guion).read_text(encoding="utf-8"))["perfil"]
    factor = a.factor or float(perfil.get("factor_tiempo", 30))
    eventos = [m for m in map(json.loads, Path(a.registro).read_text(encoding="utf-8").splitlines()) if m.get("tipo") in ENTRADAS]
    url = f"{a.url}?rol=dana" + (f"&token={a.token}" if a.token else "")
    print(f"{len(eventos)} eventos de entrada, x{factor:g} -> {url}")

    async with websockets.connect(url, max_size=2**22) as ws:
        print("snapshot:", json.loads(await ws.recv()).get("tipo"))

        async def enviar(msg):
            await ws.send(json.dumps(msg, ensure_ascii=False))
            # El backend responde a cada envio de Dana (ack / ignorado / error); los demas mensajes
            # que difunde (planes, estado_aborto) tambien llegan aqui y se saltan.
            while True:
                r = json.loads(await ws.recv())
                if r.get("tipo") in ("ack", "ignorado", "error", "perfil_cargado"):
                    return r

        print("perfil:", (await enviar(perfil)).get("tipo"))
        t0, inicio = eventos[0].get("t", 0.0), time.perf_counter()
        seq = 0
        for ev in eventos:
            if ev["tipo"] != "hito":  # el hito no consume seq (INTEGRACION §5.1)
                seq += 1
                ev = dict(ev, seq=seq)  # un solo emisor: seq consecutivo desde 1 (CLAUDE.md §5)
            espera = (ev.get("t", 0.0) - t0) / factor - (time.perf_counter() - inicio)
            if espera > 0:
                await asyncio.sleep(espera)
            r = await enviar(ev)
            if r.get("tipo") == "error":
                print(f"  {ev['tipo']} t={ev.get('t')}: ERROR {r.get('codigo')} {r.get('detalle')}")
            elif ev["tipo"] != "telemetria_astronauta" or seq % 60 == 0:
                print(f"  t = {ev.get('t', 0) / 60:6.1f} min  {ev['tipo']:22s} -> {r.get('tipo')}"
                      + (f" ({r.get('mensajes_emitidos')} del Motor)" if r.get("mensajes_emitidos") else ""))
    print("fin del registro")


if __name__ == "__main__":
    asyncio.run(main())
