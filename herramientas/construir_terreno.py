"""Construye el paquete terreno/ con DATOS REALES de Gale (contratos/INTEGRACION.md §3).

    python herramientas/construir_terreno.py            # usa datos_crudos/ (ver datos_crudos/LEEME.md)
    python herramientas/construir_terreno.py --solo-tes # solo (re)escribe la capa TES en el paquete existente

Entradas (datos_crudos/):
    usgs/dem_gale_1m_ventana.npy + .json   recorte del USGS "Mars MSL Gale Merged DEM 1m v3" (herramientas/gale.py)
    hirise/.../esp_087149_1750_color.jp2   HiRISE RDR color (IR, RED, BG), 0,25 m/px
    crism/frt0000b6f1_07_su165j_mtr3_bandas.npz   parametros de resumen CRISM MTRDR, 18 m/px
    tes/tes_nb2007_gale.npz                 inercia termica nocturna de MGS TES (Putzig y Mellon 2007), 20 px/grado

Salida (terreno/): manifest.json, elevacion.bin, eta_terreno.bin, peligro.bin, pendiente_deg.bin, ortofoto.jpg,
crism_*.bin, tes_inercia_termica.bin, sitios.json, vista_previa.jpg, SHA256SUMS.

Marco local: origen = esquina SO de la ventana, x = Este, y = Norte, metros; fila 0 = sur en los .bin.
Todo es determinista: mismas entradas -> mismos bytes.
"""
import hashlib
import heapq
import json
import math
import sys
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw

try:  # la reconstruccion completa lo necesita; --solo-tes no
    import rasterio
    from rasterio.windows import Window
except ImportError:
    rasterio = Window = None
from scipy.ndimage import gaussian_filter, map_coordinates, median_filter

RAIZ = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(RAIZ))
from optimizador.constantes import N_MAX_SITIOS, VERSION      # noqa: E402
from optimizador.terreno import calcular_eta                  # noqa: E402

CRUDOS, SALIDA = RAIZ / "datos_crudos", RAIZ / "terreno"
R_MARTE = 3396190.0
TAM = 2.5                               # m por celda
LADO_M = 480.0                          # lado de la ventana (192 celdas)
PENDIENTE_BLOQUEO_DEG = 30.0            # celda no transitable a pie (supuesto de diseno)
PENDIENTE_SITIO_DEG = 15.0              # los sitios y el habitat se colocan en terreno mas suave

HIRISE = CRUDOS / "hirise/mrohr_0001/rdr/esp/orb_087100_087199/esp_087149_1750/esp_087149_1750_color.jp2"
CRISM = CRUDOS / "crism/frt0000b6f1_07_su165j_mtr3_bandas.npz"
TES = CRUDOS / "tes/tes_nb2007_gale.npz"      # recorte del mapa global TES (Putzig y Mellon 2007), 20 px/grado
CRISM_X0, CRISM_Y0, CRISM_TAM = 8138478.6, -278195.96, 18.0      # del .hdr (esquina sup. izq., m)

# Corregistro medido con herramientas/corregistro.py. El DEM de USGS (controlado a MOLA) es la referencia:
#   coordenada en el producto = coordenada DEM + desfase   (este, norte) en metros
REG_HIRISE = (-9.0, -136.0)       # NCC 0,43 (sin corregir: -0,02); precision ~1 m
REG_CRISM = (126.0, -90.0)        # NCC 0,38 (sin corregir: -0,12); precision ~9 m (medio pixel CRISM)

# Inercia termica de TES: mapa nocturno de Putzig y Mellon (2007), 20 px/grado, recortado a 26 x 26 celdas.
# Fila 0 del recorte = la mas al SUR; columnas en longitud OESTE creciente (datos_crudos/LEEME.md).
TES = CRUDOS / "tes/tes_nb2007_gale.npz"
TES_PX_DEG = 20


