# Contrato de integración — ARES-TWIN (v1.0, a congelar el 2026-11-18)

Qué produce y qué consume **cada parte** del sistema, sobre **los mismos datos**. Complementa a `CLAUDE.md`, que sigue mandando en constantes, algoritmo y reglas de negocio.

- **Fuente de verdad:** los esquemas de [`schemas/`](schemas/) y el validador [`validar.py`](validar.py). Si este texto contradice un esquema, manda el esquema.
- **Estados:** **[Implementado]** existe en el repo y tiene prueba · **[Propuesta]** no existe; la acepta o ajusta su dueño antes del 18-nov.

**Cambios del 2026-11-13 respecto al borrador anterior**
1. **No hay telemetría.** Todos los datos del astronauta son **simulados**: una simulación genera el conjunto de datos de la misión y las vistas lo reproducen. No hay flujo en vivo desde ningún equipo real.
2. El mensaje `telemetria_astronauta` pasa a llamarse **`estado_astronauta`** (mismos campos).
3. **No hay rover.** Desaparecen `telemetria_rover`, el bloque `rover` del perfil y la vista de rover. La simulación solo contempla al astronauta.
4. El terreno usa los **cuatro tipos de capa** descargados: topográfica, óptica, espectral y térmica.

---

## 1. El sistema de un vistazo

```
                    DATOS COMPARTIDOS:  terreno/   (solo lectura, un único paquete)
        ┌──────────────────┬──────────────────┬───────────────────┬────────────────────┐
        ▼                  ▼                  ▼                   ▼
   SIMULACION           OPTIMIZADOR        FRONTEND          SIMULACION 3D / VR
   DE DATOS (Dana)      (Ignacio)          (Frank)           (Luis)
        │   eventos  ──────►  Motor
        │   ◄──────  planes, aborto, márgenes
        ▼
   logs/sesion-<fecha>-mision.jsonl  +  .marcadores.json      ← el CONJUNTO DE DATOS de la misión
        │
        └──────────────► BACKEND (Albert): lo sirve junto con terreno/ ──────► FRONTEND y VR lo reproducen
```

| Parte | Dueño | Carpeta | Papel |
|---|---|---|---|
| Datos / terreno | Ignacio | `terreno/`, `herramientas/` | Paquete único de capas reales. Todos lo leen. |
| Optimizador | Ignacio | `optimizador/` | Planifica, calcula márgenes de aborto, replanifica. |
| Simulación de datos | Dana | `simulacion/` | Simula al astronauta y los eventos; **única que descuenta el O₂**; produce el registro de la misión. |
| Backend | Albert | `backend/` | Sirve el terreno y los registros; opcionalmente los reproduce por WebSocket. |
| Frontend | Frank | `front/` | Mapa por capas y HUD. **No calcula nada.** |
| Simulación 3D / VR | Luis | `vr/` | Escena 3D y recorrido en casco. **No calcula nada.** |

Frontend y VR son, para el contrato, el mismo papel: **vistas**. Consumen lo mismo y obedecen las mismas reglas.

## 2. Reglas de oro

1. **Un solo paquete de terreno.** Nadie guarda copia propia ni lo edita a mano; se regenera con `herramientas/construir_terreno.py`.
2. **Todo dato del astronauta es simulado** y así debe presentarse. Lo real es el terreno.
3. **Un solo dueño de cada número:** la simulación descuenta el O₂; el optimizador predice planes y márgenes; las vistas solo muestran lo que viene en un mensaje.
4. Todo mensaje: JSON UTF-8, `snake_case`, `"version": "1.0"`. Campos nuevos = **aditivos**. Quien no entienda un `tipo` o un campo lo **ignora**.
5. Tiempo: `t` en segundos simulados desde el inicio de la EVA; `hora_solar = t0_hora_solar + t/3699`.
6. Orden: `seq` creciente de 1 en 1 en los eventos de la simulación. El orden total de una misión es el del registro (§5.5).
7. Todo se valida: `python contratos/validar.py <archivo>` (§10).

---

## 3. Datos compartidos: el paquete `terreno/` [Implementado]

