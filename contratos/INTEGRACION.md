# Contrato de integración — ARES-TWIN (v1.0, a congelar el 2026-11-18)

Qué envía y qué recibe **cada parte** del sistema, sobre **los mismos datos reales**. Complementa a `CLAUDE.md`, que sigue mandando en constantes, algoritmo y reglas de negocio.

- **Fuente de verdad:** los esquemas de [`schemas/`](schemas/) y el validador [`validar.py`](validar.py). Si este texto contradice un esquema, manda el esquema.
- **Estados:** **[Implementado]** existe en el repo y tiene prueba · **[Propuesta]** no existe; la acepta o ajusta su dueño antes del 18-nov.
- **Alcance de v1:** terreno con datos reales de topografía, imagen óptica y espectral. Sin radiación (decisión 2026-11-12). Capa térmica pendiente (§3.1).

---

## 1. El sistema de un vistazo

```
                 DATOS COMPARTIDOS:  terreno/   (solo lectura, un único paquete)
     ┌────────────────┬──────────────────┬──────────────────┬───────────────────┐
     ▼                ▼                  ▼                  ▼                   ▼
 TELEMETRIA        OPTIMIZADOR         BACKEND           FRONTEND        SIMULACION 3D / VR
 (Dana, Erick)     (Ignacio)           (Albert)          (Frank)         (Luis)

 perfil, eventos, hitos ─────────────►  BACKEND ──► Motor.procesar_evento()
                                          │  ◄──────── [estado_aborto, plan_actualizado, abortar]
 plan_actualizado, abortar ◄──────────────┤
                                          ├──────► TODOS los mensajes, en orden (frames) ──► FRONTEND y VR
                                          ◄────────────────── control (solo en reproducción) ◄──┘
                                          └──► logs/sesion-<fecha>.jsonl  +  .marcadores.json
```

| Parte | Dueño | Carpeta | Papel |
|---|---|---|---|
| Datos / terreno | Ignacio | `terreno/`, `herramientas/` | Paquete único de capas reales. Todos lo leen. |
| Optimizador | Ignacio | `optimizador/` | Planifica, calcula márgenes de aborto, replanifica. |
| Telemetría | Dana, Erick | `telemetria/` | Genera biodatos y eventos; **única que descuenta el O₂**; hace que el astronauta siga el plan. |
| Backend | Albert | `backend/` | Orquesta, difunde, registra, reproduce. |
| Frontend | Frank | `front/` | Mapa por capas y HUD. **No calcula nada.** |
| Simulación 3D / VR | Luis | `vr/` | Escena 3D y recorrido en casco. **No calcula nada.** |

Frontend y VR son, para el contrato, el mismo papel: **vistas**. Reciben lo mismo y obedecen las mismas reglas.

## 2. Reglas de oro

1. **Un solo paquete de terreno.** Nadie guarda copia propia ni lo edita a mano; se regenera con `herramientas/construir_terreno.py`.
2. **Un solo dueño de cada número:** la telemetría descuenta el O₂; el optimizador predice planes y márgenes; las vistas solo muestran lo que viene en un mensaje.
3. Todo mensaje: JSON UTF-8, `snake_case`, `"version": "1.0"`. Campos nuevos = **aditivos**. Quien no entienda un `tipo` o un campo lo **ignora**. Cambio incompatible → `"2.0"`.
4. Tiempo: `t` en segundos simulados desde el inicio de la EVA; `hora_solar = t0_hora_solar + t/3699`.
5. Orden: `seq` creciente de 1 en 1 por emisor. El orden total de una sesión es el del registro (§5.6).
6. Todo se valida: `python contratos/validar.py <archivo>` (§10).

---

## 3. Datos compartidos: el paquete `terreno/` [Implementado]

**Lugar:** ladera norte de Mount Sharp (Aeolis Mons), cráter Gale, en la unidad de sulfatos. Ventana de **480 × 480 m**, esquina SO en 137,408172° E, −4,827169°; esquina NE en 137,416269° E, −4,819071°. Malla de **192 × 192 celdas de 2,5 m**.

El lado es 480 m y no 1 km porque la imagen HiRISE en color solo tiene ~495 m de ancho útil en esa franja.

### 3.1 Contenido

