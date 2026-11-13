"""Corre el guion de mision contra el Motor y genera lo que consumen el visor, el front y el VR.

    python herramientas/generar_registro.py [--guion guion_mision.json] [--fecha 2026-11-12]

Salida:
    logs/sesion-<fecha>-mision.jsonl              un mensaje por linea, en orden (entradas, salidas del
                                                  optimizador y `hito` auxiliares)
    logs/sesion-<fecha>-mision.marcadores.json    saltos: {id, t, min, clase, titulo, detalle, linea, nivel}
                                                  nivel 1 = botones; nivel 2 = llegadas a sitios
    demo/visor_mision.html                        visor autonomo (doble clic) con capas y botones de salto

Saltar a un instante t = reaplicar los mensajes con m.t <= t sobre un estado vacio (el visor lo hace asi);
`linea` es el indice (desde 0) del mensaje del hito dentro del .jsonl.
"""
import argparse
import base64
import datetime
import json
import sys
from pathlib import Path

import numpy as np

RAIZ = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(RAIZ))
from optimizador.pruebas.simular_guion import simular      # noqa: E402
from optimizador.terreno import Terreno                    # noqa: E402


def _capa(ruta, forma, escala):
    """float32 -> lista de enteros (valor * escala), None donde no hay dato."""
    a = np.fromfile(ruta, "<f4").reshape(forma)
    return [None if not np.isfinite(v) else int(round(float(v) * escala)) for v in a.ravel()]


def main(guion: str, fecha: str) -> None:
    g = json.loads((RAIZ / "contratos/ejemplos" / guion).read_text(encoding="utf-8"))
    log, marcas, resumen = simular(g, verboso=True)

    nombre = f"sesion-{fecha}-mision"
    (RAIZ / "logs").mkdir(exist_ok=True)
    (RAIZ / "logs" / f"{nombre}.jsonl").write_text(
        "".join(json.dumps(m, ensure_ascii=False, separators=(",", ":")) + "\n" for m in log), encoding="utf-8")
    (RAIZ / "logs" / f"{nombre}.marcadores.json").write_text(
        json.dumps({"version": "1.0", "jsonl": f"{nombre}.jsonl", "marcadores": marcas},
                   ensure_ascii=False, indent=1) + "\n", encoding="utf-8")

    carpeta = RAIZ / g["terreno"]
    ter = Terreno.cargar(carpeta)
    m = ter.manifest
    forma = (ter.filas, ter.columnas)
    superposiciones = []
    for clave, c in m["capas"].items():
        if clave.startswith("crism_"):
            superposiciones.append({"id": clave, "titulo": c["descripcion"].split(";")[0], "fuente": c["fuente"],
                                    "escala": 10000, "datos": _capa(carpeta / c["archivo"], forma, 10000)})
    if "pendiente_deg" in m["capas"]:
        superposiciones.append({"id": "pendiente_deg", "titulo": "pendiente (grados)", "fuente": "derivada del DEM",
                                "escala": 10, "datos": _capa(carpeta / m["capas"]["pendiente_deg"]["archivo"], forma, 10)})
    orto = m["capas"].get("ortofoto")
    datos = {
        "perfil": g["perfil"], "log": log, "marcadores": marcas,
        "terreno": {"filas": ter.filas, "columnas": ter.columnas, "tam": ter.tam, "sitio": m["sitio"],
                    "elev": (ter.elevacion * 100).round().astype(int).ravel().tolist(),   # cm
                    "peligro": ter.peligro.ravel().tolist(),
                    "habitat": ter.habitat, "refugios": ter.refugios,
                    "sitios": [{k: s[k] for k in ("id", "x", "y", "mineral", "valor")} for s in ter.sitios],
                    "ortofoto": ("data:image/jpeg;base64," + base64.b64encode((carpeta / orto["archivo"]).read_bytes()).decode())
                    if orto else None,
                    "fuentes": {"elevacion": m["fuente_dem"], "ortofoto": orto["fuente"] if orto else None},
                    "superposiciones": superposiciones},
    }
    plantilla = (RAIZ / "demo/visor_plantilla.html").read_text(encoding="utf-8")
    html = plantilla.replace("/*__DATOS__*/null", json.dumps(datos, ensure_ascii=False, separators=(",", ":")).replace("</", "<\\/"))
    (RAIZ / "demo/visor_mision.html").write_text(html, encoding="utf-8")
    print(f"\n{len(log)} mensajes, {len(marcas)} marcadores, {resumen['muestras']} muestras, "
          f"destino {resumen['destino']['id']}, O2 final {resumen['O2_final_L']} L")
    print(f"logs/{nombre}.jsonl | logs/{nombre}.marcadores.json | demo/visor_mision.html")


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--guion", default="guion_mision.json")
    ap.add_argument("--fecha", default=datetime.date.today().isoformat())
    a = ap.parse_args()
    main(a.guion, a.fecha)