**Lugar:** ladera norte de Mount Sharp (Aeolis Mons), cráter Gale, en la unidad de sulfatos. Ventana de **480 × 480 m**, esquina SO en 137,408172° E, −4,827169°; esquina NE en 137,416269° E, −4,819071°. Malla de **192 × 192 celdas de 2,5 m**.

El lado es 480 m y no 1 km porque la imagen HiRISE en color solo tiene ~495 m de ancho útil en esa franja.

### 3.1 Las cuatro capas

| Tipo | Archivos | Fuente | Resolución nativa |
|---|---|---|---|
| **Topográfica** | `elevacion.bin` (altura [m] sobre `z_ref_m` = −3420; rango 0–84,8), `pendiente_deg.bin` (media 8,9°), `eta_terreno.bin` (η ∈ [1, 2]), `peligro.bin` (pendiente > 30°; 0,9 % de las celdas) | USGS *Mars MSL Gale Merged DEM 1m v3* | 1 m |
| **Óptica** | `ortofoto.jpg` (1920 × 1920, 0,25 m/px, **fila 0 = norte**; falso color R, G, B = IR, RED, BG) | MRO HiRISE `ESP_087149_1750_COLOR`, 2025-02-28 | 0,25 m |
| **Espectral** | `crism_d2300.bin` (arcillas Fe/Mg), `crism_bd1900_2.bin` y `crism_bd2100_2.bin` (sulfatos poli- y monohidratados), `crism_bd2210_2.bin` (sílice hidratada, débil), `crism_bd860_2.bin` (hematita cristalina: **sin señal aquí**), `crism_bd530_2.bin` (óxidos férricos; contexto) | MRO CRISM MTRDR `FRT0000B6F1_07_SU165J_MTR3` | 18 m |
| **Térmica** | `tes_inercia_termica.bin` (inercia térmica aparente, J m⁻² K⁻¹ s⁻½). **Un único valor en toda la ventana: 241** | MGS TES, mapa nocturno de Putzig y Mellon (2007), 20 px/grado | ~3 km |

Además: `manifest.json` (§3.3), `sitios.json` (§3.4), `vista_previa.jpg` y `SHA256SUMS`.

Todas las capas `.bin` son float32 little-endian (salvo `peligro`, uint8) con NaN donde no hay dato.

**Cómo se usa cada tipo**

| Tipo | Optimizador | Vistas |
|---|---|---|
| Topográfica | **Sí:** costo en O₂ de cada paso (pendiente y η), celdas bloqueadas, ruta de retorno | malla 3D, capa de pendiente, zonas no transitables |
| Óptica | no | imagen base del mapa y textura de la escena |
| Espectral | **Indirecto:** de ella salen los sitios, su mineral y su `valor` | superposiciones por mineral |
| Térmica | no (un solo valor para toda la ventana no puede cambiar una ruta) | dato de contexto del HUD: tipo de superficie |

**Aviso sobre la capa térmica.** El archivo que se exportó de JMARS (`TES_Thermal_Inertia_numeric.tif`) no trae coordenadas y sus valores no coinciden con el mapa público de TES, así que no se pudo situar. La capa del paquete procede del mapa TES de Putzig y Mellon (2007): mismo instrumento y misma magnitud, con georreferencia. TES mide a ~3 km, seis veces el lado de la ventana; para tener variación térmica dentro de ella haría falta THEMIS (100 m).

Las capas CRISM tienen 18 m nativos y se remuestrean por vecino más cercano: son **contexto**, no precisión de metros.

### 3.2 Marco de coordenadas [Implementado]