| Archivo | Qué es | Fuente |
|---|---|---|
| `manifest.json` | Describe el paquete (§3.3) | `construir_terreno.py` |
| `elevacion.bin` | Altura [m] sobre `z_ref_m` (−3420 m, areoide MOLA), float32. Rango 0–84,8 m | USGS *Mars MSL Gale Merged DEM 1m v3*, suavizado y remuestreado a 2,5 m |
| `pendiente_deg.bin` | Pendiente [grados], float32. Media 8,9° | derivada del DEM |
| `eta_terreno.bin` | Factor de terreno η ∈ [1, 2], float32 | derivada del DEM: desviación típica de la pendiente en ventana 3 × 3, normalizada |
| `peligro.bin` | 0 libre · 1 bloqueo, uint8. 0,9 % de las celdas | pendiente > 30° (supuesto de diseño) |
| `ortofoto.jpg` | Imagen 1920 × 1920 a 0,25 m/px, **fila 0 = norte**. Falso color (R, G, B) = (IR, RED, BG) | MRO HiRISE `ESP_087149_1750_COLOR`, 2025-02-28 |
| `crism_bd1900_2.bin`, `crism_bd2100_2.bin` | Indicio de sulfatos poli- y monohidratados, float32, NaN = sin dato | MRO CRISM MTRDR `FRT0000B6F1_07_SU165J_MTR3`, 18 m/px |
| `crism_d2300.bin` | Indicio de filosilicatos de Fe/Mg | ídem |
| `crism_bd2210_2.bin` | Indicio de sílice hidratada (débil; ambiguo con arcillas de Al) | ídem |
| `crism_bd860_2.bin` | Indicio de hematita. **Sin señal en esta ventana** (máximo ≈ 0) | ídem |
| `sitios.json` | 11 sitios científicos (§3.4) | derivados de las capas CRISM |
| `vista_previa.jpg` | Ortofoto con bloqueos, sitios y hábitat, para comprobar de un vistazo | — |
| `SHA256SUMS` | Huellas de todos los archivos | — |

**Capa térmica: pendiente.** El archivo descargado (`TES_Thermal_Inertia_numeric.tif`) no trae georreferencia, así que no se puede situar; además TES mide a ~3 km/píxel, es decir, un único valor para toda la ventana. Para incluirla hace falta re-exportarla de JMARS con sus archivos `.prj`/`.txt`, o usar THEMIS (100 m).

Las capas CRISM tienen 18 m nativos y se remuestrean por vecino más cercano: son **contexto**, no precisión de metros. El optimizador no las lee; solo determinan los sitios.

### 3.2 Marco de coordenadas [Implementado]

- **Local ENU en metros.** Origen `(0, 0)` = esquina **suroeste** de la ventana. `x` = Este, `y` = Norte, `z` = arriba.
- **Capas `.bin`:** `fila_0 = "sur"`. Centro de la celda `(i, j)`: `x = (j + 0.5)·2.5`, `y = (i + 0.5)·2.5`. Orden fila por fila, little-endian. **La ortofoto es una imagen normal: fila 0 = norte.**
- **Georreferencia** (`manifest.georreferencia`): equirectangular de Marte, radio 3 396 190 m, latitud estándar 0, longitud central 0 y positiva al este. `lon = (x_sw_m + x)/R`, `lat = (y_sw_m + y)/R` en radianes.
- **Corregistro** (`manifest.corregistro`): el DEM de USGS (atado a MOLA) es la referencia. HiRISE y CRISM venían desplazados y se corrigieron: HiRISE −9 m este / −136 m norte (precisión ~1 m); CRISM +126 m este / −90 m norte (precisión ~9 m). Medido con `herramientas/corregistro.py`.
- **Eje vertical:** sin exageración en los datos. La conversión a la escena 3D la deciden Luis y Frank; sugerencia: `(x_escena, y_escena, z_escena) = (x, elevación, −y)`. **[Propuesta]**
- Las vistas pegan la ruta al terreno con raycast sobre su propia malla, usando **solo `x`, `y`**.

### 3.3 `manifest.json`

Esquema: `schemas/manifest.json`. Obligatorios: `sitio`, `fuente_dem`, `origen`, `marco`, `tam_celda_m`, `filas`, `columnas`, `fila_0`, `capas` (con `elevacion`), `habitat`. Además trae `z_ref_m`, `georreferencia`, `corregistro`, `supuestos` y, cuando existan, `refugios`.