def capa_tes(x_sw, y_sw, n):
    """Inercia termica TES en cada celda (vecino mas cercano). Un pixel TES mide ~3 km: no se interpola,
    porque cualquier variacion dentro de la ventana seria inventada."""
    z = np.load(TES)
    ti = z["ti"].astype("<f4")
    f0, c0 = int(z["fila0"]), int(z["col0"])
    centros = (np.arange(n) + 0.5) * TAM
    lat = np.degrees((y_sw + centros) / R_MARTE)          # por fila (fila 0 = sur)
    lon_e = np.degrees((x_sw + centros) / R_MARTE)        # por columna
    filas = np.floor((lat + 90.0) * TES_PX_DEG).astype(int) - f0
    cols = np.floor((360.0 - lon_e) * TES_PX_DEG).astype(int) - c0
    if filas.min() < 0 or cols.min() < 0 or filas.max() >= ti.shape[0] or cols.max() >= ti.shape[1]:
        raise SystemExit("La ventana cae fuera del recorte TES de datos_crudos/tes/")
    a = ti[filas[:, None], cols[None, :]]
    info = {"archivo": "tes_inercia_termica.bin", "dtype": "float32", "unidad": "J m-2 K-1 s-1/2",
            "fuente": "MGS TES, mapa nocturno de inercia termica de Putzig y Mellon (2007), 20 px/grado (~3 km)",
            "resolucion_nativa_m": 2960.0,
            "descripcion": f"vecino mas cercano; la ventana cae en {len(np.unique(a))} pixel(es) TES, "
                           f"valor {', '.join(f'{v:.0f}' for v in np.unique(a))}: no hay detalle termico dentro de la ventana"}
    return a, info


def solo_tes():
    """Agrega o reemplaza la capa TES en el paquete existente sin tocar las demas capas."""
    m = json.loads((SALIDA / "manifest.json").read_text(encoding="utf-8"))
    g = m["georreferencia"]
    a, info = capa_tes(g["x_sw_m"], g["y_sw_m"], m["filas"])
    a.astype("<f4").tofile(SALIDA / info["archivo"])
    m["capas"]["tes_inercia_termica"] = info
    (SALIDA / "manifest.json").write_text(json.dumps(m, indent=2, ensure_ascii=False) + "\n", encoding="utf-8", newline="\n")
    # Solo cambian los hashes de lo que se escribio; los demas se conservan tal cual. En Windows, git puede haber
    # convertido los .json a CRLF en la copia local, y su hash ya no seria el del archivo del repo.
    ruta = SALIDA / "SHA256SUMS"
    sumas = {}
    if ruta.exists():
        for linea in ruta.read_text(encoding="utf-8").splitlines():
            if linea.strip():
                h, nombre = linea.split("  ", 1)
                sumas[nombre] = h
    for nombre in ("manifest.json", info["archivo"]):
        sumas[nombre] = hashlib.sha256((SALIDA / nombre).read_bytes()).hexdigest()
    ruta.write_text("".join(f"{h}  {nombre}\n" for nombre, h in sorted(sumas.items())), encoding="utf-8", newline="\n")
    print(f"terreno/{info['archivo']}: {info['descripcion']}")


# Clase del contrato -> parametros de resumen CRISM (Viviano-Beck et al. 2014) que la indican
INDICES = {
    "sulfatos": ["BD1900_2", "BD2100_2"],     # poli- y monohidratados
    "filosilicatos": ["D2300"],               # arcillas Fe/Mg
    "silice": ["BD2210_2"],                   # Si-OH / Al-OH a 2,21 um (ambiguo con arcillas de Al)
    "hematita": ["BD860_2"],                  # hematita cristalina
}
# Capas CRISM que se publican como contexto pero NO generan sitios
CONTEXTO_CRISM = {"BD530_2": "oxidos ferricos (banda de 0,53 um; alta en casi todo Marte por el polvo)"}
# Parametros operativos de cada parada: SUPUESTOS de escenario, no salen de los datos
MASA_KG, PERFORACION_MIN, VENTANA = 0.3, 15, [10.0, 14.0]