- **Local ENU en metros.** Origen `(0, 0)` = esquina **suroeste** de la ventana. `x` = Este, `y` = Norte, `z` = arriba.
- **Capas `.bin`:** `fila_0 = "sur"`. Centro de la celda `(i, j)`: `x = (j + 0.5)·2.5`, `y = (i + 0.5)·2.5`. Orden fila por fila. **La ortofoto es una imagen normal: fila 0 = norte.**
- **Georreferencia** (`manifest.georreferencia`): equirectangular de Marte, radio 3 396 190 m, latitud estándar 0, longitud central 0 y positiva al este. `lon = (x_sw_m + x)/R`, `lat = (y_sw_m + y)/R` en radianes.
- **Corregistro** (`manifest.corregistro`): el DEM de USGS (atado a MOLA) es la referencia. HiRISE y CRISM venían desplazados y se corrigieron: HiRISE −9 m este / −136 m norte (precisión ~1 m); CRISM +126 m este / −90 m norte (precisión ~9 m). Medido con `herramientas/corregistro.py`.
- **Eje vertical:** sin exageración en los datos. La conversión a la escena 3D la deciden Luis y Frank; sugerencia: `(x_escena, y_escena, z_escena) = (x, elevación, −y)`. **[Propuesta]**
- Las vistas pegan la ruta al terreno con raycast sobre su propia malla, usando **solo `x`, `y`**.

### 3.3 `manifest.json`

Esquema: `schemas/manifest.json`. Obligatorios: `sitio`, `fuente_dem`, `origen`, `marco`, `tam_celda_m`, `filas`, `columnas`, `fila_0`, `capas` (con `elevacion`), `habitat`. Además trae `z_ref_m`, `georreferencia`, `corregistro`, `contexto` (inercia térmica), `supuestos` y, cuando existan, `refugios`.

Cada entrada de `capas` lleva `archivo`, `dtype` (o `formato` para imágenes), `fuente`, `resolucion_nativa_m` y `descripcion`. El hábitat está en `(238.75, 231.25)`: la celda más llana del tercio central.

**En esta ventana no hay `refugios`:** el DEM no tiene depresiones cerradas de al menos 1 m. El aborto por tormenta va al hábitat. La clave sigue soportada para otros terrenos.

### 3.4 `sitios.json`

`{ "version": "1.0", "sitios": [ … ] }`, máximo 12. Cada sitio: `id`, `x`, `y`, `valor` (1–10), `mineral`, `masa_kg`, `perforacion_min`, `ventana` `[ini_h, fin_h]` en hora solar; además `lon`, `lat` y `fuente` (índice CRISM y su valor).

**Criterio (en `manifest.supuestos`):** cada sitio es un máximo local de un índice CRISM por encima del percentil 90 de la escena, colocado en una celda alcanzable con pendiente ≤ 15°. `valor = 1 + 9·(v − p90)/(p99,9 − p90)`. Resultado: 5 de sulfatos (valor 3–10), 1 de filosilicatos (4) y 5 de sílice (1–2).

`masa_kg` (0,3), `perforacion_min` (15) y `ventana` ([10, 14]) son **supuestos de escenario**, iguales para todos. El `valor` es un criterio nuestro, no una prioridad de la NASA.

### 3.5 Quién lee qué

| Parte | Cómo lee el terreno |
|---|---|
| Optimizador | `Terreno.cargar(ruta)`. Lee `elevacion`, `eta_terreno`, `peligro`, `sitios`, `habitat`, `refugios`; **ignora las demás capas**. |
| Simulación de datos | La misma clase `Terreno` (`z(x, y)`, `celda`, `eta`) y `pandolf()` / `potencia()`. |
| Backend | Sirve los archivos **tal cual** por HTTP (§7). No los transforma. |
| Frontend | Ortofoto como base; `crism_*`, `pendiente_deg` y `peligro` como capas; `sitios.json`; `manifest.contexto` para el dato térmico. |
| Simulación 3D / VR | Malla desde `elevacion.bin`, `ortofoto.jpg` como textura (ojo: fila 0 = norte). |

Lectura en JavaScript: `new Float32Array(buffer)` da `filas × columnas` valores; el índice de la celda `(i, j)` es `i·columnas + j`. Ejemplo completo en `demo/visor_plantilla.html`.

### 3.6 Congelación

`SHA256SUMS` identifica el paquete. Cambiar el terreno implica regenerar sitios y registro, porque todas las coordenadas dependen de él: `construir_terreno.py` y luego `generar_registro.py`.

---

## 4. Catálogo de mensajes