Cada entrada de `capas` lleva `archivo`, `dtype` (o `formato` para imágenes), `fuente`, `resolucion_nativa_m` y `descripcion`. El hábitat está en `(238.75, 231.25)`: la celda más llana del tercio central.

**En esta ventana no hay `refugios`:** el DEM no tiene depresiones cerradas de al menos 1 m. El aborto por tormenta va al hábitat. La clave sigue soportada para otros terrenos.

### 3.4 `sitios.json`

`{ "version": "1.0", "sitios": [ … ] }`, máximo 12. Cada sitio: `id`, `x`, `y`, `valor` (1–10), `mineral`, `masa_kg`, `perforacion_min`, `ventana` `[ini_h, fin_h]` en hora solar; además `lon`, `lat` y `fuente` (índice CRISM y su valor).

**Criterio (documentado en `manifest.supuestos`):** cada sitio es un máximo local de un índice CRISM por encima del percentil 90 de la escena, colocado en una celda alcanzable con pendiente ≤ 15°. `valor = 1 + 9·(v − p90)/(p99,9 − p90)`. Resultado: 5 de sulfatos (valor 3–10), 1 de filosilicatos (4) y 5 de sílice (1–2).

`masa_kg` (0,3), `perforacion_min` (15) y `ventana` ([10, 14]) son **supuestos de escenario**, iguales para todos. El `valor` es un criterio nuestro, no una prioridad de la NASA.

### 3.5 Quién lee qué

| Parte | Cómo lee el terreno |
|---|---|
| Optimizador | `Terreno.cargar(ruta)`. Lee `elevacion`, `eta_terreno`, `peligro`, `sitios`, `habitat`, `refugios`; **ignora las demás capas**. |
| Telemetría | La misma clase `Terreno` (`z(x, y)`, `celda`, `eta`) y `pandolf()` / `potencia()`. Si no es Python: los `.bin` y la fórmula de CLAUDE.md §8.2. |
| Backend | Sirve los archivos **tal cual** por HTTP (§7). No los transforma. [Propuesta] |
| Frontend | Ortofoto como base, capas `crism_*` y `pendiente_deg` como superposiciones, `sitios.json`, hábitat. |
| Simulación 3D / VR | Malla desde `elevacion.bin`, `ortofoto.jpg` como textura (ojo: fila 0 = norte). |

Lectura en JavaScript: `new Float32Array(buffer)` da `filas × columnas` valores; el índice de la celda `(i, j)` es `i·columnas + j`. Ejemplo completo en `demo/visor_plantilla.html`.

### 3.6 Congelación

`SHA256SUMS` identifica el paquete. Cambiar el terreno implica regenerar sitios, registro y marcadores, porque todas las coordenadas dependen de él: `construir_terreno.py` y luego `generar_registro.py`.

---

## 4. Catálogo de mensajes

| Mensaje | De → a | Esquema | Estado |
|---|---|---|---|
| `perfil` | Telemetría → Backend → Optimizador | `perfil` | [Implementado] |
| `telemetria_astronauta` | Telemetría → Backend → Optimizador, vistas | `telemetria_astronauta` | [Implementado] |
| `telemetria_rover` | Telemetría → Backend → vistas (el optimizador lo ignora) | `telemetria_rover` | [Implementado] |
| `peligro` | Telemetría → Backend → Optimizador, vistas | `peligro` | [Implementado] |
| `ventanas` | Telemetría → Backend → Optimizador, vistas | `ventanas` | [Implementado] |
| `SPE` | Telemetría → Backend → Optimizador, vistas | `spe` | [Implementado] |
| `hito` | Telemetría → Backend → vistas (el optimizador lo ignora) | `hito` | [Implementado] en el generador · la telemetría debe emitirlo |
| `pedido` | Backend / herramienta → Optimizador | `pedido` | [Implementado] |
| plan (respuesta del pedido) | Optimizador → quien pidió | `plan` | [Implementado] |
| `plan_actualizado` | Optimizador → Backend → Telemetría, vistas | `plan_actualizado` | [Implementado] |
| `abortar` | Optimizador → Backend → Telemetría, vistas | `abortar` | [Implementado] (incluye `destino`) |
| `estado_aborto` | Optimizador → Backend → vistas | `estado_aborto` | [Implementado] |
| `marcadores` (archivo) | Generador → Backend → vistas | `marcadores` | [Implementado] |
| `control` | Vistas → Backend (solo reproducción) | `control` | [Propuesta] |
| `reinicio` | Backend → vistas | `reinicio` | [Propuesta] |
| `error` | Backend / Optimizador → emisor | `error` | [Propuesta] |
| `frame` (envoltura del WebSocket) | Backend → vistas | `frame` | [Propuesta] |

