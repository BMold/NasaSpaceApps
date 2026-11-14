# datos_crudos/ — descargas originales

Esta carpeta **no está en git** (pesa ~900 MB). Aquí se anota de dónde sale cada archivo para poder volver a bajarlo. De aquí se construye `terreno/` con `python herramientas/construir_terreno.py`.

| Carpeta | Archivo | Fuente | Se usa |
|---|---|---|---|
| `usgs/` | `dem_gale_1m_ventana.npy` + `.json` | Recorte de 540 × 540 m del USGS *Mars MSL Gale Merged DEM 1m v3* (`https://planetarymaps.usgs.gov/mosaic/Mars/MSL/MSL_Gale_DEM_Mosaic_1m_v3.tif`, 3,9 GB). Leído por rangos con `herramientas/gale.py` (46 MB transferidos). El `.json` guarda fila, columna y coordenadas del recorte. | Sí: elevación |
| `hirise/mrohr_0001/` | `rdr/esp/orb_087100_087199/esp_087149_1750/esp_087149_1750_color.jp2` | MRO HiRISE, RDR en color, observación `ESP_087149_1750` (2025-02-28), 0,25 m/px. PDS, volumen `mrohr_0001`. | Sí: ortofoto |
| `hirise/mrohr_0001/extras/` | `*.jp2`, `*.jpg` | Productos de vista rápida de la misma observación. | No |
| `crism/` | `frt0000b6f1_07_su165j_mtr3_bandas.npz` + `.hdr` + `.lbl` | 9 bandas del producto de parámetros de resumen MRO CRISM MTRDR `FRT0000B6F1_07_SU165J_MTR3` (PDS Geosciences, `mro-m-crism-5-rdr-mptargeted-v1`), 18 m/px. Leídas por rangos (20 MB de 133 MB). | Sí: capas `crism_*` y sitios |
| `crism/` | `CRISM_BD530_hematita.csv`, `CRISM_D2300_arcillas.csv` | Exportados de JMARS. Son **listas de observaciones** (identificadores y fechas), no valores de píxel. | Solo para localizar `FRT0000B6F1` |
| `tes/` | `tes_nb2007_gale.npz` | Recorte de 26 × 26 celdas del mapa nocturno de inercia térmica de MGS TES de Putzig y Mellon (2007), 20 px/grado (`https://se.psi.edu/inertia/2007/NBmap2007.bin`, 52 MB; leído por rangos). Longitud oeste positiva, sur primero. | Sí: capa `tes_inercia_termica` |
| `tes/` | `TES_Thermal_Inertia_numeric.tif` | Exportado de JMARS: inercia térmica de TES (valores 289–486). **Sin georreferencia**, y sus valores no coinciden con el mapa público de 2007, así que no se pudo situar. | No |

## Lo que falta

- **Variación térmica dentro de la ventana.** TES mide a ~3 km: toda la ventana cae en una sola celda (241). Para tener detalle haría falta THEMIS (100 m).

## Notas

- La descarga por rangos usa HTTPS con verificación completa. En este equipo el antivirus inspecciona el tráfico con su propio certificado; `herramientas/remoto.py` usa el almacén de certificados de Windows (`truststore`) para validarlo.
- HiRISE y CRISM vienen desplazados respecto al DEM de USGS. `herramientas/corregistro.py` mide ese desfase; las constantes resultantes están en `construir_terreno.py`.