| Mensaje | Lo produce | Lo consume | Esquema | Estado |
|---|---|---|---|---|
| `perfil` | Simulación | Optimizador | `perfil` | [Implementado] |
| `estado_astronauta` | Simulación | Optimizador, vistas | `estado_astronauta` | [Implementado] |
| `peligro` | Simulación | Optimizador, vistas | `peligro` | [Implementado] |
| `ventanas` | Simulación | Optimizador, vistas | `ventanas` | [Implementado] |
| `SPE` | Simulación | Optimizador, vistas | `spe` | [Implementado] |
| `hito` | Simulación | vistas (el optimizador lo ignora) | `hito` | [Implementado] |
| `pedido` | cualquiera | Optimizador | `pedido` | [Implementado] |
| plan (respuesta del pedido) | Optimizador | quien pidió | `plan` | [Implementado] |
| `plan_actualizado` | Optimizador | Simulación, vistas | `plan_actualizado` | [Implementado] |
| `abortar` | Optimizador | Simulación, vistas | `abortar` | [Implementado] |
| `estado_aborto` | Optimizador | vistas | `estado_aborto` | [Implementado] |
| `marcadores` (archivo) | Simulación | vistas | `marcadores` | [Implementado] |
| `control`, `reinicio`, `frame`, `error` | Backend / vistas | — | ídem | [Propuesta], solo para el modo B de §7 |

Los eventos de la simulación llevan el envoltorio `{version, t, hora_solar, seq, tipo, datos}`; los del optimizador, `{version, tipo, t, …}`.

**`estado_astronauta.datos`:** `x`, `y`, `sigma_m` (0 en v1), `O2_restante_L`, `VO2_L_min`, `FC_lpm`, `velocidad_m_s`, `carga_kg`. Son valores simulados; VO₂ y frecuencia cardíaca son órdenes de magnitud, no fisiología validada.

**`perfil`:** `escenario_id`, `semilla`, `t0_hora_solar`, `factor_tiempo`, `duracion_eva_s` y el bloque `astronauta`. Ya no lleva `rover`.

---

## 5. Qué produce y qué consume cada parte

### 5.1 Simulación de datos (Dana)

Es un programa que corre **junto al optimizador, en el mismo proceso**, y deja escrito el conjunto de datos de la misión. No hay transmisión en vivo.

```python
from optimizador import Motor
motor = Motor("terreno/")
motor.cargar_perfil(perfil)
salidas = motor.procesar_evento(evento)     # lista con estado_aborto, plan_actualizado o abortar
```

**Produce**
- `perfil`, **una vez y antes de todo** (`semilla` y `factor_tiempo` van aquí).
- `estado_astronauta` cada 10 s simulados.
- `peligro`, `ventanas`, `SPE` cuando lo marque el guion. `peligro` con `radio_m: 0` y el mismo `id` lo quita.
- `hito`: `llegada` al alcanzar una parada, `muestra` al cumplirse su `salida_s`, `fin` al llegar al destino final (con `destino` y `O2_restante_L`).
- El registro `.jsonl` con **todos** los mensajes en orden (los suyos y los que devuelve el optimizador) y el archivo de marcadores.

**Reglas**
- `seq` empieza en 1 y sube de 1 en 1 solo en los eventos; `hito` no consume `seq`.
- Orden dentro de un mismo instante `t`: primero `hito`, luego `estado_astronauta`, luego el resto de eventos, y tras cada evento las salidas del optimizador.
- El astronauta sigue la polilínea del último `plan_actualizado`, interpolando con `llegada_s`, y se queda `perforacion_min` en cada parada. Tras un `abortar` sigue `ruta_escape` hasta `destino`. Sin plan, permanece en el hábitat.
- Consumo: `pandolf()` / `potencia()` del paquete `optimizador` al caminar; ~250 W al perforar o esperar.
- Determinista: la misma `semilla` y el mismo guion dan exactamente el mismo registro.

**Punto de partida:** `optimizador/pruebas/simular_guion.py` ya cumple todo esto, sin ruido, y `herramientas/generar_registro.py` escribe el registro. Lo que queda por decidir es cuánto ruido añadir (CLAUDE.md §10.4) y si el guion cambia.