Los eventos de la telemetría llevan el envoltorio `{version, t, hora_solar, seq, tipo, datos}`; los del optimizador, `{version, tipo, t, …}`. Los campos exactos están en los esquemas y en CLAUDE.md §10–11.

---

## 5. Qué envía y qué recibe cada parte

### 5.1 Telemetría (Dana, Erick)

**Envía**
- `perfil`, **una vez y antes de todo**; reinicia la sesión (`semilla` y `factor_tiempo` van aquí).
- `telemetria_astronauta` y `telemetria_rover` cada 10 s simulados.
- `peligro`, `ventanas`, `SPE` cuando lo marque el guion. `peligro` con `radio_m: 0` y el mismo `id` lo quita.
- `hito`: `llegada` al alcanzar una parada, `muestra` al cumplirse su `salida_s`, `fin` al llegar al destino final (con `destino` y `O2_restante_L`). Alimentan el panel de objetivos y los marcadores.
- `seq` empieza en 1 y sube de 1 en 1 **solo en los eventos**; `hito` no consume `seq`.
- Orden dentro de un mismo instante `t`: primero `hito`, luego telemetría, luego el resto de eventos.

**Recibe** (a través del backend): **solo** `plan_actualizado` y `abortar`.
- Sigue la polilínea del último plan interpolando con `llegada_s` y se queda `perforacion_min` en cada parada.
- Tras un `abortar` sigue `ruta_escape` hasta `destino`.
- Mientras no haya plan, permanece en el hábitat.
- Consumo: `pandolf()` / `potencia()` del paquete `optimizador`; en reposo, ~250 W. Determinista con la `semilla`.

**Hueco conocido:** el plan no trae la hora de llegada al hábitat, así que el último tramo no se puede interpolar con `llegada_s`. La implementación de referencia (`optimizador/pruebas/simular_guion.py`) usa 0,6 m/s fijos. Esa misma implementación es el punto de partida recomendado: ya cumple todo este apartado, sin ruido.

### 5.2 Optimizador (Ignacio)

**Recibe:** `perfil`, `telemetria_astronauta`, `peligro`, `ventanas`, `SPE` (vía `Motor.procesar_evento`) y `pedido` (vía `Motor.planificar`). **Ignora** `telemetria_rover`, `hito` y cualquier tipo desconocido (devuelve lista vacía).

**Envía** (lista por evento):

| Evento | Salida |
|---|---|
| `telemetria_astronauta` | `[estado_aborto]` (+ `plan_actualizado` o `abortar`) |
| `peligro`, `ventanas` | `[plan_actualizado]` o `[]` |
| `SPE` `alerta` | `[plan_actualizado]` (ρ = 0,25) |
| `SPE` `critico` | `[abortar]` |
| `telemetria_rover`, `hito`, desconocido | `[]` |

**Garantías:** telemetría < 5 ms · cualquier otra llamada ≤ 2 s · siempre hay `ruta_escape` · **determinista** con la misma entrada, en cualquier máquina (el solver corta por número de nodos, no por reloj) · ninguna ruta pisa una celda de `peligro` · una sesión y **una llamada a la vez** (eventos en orden de `seq`, `cargar_perfil` primero, llamadas lentas en un hilo aparte). Las excepciones `PedidoInvalido`, `VersionNoSoportada` y `SinPerfil` se publican como `error` (§7).

**Brecha conocida:** `SPE.llegada_s` aún **no se usa**; hoy una alerta solo sube la reserva. Falta exigir que el plan permita llegar a destino antes de ese instante.

**Interfaz:** `Motor` dentro del proceso del backend (Python) [Implementado]. Si el backend no es Python: servicio FastAPI en `:8001` — `POST /perfil`, `POST /plan`, `POST /evento`, `GET /estado` [Propuesta, no implementado].

### 5.3 Backend (Albert) — todo es **[Propuesta]**; lo define Albert

