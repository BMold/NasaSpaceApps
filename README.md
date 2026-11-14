# ARES-TWIN — planificador de caminatas en Marte (NASA Space Apps)

Planifica qué sitios científicos visita un astronauta en Mount Sharp (cráter Gale) y en qué orden, con el oxígeno como costo, y replanifica ante eventos en vivo. Trabaja sobre un paquete de terreno con datos reales de la NASA: topografía (USGS), imagen HiRISE, espectros CRISM e inercia térmica TES. El astronauta y los eventos son **simulados**: no hay telemetría real ni rover.

## Por dónde empezar

| Si eres… | Lee | Tu carpeta |
|---|---|---|
| Cualquiera | [contratos/INTEGRACION.md](contratos/INTEGRACION.md) | — |
| Dana (simulación de datos) | INTEGRACION §5.1 | [simulacion/](simulacion/) |
| Albert (backend) | INTEGRACION §5.3 y §7 | [backend/](backend/) |
| Frank (frontend) | INTEGRACION §3 y §5.4 | [front/](front/) |
| Luis (simulación 3D / VR) | INTEGRACION §3 y §5.4 | [vr/](vr/) |
| Ignacio (optimizador, datos) | [CLAUDE.md](CLAUDE.md) | `optimizador/`, `herramientas/` |

## Verlo funcionar

1. Abre `demo/visor_mision.html` con doble clic: la misión completa sobre la imagen real, con capas y botones de salto.
2. Comprueba que todo está en orden:

```
pip install numpy scipy jsonschema
python -m optimizador.pruebas.test_nucleo
python contratos/validar.py --terreno terreno/ logs/sesion-2026-11-13-mision.jsonl
```

## Carpetas

```
terreno/        paquete de datos REAL que usan todos (no editar a mano)
contratos/      INTEGRACION.md, esquemas JSON, validador y ejemplos
optimizador/    librería Python (Motor) y sus pruebas
herramientas/   scripts que construyen el terreno y el registro de misión
demo/           visor autónomo de referencia
logs/           conjunto de datos simulados de la misión (.jsonl) y marcadores de salto
datos_crudos/   descargas originales (no están en git; ver su LEEME.md)
simulacion/ backend/ front/ vr/    una carpeta por equipo
```

## Regenerar

```
python herramientas/construir_terreno.py     # terreno/ a partir de datos_crudos/
python herramientas/generar_registro.py      # logs/ y demo/visor_mision.html
```

Los scripts de `herramientas/` necesitan además `rasterio`, `pillow`, `tifffile`, `imagecodecs`, `zarr`, `requests` y `truststore`.