**Hueco conocido:** el plan no trae la hora de llegada al hábitat, así que el último tramo no se puede interpolar con `llegada_s`; la referencia usa 0,6 m/s fijos.

### 5.2 Optimizador (Ignacio)

**Consume:** `perfil`, `estado_astronauta`, `peligro`, `ventanas`, `SPE` (vía `Motor.procesar_evento`) y `pedido` (vía `Motor.planificar`). **Ignora** `hito` y cualquier tipo desconocido (devuelve lista vacía).

**Produce** (lista por evento):

| Evento | Salida |
|---|---|
| `estado_astronauta` | `[estado_aborto]` (+ `plan_actualizado` o `abortar`) |
| `peligro`, `ventanas` | `[plan_actualizado]` o `[]` |
| `SPE` `alerta` | `[plan_actualizado]` (ρ = 0,25) |
| `SPE` `critico` | `[abortar]` |
| `hito`, desconocido | `[]` |

**Garantías:** `estado_astronauta` < 5 ms · cualquier otra llamada ≤ 2 s · siempre hay `ruta_escape` · **determinista** con la misma entrada, en cualquier máquina (el solver corta por número de nodos, no por reloj) · ninguna ruta pisa una celda de `peligro` · una sesión y una llamada a la vez, eventos en orden de `seq`, `cargar_perfil` primero.

**Brecha conocida:** `SPE.llegada_s` aún **no se usa**; hoy una alerta solo sube la reserva.

### 5.3 Backend (Albert) — **[Propuesta]**; lo define Albert

Sin telemetría en vivo, el backend deja de orquestar un flujo y pasa a **servir datos ya generados**:
- El paquete `terreno/`, tal cual.
- Los registros `.jsonl` y sus marcadores.
- Opcional: reproducción por WebSocket con saltos (modo B de §7) y un punto para lanzar una simulación nueva con otro guion.

### 5.4 Vistas: Frontend (Frank) y Simulación 3D / VR (Luis)

**Consumen:** el terreno, el registro `.jsonl` y los marcadores. **No calculan nada.**

| Elemento en pantalla | Sale de |
|---|---|
| Posición del astronauta | `estado_astronauta.datos.x, y` (se interpola entre dos estados) |
| Hora solar | `estado_astronauta.hora_solar` |
| Barra de O₂ y su línea mínima | `estado_aborto.O2_restante_L` y `O2_minimo_L` |
| Color de seguridad | `estado_aborto.margen_pct`: > 30 verde · 15–30 ámbar · ≤ 15 rojo. Junto al hábitat el margen es enorme: mostrar "> 999 %" |
| Ruta por recorrer | `plan.polilinea` del último `plan_actualizado` (la anterior se desvanece 2 s) |
| Ruta recorrida | trazo de las posiciones de `estado_astronauta` (gris al 40 %) |
| Ruta de escape | `abortar.ruta_escape` (punteada); al llegar el aviso, 3 s en la vista lejana |
| Aviso de 4 s | `plan_actualizado` con `motivo` ≠ `inicial`; también `abortar.motivo` |
| Sitios (color y forma) | `terreno/sitios.json` por `mineral` |
| Sitio pendiente / recogido | pendiente: su `id` está en `plan.paradas` · recogido: `hito` `muestra` |
| Muestras y carga | `hito.muestra` (`n_muestras`, `carga_kg`) y `estado_astronauta.datos.carga_kg` |
| Peligros dinámicos | eventos `peligro`: `bloqueo` rojo, `multiplicador` ámbar; `radio_m: 0` lo quita |
| Zonas no transitables | `peligro.bin` |
| Hábitat y destino de aborto | `manifest.habitat`; `abortar.destino` |
| Vitales (FC, VO₂, velocidad) | `estado_astronauta.datos` |
| Capas del mapa | `ortofoto.jpg`, `crism_*.bin`, `pendiente_deg.bin`, `elevacion.bin` |
| Tipo de superficie | `manifest.contexto.inercia_termica_tiu` |

**Vistas de la escena 3D:** lejana (orbital) y astronauta (tercera persona, sobre el hombro). Ya no hay vista de rover.