- **Recibe** de la telemetría (WebSocket) `perfil`, eventos e `hito`; de las vistas, `control`.
- **Para cada evento:** lo pasa al `Motor` en orden de `seq` (de a uno, en un hilo aparte), recoge la lista de salida y mantiene el orden.
- **Reenvía** a la telemetría solo `plan_actualizado` y `abortar`.
- **Difunde** a las vistas **todos** los mensajes, en el orden del registro, dentro de un `frame` con su `idx`.
- **Registra** una línea JSON por mensaje en `logs/sesion-<fecha>.jsonl`, en el mismo orden que `idx`; al cerrar, escribe los marcadores. Hoy los genera `simular_guion.py` con los títulos del guion; falta una versión que los derive solo del `.jsonl` (por `motivo` e `hito`).
- **Reproduce** un `.jsonl` con ritmo `factor` (segundos simulados por segundo real) y atiende `control`.
- **Sirve** el terreno (§7). **Traduce** errores a `error`.

### 5.4 Vistas: Frontend (Frank) y Simulación 3D / VR (Luis)

**Reciben:** el terreno por HTTP; los frames por WebSocket; los marcadores por HTTP. **No calculan nada.** En reproducción envían `control`.

| Elemento en pantalla | Sale de |
|---|---|
| Posición del astronauta | `telemetria_astronauta.datos.x, y` (se interpola entre dos telemetrías) |
| Hora solar | `telemetria_astronauta.hora_solar` |
| Barra de O₂ y su línea mínima | `estado_aborto.O2_restante_L` y `O2_minimo_L` |
| Color de seguridad | `estado_aborto.margen_pct`: > 30 verde · 15–30 ámbar · ≤ 15 rojo. Junto al hábitat el margen es enorme: mostrar "> 999 %" |
| Ruta por recorrer | `plan.polilinea` del último `plan_actualizado` (la anterior se desvanece 2 s) |
| Ruta recorrida | trazo de las posiciones de la telemetría (gris al 40 %) |
| Ruta de escape | `abortar.ruta_escape` (punteada); al llegar el aviso, 3 s en la vista lejana |
| Aviso de 4 s | `plan_actualizado` con `motivo` ≠ `inicial`; también `abortar.motivo` |
| Sitios (color y forma) | `terreno/sitios.json` por `mineral` (colores de CLAUDE.md §14) |
| Sitio pendiente / recogido | pendiente: su `id` está en `plan.paradas` · recogido: `hito` `muestra` |
| Muestras y carga | `hito.muestra` (`n_muestras`, `carga_kg`) y `telemetria.datos.carga_kg` |
| Peligros dinámicos | eventos `peligro`: `bloqueo` rojo, `multiplicador` ámbar; `radio_m: 0` lo quita |
| Zonas no transitables | `peligro.bin` |
| Hábitat y destino de aborto | `manifest.habitat`; `abortar.destino` |
| Vitales (FC, VO₂, velocidad) | `telemetria_astronauta.datos` |
| Capas del mapa | `ortofoto.jpg`, `crism_*.bin`, `pendiente_deg.bin`, `elevacion.bin` |

**Reparto sugerido:** Frank, el mapa cenital por capas con HUD y los botones de salto; Luis, la escena 3D con vistas lejana, astronauta y rover, y el recorrido en casco. `demo/visor_mision.html` ya implementa todo el flujo en 2D y sirve de referencia para ambos.

Al recibir `reinicio` se vacía todo el estado. Los avisos y desvanecimientos solo se animan con mensajes **en vivo**, no al reaplicar una ráfaga tras un salto.

### 5.5 Colores (CLAUDE.md §14)

Verde, ámbar y rojo se reservan a seguridad. Minerales: filosilicatos `#7F77DD` círculo · sulfatos `#D4537E` rombo · hematita `#712B13` triángulo · sílice `#378ADD` cuadrado. Las superposiciones CRISM usan el color de su mineral con transparencia.

### 5.6 Registro, marcadores y saltos [Implementado]

- **`.jsonl`:** un mensaje por línea, en el orden en que ocurrieron; `t` no retrocede. Contiene los eventos de entrada, las salidas del optimizador, `estado_aborto` y los `hito`. La misión de referencia son 1 856 mensajes y 0,36 MB. `idx` = número de línea (desde 0).
- **`.marcadores.json`:** lista de saltos `{id, t, min, clase, titulo, detalle, linea, nivel}`. `nivel` 1 = botón (inicio, eventos, muestras, fin); `nivel` 2 = llegadas.
- **Saltar a un instante `t`** = vaciar el estado y reaplicar, **sin animar**, todos los mensajes con `m.t ≤ t`. Al saltar a un marcador se empieza 20–40 s simulados antes para ver cómo ocurre.