def rellenar_depresiones(z):
    """Priority-flood: superficie sin sumideros. z_rellena - z = profundidad de cada depresion cerrada."""
    F, C = z.shape
    lleno = np.full(z.shape, np.inf)
    visto = np.zeros(z.shape, bool)
    cola = []
    for i in range(F):
        for j in range(C):
            if i in (0, F - 1) or j in (0, C - 1):
                heapq.heappush(cola, (float(z[i, j]), i, j))
                visto[i, j] = True
    while cola:
        h, i, j = heapq.heappop(cola)
        lleno[i, j] = h
        for di in (-1, 0, 1):
            for dj in (-1, 0, 1):
                a, b = i + di, j + dj
                if 0 <= a < F and 0 <= b < C and not visto[a, b]:
                    visto[a, b] = True
                    heapq.heappush(cola, (max(h, float(z[a, b])), a, b))
    return lleno


def componentes(mascara):
    """Etiquetas de componentes conexas (vecindad 8) de una mascara booleana."""
    from scipy.ndimage import label
    return label(mascara, structure=np.ones((3, 3)))


def main():
    meta = json.loads((CRUDOS / "usgs/dem_gale_1m_ventana.json").read_text())
    dem = np.load(CRUDOS / "usgs/dem_gale_1m_ventana.npy").astype(np.float64)
    M, L_rec = meta["margen_px"], meta["lado_m"]
    # Ventana final: 480 m, centrada en el ancho valido de la tira HiRISE en color ya corregistrada (496 m en esta franja)
    L, DX, DY = LADO_M, 35.75, 10.0
    x_sw, y_sw = meta["x_sw_m"] + DX, meta["y_sw_m"] + DY  # marco equirectangular USGS (lon central 0)
    n = int(L / TAM)
    centros = (np.arange(n) + 0.5) * TAM                    # x o y local del centro de cada celda

    # 1) Elevacion a 2,5 m (suavizado anti-alias + bilineal); fila 0 = sur
    suave = gaussian_filter(dem, 1.0)
    X, Y = np.meshgrid(centros, centros)
    z = map_coordinates(suave, [M + (L_rec - (DY + Y)) - 0.5, M + DX + X - 0.5], order=1)
    z_ref = float(np.floor(z.min()))
    z_local = z - z_ref                                     # alturas relativas: mas comodas para el front

    # 2) Pendiente, eta y peligro
    gy, gx = np.gradient(z, TAM)
    pend = np.degrees(np.arctan(np.hypot(gx, gy)))
    eta = calcular_eta(z, TAM)
    peligro = (pend > PENDIENTE_BLOQUEO_DEG).astype(np.uint8)

    # 3) Ortofoto HiRISE (falso color IR-RED-BG), norte arriba
    with rasterio.open(HIRISE) as ds:
        hx0 = ds.transform.c + R_MARTE * math.pi            # lon central 180 -> 0
        hy0, px = ds.transform.f, ds.transform.a
        col0 = int(round((x_sw + REG_HIRISE[0] - hx0) / px))
        fil0 = int(round((hy0 - (y_sw + L + REG_HIRISE[1])) / px))
        lado = int(round(L / px))
        img = ds.read(window=Window(col0, fil0, lado, lado)).astype(np.float64)
        producto_hirise = "ESP_087149_1750_COLOR (MRO HiRISE RDR, 2025-02-28)"
    assert img.shape == (3, lado, lado) and (img > 0).all(), "la ventana se sale de la imagen HiRISE en color"
    rgb = np.stack([np.clip((b - np.percentile(b, 0.5)) / (np.percentile(b, 99.5) - np.percentile(b, 0.5)), 0, 1)
                    for b in img], -1) ** 0.85
    orto = Image.fromarray((rgb * 255).round().astype(np.uint8))

    # 4) CRISM: vecino mas cercano a la malla (18 m nativos -> 2,5 m); NaN = sin dato
    bandas = np.load(CRISM)
    cx0, cy0 = CRISM_X0 - REG_CRISM[0], CRISM_Y0 - REG_CRISM[1]   # origen CRISM en el marco del DEM
    cc = np.floor((x_sw + X - cx0) / CRISM_TAM).astype(int)
    cf = np.floor((cy0 - (y_sw + Y)) / CRISM_TAM).astype(int)
    capas_crism, estad = {}, {}
    for nombre in sorted({b for v in INDICES.values() for b in v} | set(CONTEXTO_CRISM)):
        b = bandas[nombre]
        capas_crism[nombre] = b[cf, cc].astype(np.float32)
        ok = b[np.isfinite(b)]
        estad[nombre] = {"p90": float(np.percentile(ok, 90)), "p999": float(np.percentile(ok, 99.9))}

    # 4b) Inercia termica TES: mapa de 0,05 grados (~3 km), oeste positivo, sur primero. Vecino mas cercano.
    tes = np.load(TES)
    lon_e = np.degrees((x_sw + X) / R_MARTE)
    lat = np.degrees((y_sw + Y) / R_MARTE)
    tf = np.floor((lat + 90.0) * 20).astype(int) - int(tes["fila0"])
    tc = np.floor((360.0 - lon_e) * 20).astype(int) - int(tes["col0"])
    inercia = tes["ti"][tf, tc].astype(np.float32)
    inercia[inercia == 0] = np.nan

    # 5) Habitat: celda mas llana (media de pendiente en 15 m) del tercio central
    pend_media = gaussian_filter(pend, 15.0 / TAM / 2)
    centro = np.zeros_like(pend, bool)
    centro[n // 3: 2 * n // 3, n // 3: 2 * n // 3] = True
    hi, hj = np.unravel_index(np.argmin(np.where(centro & (peligro == 0), pend_media, np.inf)), pend.shape)
    hab = {"id": "H", "x": float(centros[hj]), "y": float(centros[hi])}

    # celdas alcanzables desde el habitat sin pisar bloqueos
    etiquetas, _ = componentes(peligro == 0)
    alcanzable = etiquetas == etiquetas[hi, hj]

    # 6) Sitios: maximos locales de cada indice CRISM (suavizado 3x3 en su malla) por encima del p90 de la escena
    candidatos = []
    for clase, nombres in INDICES.items():
        for nombre in nombres:
            b = median_filter(np.nan_to_num(bandas[nombre], nan=-1.0), size=3)
            p90, p999 = estad[nombre]["p90"], estad[nombre]["p999"]
            umbral = max(p90, 0.0)
            c_min, c_max = int((x_sw - cx0) // CRISM_TAM) + 1, int((x_sw + L - cx0) // CRISM_TAM) - 1
            f_min, f_max = int((cy0 - (y_sw + L)) // CRISM_TAM) + 1, int((cy0 - y_sw) // CRISM_TAM) - 1
            for f in range(f_min, f_max + 1):
                for c in range(c_min, c_max + 1):
                    v = b[f, c]
                    if v <= umbral or v < b[f - 1:f + 2, c - 1:c + 2].max():
                        continue
                    x = cx0 + (c + 0.5) * CRISM_TAM - x_sw
                    y = cy0 - (f + 0.5) * CRISM_TAM - y_sw
                    fuerza = min(1.0, (v - p90) / (p999 - p90))
                    candidatos.append((fuerza, clase, nombre, float(v), x, y))
    candidatos.sort(key=lambda t: (-t[0], t[1], t[4], t[5]))

    buenos = alcanzable & (pend <= PENDIENTE_SITIO_DEG)
    bi, bj = np.nonzero(buenos)
    sitios, por_clase = [], {}
    for fuerza, clase, nombre, v, x, y in candidatos:
        if len(sitios) >= N_MAX_SITIOS:
            break
        if por_clase.get(clase, 0) >= 5:
            continue
        k = np.argmin((centros[bj] - x) ** 2 + (centros[bi] - y) ** 2)       # celda buena mas cercana
        sx, sy = float(centros[bj[k]]), float(centros[bi[k]])
        if math.hypot(sx - x, sy - y) > CRISM_TAM:                             # debe caer en el mismo pixel CRISM
            continue
        if not (15 <= sx <= L - 15 and 15 <= sy <= L - 15) or math.hypot(sx - hab["x"], sy - hab["y"]) < 40:
            continue
        if any(math.hypot(sx - s["x"], sy - s["y"]) < 45 for s in sitios):
            continue
        lon, lat = math.degrees((x_sw + sx) / R_MARTE), math.degrees((y_sw + sy) / R_MARTE)
        por_clase[clase] = por_clase.get(clase, 0) + 1
        sitios.append({"id": len(sitios) + 1, "x": sx, "y": sy, "valor": int(round(1 + 9 * fuerza)), "mineral": clase,
                       "masa_kg": MASA_KG, "perforacion_min": PERFORACION_MIN, "ventana": list(VENTANA),
                       "lon": round(lon, 6), "lat": round(lat, 6),
                       "fuente": f"CRISM FRT0000B6F1 {nombre} = {v:.4f} (p90 de la escena {estad[nombre]['p90']:.4f})"})

    # 7) Refugios: depresiones cerradas reales del DEM (>= 1 m de profundidad y >= 50 m2)
    prof = rellenar_depresiones(z) - z
    etq, n_dep = componentes(prof > 0.25)
    refugios = []
    for k in range(1, n_dep + 1):
        m = etq == k
        if prof[m].max() < 1.0 or m.sum() * TAM * TAM < 50 or not (m & alcanzable).any():
            continue
        i, j = np.unravel_index(np.argmax(np.where(m & alcanzable, prof, -1)), prof.shape)
        refugios.append({"id": f"d{len(refugios) + 1}", "x": float(centros[j]), "y": float(centros[i]),
                         "radio_m": round(math.sqrt(m.sum() * TAM * TAM / math.pi), 1),
                         "profundidad_m": round(float(prof[m].max()), 1)})

    # 8) Escribir
    SALIDA.mkdir(exist_ok=True)
    for viejo in SALIDA.iterdir():
        viejo.unlink()
    z_local.astype("<f4").tofile(SALIDA / "elevacion.bin")
    eta.astype("<f4").tofile(SALIDA / "eta_terreno.bin")
    peligro.tofile(SALIDA / "peligro.bin")
    pend.astype("<f4").tofile(SALIDA / "pendiente_deg.bin")
    orto.save(SALIDA / "ortofoto.jpg", quality=90)
    fuente_dem = "USGS Astrogeology, Mars MSL Gale Merged DEM 1m v3 (HRSC/CTX/HiRISE sobre MOLA)"
    fuente_crism = "MRO CRISM MTRDR FRT0000B6F1_07_SU165J_MTR3 (PDS Geosciences), 18 m/px"
    capas = {
        "elevacion": {"archivo": "elevacion.bin", "dtype": "float32", "unidad": "m", "fuente": fuente_dem,
                      "resolucion_nativa_m": 1.0, "descripcion": f"altura sobre z_ref = {z_ref:.0f} m (areoide MOLA)"},
        "eta_terreno": {"archivo": "eta_terreno.bin", "dtype": "float32", "rango": [1, 2], "fuente": "derivada de elevacion",
                        "descripcion": "desviacion tipica de la pendiente en ventana 3x3, normalizada a [1, 2]"},
        "peligro": {"archivo": "peligro.bin", "dtype": "uint8", "valores": {"0": "libre", "1": "bloqueo"},
                    "fuente": "derivada de elevacion", "descripcion": f"pendiente > {PENDIENTE_BLOQUEO_DEG:.0f} grados"},
        "pendiente_deg": {"archivo": "pendiente_deg.bin", "dtype": "float32", "unidad": "grados", "fuente": "derivada de elevacion"},
        "ortofoto": {"archivo": "ortofoto.jpg", "formato": "jpg", "filas": lado, "columnas": lado, "tam_celda_m": px,
                     "fuente": producto_hirise, "resolucion_nativa_m": px,
                     "descripcion": "falso color (R,G,B) = (IR, RED, BG); fila 0 de la imagen = NORTE; estirada por percentiles"},
    }
    for nombre, a in capas_crism.items():
        archivo = f"crism_{nombre.lower()}.bin"
        a.astype("<f4").tofile(SALIDA / archivo)
        clase = next((c for c, v in INDICES.items() if nombre in v), None)
        que = f"indicio de {clase}" if clase else f"contexto: {CONTEXTO_CRISM[nombre]}"
        capas[f"crism_{nombre.lower()}"] = {
            "archivo": archivo, "dtype": "float32", "sin_dato": "nan", "fuente": fuente_crism, "resolucion_nativa_m": CRISM_TAM,
            "descripcion": f"parametro de resumen {nombre} (indicio de {clase}); p90 de la escena = {estad[nombre]['p90']:.4f}"}
    if TES.exists():
        tes, info_tes = capa_tes(x_sw, y_sw, n)
        tes.astype("<f4").tofile(SALIDA / info_tes["archivo"])
        capas["tes_inercia_termica"] = info_tes
            "descripcion": f"parametro de resumen {nombre} ({que}); p90 de la escena = {estad[nombre]['p90']:.4f}"}
    inercia.astype("<f4").tofile(SALIDA / "tes_inercia_termica.bin")
    capas["tes_inercia_termica"] = {
        "archivo": "tes_inercia_termica.bin", "dtype": "float32", "sin_dato": "nan", "unidad": "J m-2 K-1 s-1/2",
        "fuente": "MGS TES, mapa nocturno de inercia termica de Putzig y Mellon (2007), 20 px/grado (se.psi.edu/inertia/2007)",
        "resolucion_nativa_m": 2960.0,
        "descripcion": f"inercia termica aparente; la ventana cae en una sola celda TES: {float(np.nanmean(inercia)):.0f}"}
    manifest = {
        "version": VERSION,
        "sitio": "Mount Sharp (Aeolis Mons), crater Gale, Marte: unidad de sulfatos, ladera norte",
        "fuente_dem": fuente_dem,
        "origen": {"x": 0.0, "y": 0.0, "nota": "esquina suroeste de la ventana"},
        "marco": "ENU local (x = Este, y = Norte, z = arriba), metros",
        "tam_celda_m": TAM, "filas": n, "columnas": n, "fila_0": "sur",
        "z_ref_m": z_ref,
        "georreferencia": {"proyeccion": "equirectangular, latitud estandar 0, longitud central 0, positiva al este",
                           "radio_m": R_MARTE,
                           "esquina_sw": {"lon_este_deg": round(math.degrees(x_sw / R_MARTE), 6), "lat_deg": round(math.degrees(y_sw / R_MARTE), 6)},
                           "esquina_ne": {"lon_este_deg": round(math.degrees((x_sw + L) / R_MARTE), 6), "lat_deg": round(math.degrees((y_sw + L) / R_MARTE), 6)},
                           "x_sw_m": x_sw, "y_sw_m": y_sw},
        "capas": capas,
        "sitios": "sitios.json",
        "habitat": hab,
        "contexto": {"inercia_termica_tiu": float(np.nanmean(inercia)),
                     "nota": "un unico valor TES para toda la ventana (~3 km/celda): describe el tipo de superficie, no cambia la ruta"},
        "corregistro": {"referencia": "DEM de USGS", "nota": "coordenada en el producto = coordenada DEM + desfase (este, norte), m",
                        "hirise_m": list(REG_HIRISE), "crism_m": list(REG_CRISM), "precision_m": {"hirise": 1, "crism": 9}},
        "supuestos": {"pendiente_bloqueo_deg": PENDIENTE_BLOQUEO_DEG, "pendiente_max_sitio_deg": PENDIENTE_SITIO_DEG,
                      "sitios": "maximos locales de cada indice CRISM por encima del p90 de la escena; valor = 1 + 9*(v - p90)/(p99.9 - p90); "
                                "masa, perforacion y ventana son supuestos de escenario; habitat = celda mas llana del tercio central"},
    }
    if refugios:
        manifest["refugios"] = refugios
    (SALIDA / "manifest.json").write_text(json.dumps(manifest, indent=2, ensure_ascii=False) + "\n", encoding="utf-8", newline="\n")
    (SALIDA / "sitios.json").write_text(json.dumps({"version": VERSION, "sitios": sitios}, indent=2, ensure_ascii=False) + "\n",
                                        encoding="utf-8", newline="\n")
    campos = ("id", "x", "y", "valor", "mineral", "masa_kg", "perforacion_min", "ventana")
    pedido = {"version": VERSION, "inicio": {"x": hab["x"], "y": hab["y"]}, "hora_solar": 10.0, "O2_disponible_L": 170.0,
              "capacidad_kg": 5.0, "sitios": [{k: s_[k] for k in campos} for s_ in sitios]}
    (RAIZ / "contratos/ejemplos/pedido.json").write_text(json.dumps(pedido, indent=2, ensure_ascii=False) + "\n", encoding="utf-8", newline="\n")

    # vista previa: ortofoto con bloqueos, sitios, habitat y refugios
    esc = 2
    v = orto.resize((n * esc * 2, n * esc * 2), Image.LANCZOS).convert("RGBA")
    capa = Image.fromarray(np.dstack([np.full((n, n), 240), np.full((n, n), 68), np.full((n, n), 58),
                                      peligro[::-1] * 110]).astype(np.uint8)).resize(v.size, Image.NEAREST)
    v = Image.alpha_composite(v, capa)
    d = ImageDraw.Draw(v)
    k = v.size[0] / L
    P = lambda x, y: (x * k, (L - y) * k)
    color = {"filosilicatos": "#7F77DD", "sulfatos": "#D4537E", "hematita": "#712B13", "silice": "#378ADD"}
    for r in refugios:
        cx, cy = P(r["x"], r["y"])
        d.ellipse([cx - r["radio_m"] * k, cy - r["radio_m"] * k, cx + r["radio_m"] * k, cy + r["radio_m"] * k], outline="white", width=2)
        d.text((cx + 6, cy + 6), r["id"], fill="white")
    for s in sitios:
        cx, cy = P(s["x"], s["y"])
        d.ellipse([cx - 9, cy - 9, cx + 9, cy + 9], fill=color[s["mineral"]], outline="white", width=2)
        d.text((cx + 12, cy - 8), f"{s['id']} ({s['valor']})", fill="white")
    cx, cy = P(hab["x"], hab["y"])
    d.rectangle([cx - 9, cy - 9, cx + 9, cy + 9], fill="white")
    d.text((cx - 4, cy - 6), "H", fill="black")
    v.convert("RGB").save(SALIDA / "vista_previa.jpg", quality=88)

    sumas = "".join(f"{hashlib.sha256(f.read_bytes()).hexdigest()}  {f.name}\n" for f in sorted(SALIDA.iterdir()))
    (SALIDA / "SHA256SUMS").write_text(sumas, encoding="utf-8", newline="\n")

    print(f"terreno/: {n}x{n} celdas de {TAM} m | z local 0..{z_local.max():.1f} m (z_ref {z_ref:.0f}) | "
          f"pendiente media {pend.mean():.1f} grados | bloqueadas {100 * peligro.mean():.1f} % | alcanzables {100 * alcanzable.mean():.1f} %")
    print(f"habitat {hab} | refugios {refugios}")
    for nombre, e in estad.items():
        a = capas_crism[nombre]
        print(f"  {nombre:9s} ventana p50/p95/max = {np.nanpercentile(a, 50):.4f} / {np.nanpercentile(a, 95):.4f} / {np.nanmax(a):.4f}"
              f"   escena p90 = {e['p90']:.4f}, p99.9 = {e['p999']:.4f}")
    for s in sitios:
        print(f"  sitio {s['id']:2d} ({s['x']:6.1f}, {s['y']:6.1f}) valor {s['valor']:2d} {s['mineral']:13s} {s['fuente']}")
    print(f"  inercia termica TES: {np.nanmin(inercia):.0f}..{np.nanmax(inercia):.0f}")
    print("candidatos:", len(candidatos), "| por clase:", por_clase)


if __name__ == "__main__":
    solo_tes() if "--solo-tes" in sys.argv else main()