**Reparto sugerido:** Frank, el mapa cenital por capas con HUD y los botones de salto; Luis, la escena 3D y el recorrido en casco. `demo/visor_mision.html` ya implementa todo el flujo en 2D y sirve de referencia para ambos.

**Colores (CLAUDE.md §14).** Verde, ámbar y rojo se reservan a seguridad. Minerales: filosilicatos `#7F77DD` círculo · sulfatos `#D4537E` rombo · hematita `#712B13` triángulo · sílice `#378ADD` cuadrado. Las superposiciones CRISM usan el color de su mineral con transparencia.

### 5.5 Registro, marcadores y saltos [Implementado]

- **`.jsonl`:** un mensaje por línea, en el orden en que ocurrieron; `t` no retrocede. La misión de referencia son 1 856 mensajes y 0,36 MB. El número de línea (desde 0) identifica cada mensaje.
- **`.marcadores.json`:** lista de saltos `{id, t, min, clase, titulo, detalle, linea, nivel}`. `nivel` 1 = botón (inicio, eventos, muestras, fin); `nivel` 2 = llegadas.
- **Saltar a un instante `t`** = vaciar el estado y reaplicar, **sin animar**, todos los mensajes con `m.t ≤ t`. Al saltar a un marcador se empieza 20–40 s simulados antes para ver cómo ocurre. Los avisos y desvanecimientos solo se animan al reproducir, no al reaplicar.

---

## 6. Flujos

**6.1 Generar la misión** (una vez, o cada vez que cambie el guion o el terreno). La simulación carga `terreno/` y el `Motor`, envía `perfil` y el primer `estado_astronauta` (`t = 0`); el `Motor` responde con `estado_aborto` y `plan_actualizado` (`motivo: inicial`). A partir de ahí, cada 10 s simulados: mover al astronauta, descontar O₂, emitir `estado_astronauta`, recoger la respuesta. Todo queda escrito en el `.jsonl`.

**6.2 Evento con replanificación.** Un `peligro` que cruza la ruta, una `ventanas` que saca un sitio del plan, una alerta solar o una recalibración de κ → el `Motor` calcula desde la **posición actual** y el **O₂ restante** → `plan_actualizado` → el astronauta simulado cambia de ruta.

**6.3 Aborto.** `SPE` `critico` (o margen ≤ 15 %) → `abortar` con `destino` y `ruta_escape`. Desde ahí no hay más planes, solo `estado_aborto`. La simulación sigue el escape y cierra con `hito` `fin`.

**6.4 Reproducir.** Las vistas cargan el `.jsonl`, lo recorren con un reloj (`factor` = segundos simulados por segundo real) y saltan con los marcadores.

**6.5 Misión de referencia** (`contratos/ejemplos/guion_mision.json`, 152 min simulados): plan inicial de 9 sitios · roca no cartografiada (min 24,5) · sombra que cierra una ventana (55) · fatiga y recalibración (81) · arena suelta (88) · alerta solar (125) · tormenta crítica y aborto al hábitat (150). 7 muestras de 3 minerales; O₂ final 54 L. Todos estos eventos son **del escenario**.

---

## 7. Transporte [Propuesta; lo cierra Albert]

**Modo A — archivos (recomendado para la demo).** Las vistas descargan todo por HTTP y reproducen en local. Es idéntico cada vez y no depende de la red.

| Ruta | Devuelve |
|---|---|
| `GET /terreno/manifest.json`, `GET /terreno/{archivo}` | el paquete tal cual |
| `GET /sesiones` | registros disponibles |
| `GET /sesiones/{nombre}.jsonl`, `GET /sesiones/{nombre}.marcadores.json` | el registro y sus marcadores |
| `POST /plan` | un `pedido` → su `plan` (opcional, para probar el optimizador a mano) |

**Modo B — reproducción por WebSocket (opcional).** `/ws/vista` envía `{"idx": 1042, "msg": { … }}` por cada mensaje, con ritmo. Las vistas mandan `control` (`play`, `pause`, `saltar`, `velocidad`); ante un salto, el backend envía `reinicio` y, de golpe, todos los mensajes con `m.t ≤ t`. Errores como mensaje `error`.