---

## 6. Flujos

**6.1 Arranque.** (1) El backend carga `terreno/` y crea el `Motor` (< 1 s). (2) La telemetría manda `perfil` → `Motor.cargar_perfil` → el backend emite `reinicio` (`nueva_sesion`). (3) Llega la primera telemetría (`t = 0`) → el `Motor` devuelve `estado_aborto` y `plan_actualizado` (`motivo: inicial`) → la telemetría empieza a seguir ese plan y las vistas lo dibujan.

**6.2 Ciclo normal (cada 10 s simulados).** `telemetria_astronauta` → `[estado_aborto]` → difusión. Si el margen baja a ≤ 15 %, además sale `abortar` (`no_retorno`) hacia el hábitat.

**6.3 Evento con replanificación.** Un `peligro` que cruza la ruta, una `ventanas` que saca un sitio del plan, una alerta solar o una recalibración de κ → el `Motor` calcula desde la **posición actual** y el **O₂ restante** (nunca desde el plan original) → `plan_actualizado` → la telemetría cambia de ruta y las vistas muestran el aviso. Mientras el `Motor` responde, el backend **encola** la telemetría siguiente y no solapa llamadas.

**6.4 Aborto.** `SPE` `critico` → `abortar` con `destino` y `ruta_escape`. Desde ahí no hay más planes en la sesión, solo `estado_aborto`, hasta un `perfil` nuevo. La telemetría sigue el escape y emite `hito` `fin` al llegar; el backend cierra el registro.

**6.5 Reproducción y saltos.** El backend lee un `.jsonl` y lo emite con ritmo. Ante `control {accion: "saltar", t}`: (a) envía `reinicio {motivo: "saltar", t}`; (b) envía **de golpe**, sin ritmo, todos los mensajes con `m.t ≤ t`, cada uno con su `idx`; (c) continúa con ritmo. `control` admite `play`, `pause`, `saltar` y `velocidad`. En modo **en vivo** no se salta (v1). Para la demo se recomienda reproducir el registro: es idéntico cada vez y no depende de la red.

**6.6 Misión de referencia** (`contratos/ejemplos/guion_mision.json`, 152 min simulados): plan inicial de 9 sitios · roca no cartografiada (min 24,5) · sombra que cierra una ventana (55) · fatiga y recalibración (81) · arena suelta (88) · alerta solar (125) · tormenta crítica y aborto al hábitat (150). 7 muestras de 3 minerales; O₂ final 54 L. Todos estos eventos son **del escenario**, no datos medidos.

---

## 7. Transporte [Propuesta; lo cierra Albert]

**HTTP**

| Ruta | Devuelve |
|---|---|
| `GET /terreno/manifest.json`, `GET /terreno/{archivo}` | el paquete tal cual |
| `GET /marcadores` | `.marcadores.json` de la sesión |
| `GET /estado` | `Motor.estado()` |
| `POST /plan` | un `pedido` → su `plan` (opcional) |
| `GET /sesiones` | registros disponibles para reproducir |

**WebSocket**
- `/ws/telemetria` (Dana, Erick): envía `perfil`, eventos e `hito` tal cual, sin envoltura; recibe `plan_actualizado` y `abortar` tal cual.
- `/ws/vista` (Frank, Luis): recibe `{"idx": 1042, "msg": { … }}` por cada mensaje; puede enviar `control`. Para reanudar tras una caída: `?desde=<idx>`. `ping` cada 15 s.

**Errores:** `{"version":"1.0","tipo":"error","codigo":"pedido_invalido|version_no_soportada|sin_perfil|seq_fuera_de_orden|optimizador_no_disponible|interno","detalle":"…","seq_evento":123}`. Solo `version_no_soportada` obliga a cerrar la sesión. Demo local: sin autenticación.

**Tráfico esperado a ×30:** ~6 mensajes/s (telemetría + `estado_aborto`); un `plan_actualizado` pesa unas decenas de KB, pocas veces por sesión.

## 8. Presupuestos

| Concepto | Presupuesto | Medido (terreno real, 192 × 192, 11 sitios) |
|---|---|---|
| Telemetría en el `Motor` | < 5 ms | 0,04 ms |
| Plan inicial | ≤ 2 s | ~1,1 s (corta por el tope de 200 000 nodos; `optimo: false`) |
| Replanificaciones siguientes | ≤ 2 s | 0,05–1,1 s |
| Carga del `Motor` + `cargar_perfil` | — | < 0,1 s |
| Misión completa simulada | — | ~4 s |

El tope de nodos está calibrado para un portátil (~240 000 nodos/s). En una máquina más de dos veces más lenta, el tope de 2 s actuaría antes y el resultado dejaría de ser reproducible: en ese caso, bajar `TOPE_SOLVER_NODOS`.

## 9. Versionado

Aditivo sobre lo descrito en CLAUDE.md, ya implementado: `abortar.destino`; `manifest.refugios`, `georreferencia`, `corregistro`, `supuestos`, `z_ref_m`; capas `ortofoto`, `pendiente_deg`, `crism_*`; mensaje `hito`. Pendiente de aceptación: `control`, `reinicio`, `error`, `frame` y las rutas de §7. Cualquier cambio de nombre, tipo o significado de un campo existente → `"2.0"`.

## 10. Validación y pruebas de integración (25-nov)

```
python contratos/validar.py logs/sesion-2026-11-12-mision.jsonl     # cada línea contra su esquema + orden de t
python contratos/validar.py --terreno terreno/                      # manifiesto, sitios y tamaño de cada capa
python contratos/validar.py --marcadores logs/sesion-2026-11-12-mision.marcadores.json
python -m optimizador.pruebas.test_nucleo                           # 12 pruebas sobre el terreno real
```

Lista de aceptación:
- [ ] El `SHA256SUMS` de `terreno/` coincide en todas las partes.
- [ ] Una sesión completa del guion, con la telemetría y el `Motor` conectados por el backend, genera un `.jsonl` que valida y cuyos mensajes del optimizador coinciden con los de `simular_guion`.
- [ ] Orden: `t` nunca retrocede; `seq` sin huecos.
- [ ] Frontend y VR reproducen el `.jsonl`, y cada salto a un marcador deja el mismo estado que `demo/visor_mision.html`.
- [ ] La ruta dibujada cae sobre el terreno correcto: el rodeo de las lomas se ve en la ortofoto.
- [ ] Un `abortar` lleva al astronauta al `destino` y el registro termina con `hito` `fin`.
- [ ] Un `error` se muestra y no tumba la sesión (salvo `version_no_soportada`).
- [ ] Ninguna cifra en pantalla se calcula en las vistas.

## 11. Decisiones abiertas

| # | Decisión | Propuesta | Dueño |
|---|---|---|---|
| 1 | Reparto exacto entre Frank (frontend) y Luis (simulación 3D / VR), y entre Dana y Erick | §5.4 y §5.1; confirmar | Ignacio |
| 2 | Ejes del marco local hacia la escena 3D | §3.2 | Luis, Frank |
| 3 | Rutas HTTP y roles del WebSocket | §7 | Albert |
| 4 | La telemetría emite los `hito` | sí | Dana, Erick |
| 5 | Añadir la hora de llegada al hábitat al plan (campo aditivo) | sí | Ignacio |
| 6 | Uso de `SPE.llegada_s` como restricción | implementar | Ignacio |
| 7 | Capa térmica | re-exportar con georreferencia, o THEMIS | Ignacio |
| 8 | Umbral de 30° de `peligro` y parámetros de las paradas | revisar con literatura | Ignacio |
| 9 | Marcadores derivados solo del `.jsonl` para sesiones en vivo | implementar en el backend | Albert, Ignacio |
| 10 | `factor_tiempo` de la demo | ×30 con saltos | todos |
| 11 | Servicio FastAPI `:8001` si el backend no es Python | solo si hace falta | Albert, Ignacio |

## 12. Avisos para la presentación

- Pandolf a 0,38 g **no está validado**: es una aproximación de diseño.
- Los índices CRISM son **indicios**, no detecciones confirmadas; la sílice es débil.
- La tormenta solar, la roca, la arena, la sombra y la fatiga son eventos **de escenario**.
- El terreno real tiene tres tipos de datos de la NASA: topográfico (USGS/MOLA, HRSC, CTX, HiRISE), óptico (HiRISE) y espectral (CRISM).