## 8. Presupuestos

| Concepto | Presupuesto | Medido (terreno real, 192 × 192, 11 sitios) |
|---|---|---|
| `estado_astronauta` en el `Motor` | < 5 ms | 0,03 ms |
| Plan inicial | ≤ 2 s | ~1,1 s (corta por el tope de 200 000 nodos; `optimo: false`) |
| Replanificaciones siguientes | ≤ 2 s | 0,05–1,1 s |
| Carga del `Motor` + `cargar_perfil` | — | < 0,1 s |
| Generar la misión completa | — | ~4 s |

El tope de nodos está calibrado para un portátil (~240 000 nodos/s). En una máquina más de dos veces más lenta, el tope de 2 s actuaría antes y el resultado dejaría de ser reproducible: en ese caso, bajar `TOPE_SOLVER_NODOS`.

## 9. Versionado

Seguimos en `"1.0"` porque el contrato aún no está congelado. Tras el 18-nov, quitar o renombrar un mensaje o un campo será `"2.0"`; añadir campos opcionales no.

## 10. Validación y pruebas de integración (25-nov)

```
python contratos/validar.py logs/sesion-2026-11-13-mision.jsonl     # cada línea contra su esquema + orden de t
python contratos/validar.py --terreno terreno/                      # manifiesto, sitios y tamaño de cada capa
python contratos/validar.py --marcadores logs/sesion-2026-11-13-mision.marcadores.json
python -m optimizador.pruebas.test_nucleo                           # 12 pruebas sobre el terreno real
```

Lista de aceptación:
- [ ] El `SHA256SUMS` de `terreno/` coincide en todas las partes.
- [ ] La simulación de Dana genera un `.jsonl` que valida y que, sin ruido, coincide con el de `simular_guion`.
- [ ] Orden: `t` nunca retrocede; `seq` sin huecos.
- [ ] Frontend y VR reproducen el `.jsonl`, y cada salto a un marcador deja el mismo estado que `demo/visor_mision.html`.
- [ ] La ruta dibujada cae sobre el terreno correcto: el rodeo de las lomas se ve en la ortofoto.
- [ ] Un `abortar` lleva al astronauta al `destino` y el registro termina con `hito` `fin`.
- [ ] Ninguna cifra en pantalla se calcula en las vistas.
- [ ] En pantalla queda claro qué es dato real (terreno) y qué es simulado (astronauta y eventos).

## 11. Decisiones abiertas

| # | Decisión | Propuesta | Dueño |
|---|---|---|---|
| 1 | Reparto entre Frank (frontend) y Luis (3D / VR); papel de Erick | §5.4; confirmar | Ignacio |
| 2 | Ejes del marco local hacia la escena 3D | §3.2 | Luis, Frank |
| 3 | Modo A o B de transporte y rutas HTTP | §7, modo A | Albert |
| 4 | Ruido de la simulación y guion definitivo | sin ruido para la demo | Dana |
| 5 | Añadir la hora de llegada al hábitat al plan (campo aditivo) | sí | Ignacio |
| 6 | Uso de `SPE.llegada_s` como restricción | implementar | Ignacio |
| 7 | Capa térmica con variación dentro de la ventana | THEMIS (100 m) | Ignacio |
| 8 | Umbral de 30° de `peligro` y parámetros de las paradas | revisar con literatura | Ignacio |
| 9 | `factor_tiempo` de la demo | ×30 con saltos | todos |

## 12. Avisos para la presentación

- El astronauta, su consumo y todos los eventos son **simulados**. Lo real es el terreno.
- Pandolf a 0,38 g **no está validado**: es una aproximación de diseño.
- Los índices CRISM son **indicios**, no detecciones confirmadas; la sílice es débil y no hay hematita en la ventana.
- La capa térmica es un único valor de TES para toda la zona.
- Tipos de datos de la NASA que se combinan: topográfico (MOLA, HRSC, CTX, HiRISE vía USGS), óptico (HiRISE), espectral (CRISM) y térmico (TES).
