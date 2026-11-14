# CLAUDE.md — ARES-TWIN (NASA Space Apps · Martian Map)

Referencia técnica para agentes de programación. Contratos v1.0, al 2026-11-13 (terreno real; datos del astronauta simulados; sin telemetría ni rover).
Si algo de aquí contradice el código, **este archivo manda** hasta que se cambie con versión nueva.

---

## 1. Qué es

Optimizador de rutas de EVA en Marte (Mount Sharp, cráter Gale). Planifica qué sitios científicos visita un astronauta y en qué orden, con el **O₂ como única unidad de costo**, una reserva para abortar y replanificación ante eventos en vivo (peligros, sombra, fatiga, tormenta solar). Lo acompañan un frontend de mapa por capas y HUD, una simulación 3D/VR y una **simulación de datos** del astronauta. No hay telemetría real ni rover: todo dato del astronauta es simulado. El contrato de integración completo está en `contratos/INTEGRACION.md`.

## 2. Equipo y dueños

| Parte | Dueño | Carpeta |
|---|---|---|
| Optimizador (A* + CTOPTW), datos y paquete de terreno | Ignacio | `optimizador/`, `terreno/`, `herramientas/` |
| Simulación de datos del astronauta y de los eventos | Dana | `simulacion/` |
| Backend (API, WebSocket) | Albert | `backend/` |
| Frontend: mapa por capas y HUD | Frank | `front/` |
| Simulación 3D y VR | Luis | `vr/` |
| Contratos compartidos | todos | `contratos/` |

Cada dueño define su propio contrato. Este archivo recoge los contratos del **optimizador** y de la **simulación de datos** (Dana), y las convenciones de visualización acordadas. Erick se incorporó para la telemetría, que ya no existe: su parte está por asignar.

## 3. Estado de las decisiones

**Decidido:** sitio = Mount Sharp, unidad de sulfatos (ventana de 480 × 480 m con esquina SO en 137,408172° E, −4,827169°) · DEM = USGS *Mars MSL Gale Merged DEM 1m v3* · un solo paquete `terreno/` para todos · marco local ENU con origen en la esquina SO y fila 0 = sur · un solo agente en v1 · contratos v1.0 · constantes de §7.

**Pendiente (no asumir):**
- Conversión de ejes del marco local a la escena 3D (Luis y Frank).
- Contrato propio del backend (rutas HTTP, roles del WebSocket, formato de error del servidor): lo define Albert. Propuesta en `contratos/INTEGRACION.md` §7.
- Término de riesgo λ en la función objetivo.
- Capa térmica con variación dentro de la ventana (hoy es un único valor de TES).

**Fechas:** contratos v1 congelados el 2026-11-18 · prueba de integración el 2026-11-25.

## 4. Estructura del repo

```
terreno/            paquete REAL: manifest.json, capas .bin, ortofoto.jpg, sitios.json, SHA256SUMS
datos_crudos/       descargas originales (fuera de git; ver datos_crudos/LEEME.md)
herramientas/       construir_terreno.py, corregistro.py, generar_registro.py, lectura remota (gale.py, remoto.py)
contratos/
  INTEGRACION.md    contrato de integración de todo el sistema (quién envía y recibe qué, datos compartidos)
  validar.py        valida mensajes, registros .jsonl y el paquete terreno/ contra schemas/
  schemas/          un JSON Schema por mensaje
  ejemplos/         pedido.json, guion_mision.json
optimizador/        librería Python: Motor, pandolf(); pruebas/ (test_nucleo.py, simular_guion.py)
demo/               visor autónomo con capas y botones de salto (visor_mision.html)
logs/               sesion-<fecha>-mision.jsonl + .marcadores.json (el conjunto de datos simulados)
simulacion/         Dana (simulación de datos)
backend/            Albert
front/              Frank
vr/                 Luis
```

## 5. Convenciones globales

| Tema | Regla |
|---|---|
| Formato | JSON UTF-8 / dict de Python; `snake_case`, sin tildes en los nombres |
| Versión | `"version": "1.0"` en todo mensaje. Cambio incompatible → `"2.0"` |
| Unidades | m, L, kg, s, W, lpm. Unidad en el nombre si no es obvia (`O2_total_L`) |
| Posición | `x`, `y` en metros, marco local ENU (x = Este, y = Norte, z = arriba). Origen: **pendiente** |
| Polilíneas | `[[x, y], …]` en metros |
| Ids | sitios: `int`; hábitat: `"H"`; peligros: `"p1"`…; planes: `"pl-0001"`… |
| Tiempo `t` | segundos simulados desde el inicio de la EVA (float) |
| `hora_solar` | hora solar local de Marte, horas decimales: `t0_hora_solar + t / 3699` |
| `seq` | entero creciente de 1 en 1 por emisor; nunca baja |
| Escala demo | factor ×30 (misión de ~152 min simulados ≈ 5 min reales); el visor permite saltar entre hitos |
| `estado_astronauta` | cada 10 s simulados |

## 6. Terreno (datos reales; detalle en `contratos/INTEGRACION.md` §3)

- Malla de **192 × 192 celdas de 2,5 m (480 m de lado)**. El tamaño lo limita el ancho útil de la imagen HiRISE en color (~495 m).
- Centro de la celda (i, j): `x = (j + 0.5)·2.5`, `y = (i + 0.5)·2.5`. Fila 0 = sur. Origen = esquina suroeste.
- Capas float32 little-endian, fila por fila: `elevacion` (altura sobre `z_ref_m`), `eta_terreno`, `pendiente_deg`, `crism_*`, `tes_inercia_termica` (NaN = sin dato); `peligro` (u8); `ortofoto.jpg` (1920 × 1920, **fila 0 = norte**); `sitios.json`.
- `manifest.json`: `sitio`, `fuente_dem`, `origen`, `marco`, `tam_celda_m`, `filas`, `columnas`, `fila_0`, `capas`, `habitat`; además `georreferencia`, `corregistro`, `supuestos`, `z_ref_m`.
- Fuentes: DEM de USGS (1 m) · HiRISE `ESP_087149_1750_COLOR` (0,25 m) · CRISM `FRT0000B6F1` MTRDR (18 m) · TES, inercia térmica de Putzig y Mellon 2007 (~3 km: un único valor, 241). El DEM es la referencia; HiRISE y CRISM se **corregistran** (−9 / −136 m y +126 / −90 m).
- `peligro` = pendiente > 30° (supuesto de diseño). η = desviación típica de la pendiente en ventana 3 × 3, normalizada a [1, 2].
- Sitios = máximos locales de los índices CRISM por encima del percentil 90 de la escena. En esta ventana hay sulfatos, filosilicatos y sílice débil; **no hay hematita**. `masa_kg`, `perforacion_min` y `ventana` son supuestos de escenario.
- En esta ventana el DEM **no tiene depresiones de refugio**: no hay `refugios` y el aborto por tormenta va al hábitat. La clave `refugios` (lista de `{id, x, y, radio_m, profundidad_m}`) sigue soportada.
- Sin exageración vertical en los datos. El front pega la ruta al terreno con raycast sobre su propia malla, usando solo `x`, `y`.
- Se reconstruye con `python herramientas/construir_terreno.py`; nunca se edita a mano.

## 7. Constantes

| Símbolo | Valor | Uso |
|---|---|---|
| g_M / g_T | 0,38 | gravedad de Marte relativa a la Tierra |
| W | 80 kg | masa del astronauta |
| m_traje | 150 kg | masa del traje |
| v₀ | 1,2 m/s | velocidad en plano |
| κ_O₂ | 0,00298 L/(W·min) | potencia → consumo de O₂ |
| O₂ inicial | 40 L | presupuesto de la EVA |
| Capacidad de muestras | 5 kg | mochila |
| ρ (reserva) | 0,15; 0,25 con SPE en alerta | aborto |
| α (diversidad) | 0,5 | ψ |
| N máx. de sitios | 12 | branch & bound exacto |
| Tope del solver | 200 000 nodos (~1 s) y, como red de seguridad, 2 s (anytime) | latencia y determinismo |
| Duración de la EVA | 14 400 s | límite duro |
| Δd | 2,5 m (ortogonal), 2,5·√2 m (diagonal) | vecindad de 8 |
| Suavizado | Chaikin, 2 pasadas | polilínea de salida |
| Minerales | `filosilicatos`, `sulfatos`, `hematita`, `silice` | lista cerrada |

## 8. Algoritmo

### 8.1 Pendiente firmada por arista
`G(a→b) = 100·(z_b − z_a)/Δd` (%). El signo importa: subir ≠ bajar → costos asimétricos.

### 8.2 Costo en O₂ (Pandolf adaptado a 0,38 g; **no validado**)
```
L_eff = (W + m_traje)·0.38 − W
v     = v0 · exp(−0.042·|G|) · (1 − 0.28·η)
M     = 1.5·W + 2.0·(W + L_eff)·(L_eff/W)² + η·(W + L_eff)·(1.5·v² + max(0, 0.35·v·G))   [W]
w_O2  = M · (Δd / (60·v)) · κ_O2                                                       [L]
```
Exponer como `pandolf(G, eta, perfil)` en la librería: Dana la importa para simular el consumo.

### 8.3 Matriz D y campo de retorno
- A* entre cada par ordenado de {hábitat, sitios}: `D[i][j] ≠ D[j][i]`. Heurística admisible: `d_euclid · w_min`, con `w_min` = menor costo por metro posible.
- Guardar `path[i][j]` (polilínea suavizada).
- **Campo de retorno R(p):** un solo Dijkstra inverso desde el hábitat (aristas invertidas) → costo de volver desde cualquier celda. Consulta O(1).

### 8.4 CTOPTW (v1, un agente)
```
máx Z = Σ_i S_i · ψ(m_i, n_mi) · y_i                     (término de riesgo λ: pendiente)
s.a.  O₂ de viaje + O₂ de muestreo ≤ Q_O2 · (1 − ρ)
      Σ q_i · y_i ≤ Q_kg
      e_i ≤ a_i ≤ l_i ;  a_j ≥ a_i + τ_i + t_ij − M·(1 − x_ij)
      ruta empieza y termina en H ; duración ≤ 14 400 s
ψ(m, n) = exp(−α·(n − 1))     n = muestras de la clase m, incluida la actual
```

### 8.5 Solver: branch & bound (DFS), anytime 2 s
Podar j si:
- `O2 + D[i][j] + D[j][H] > Q·(1 − ρ)` (no podría volver)
- `t + viaje > l_j` (ventana cerrada)
- `kg + q_j > Q_kg`
- `Z + cota_sup(restantes) ≤ mejor` (cota: suma de S_i restantes con ψ = 1 que aún quepan)

Al llegar al tope (de nodos o de tiempo): devolver la mejor solución encontrada con `optimo: false`. El tope de nodos hace que el resultado no dependa de la velocidad de la máquina.

## 9. Reglas de negocio en vivo

| Disparador | Acción |
|---|---|
| Cada `estado_astronauta` | `R = R(x, y)`; emitir `estado_aborto`. Si `margen_pct ≤ 15` → `abortar` (`no_retorno`) |
| VO₂ medido a más de un 20 % del previsto durante 60 s simulados | recalibrar κ con el promedio de esos 60 s y replanificar (`recalibracion`). Máx. 1 cada 300 s simulados |
| `peligro` | marcar celdas (`bloqueo` = ∞; `multiplicador` = ×factor, de 1 a 5); recalcular D y R localmente; replanificar si el plan lo cruza. `radio_m: 0` lo quita |
| `ventanas` | si un sitio del plan quedó fuera de su ventana → replanificar (`ventana`) |
| `SPE` `alerta` | ρ = 0,25 y replanificar (`spe_alerta`) |
| `SPE` `critico` | `abortar` (`spe_critico`) con la ruta de escape |
| Después de `abortar` | no más planes en la sesión; solo `estado_aborto` hasta un `cargar_perfil` nuevo |
| `tipo` desconocido | ignorar (lista vacía) |

```
O2_minimo_L = 1.15 · R_L
margen_pct  = 100 · (O2_restante_L / R_L − 1)
```

Dana es la **única** que descuenta el O₂. El optimizador predice y compara.

## 10. Contrato simulación de datos (Dana) → optimizador (entrada)

### 10.1 Perfil (una vez; reinicia la sesión)
```json
{ "version": "1.0", "tipo": "perfil", "escenario_id": "demo-01", "semilla": 42,
  "t0_hora_solar": 10.0, "factor_tiempo": 30, "duracion_eva_s": 14400,
  "astronauta": { "masa_kg": 80, "masa_traje_kg": 150, "v0_m_s": 1.2,
                  "kappa_O2_L_W_min": 0.00298, "O2_inicial_L": 40, "capacidad_muestras_kg": 5 } }
```

### 10.2 Envoltorio de los eventos
```json
{ "version": "1.0", "t": 1230.0, "hora_solar": 10.33, "seq": 124, "tipo": "<tipo>", "datos": { } }
```

### 10.3 `datos` por tipo
| `tipo` | `datos` |
|---|---|
| `estado_astronauta` (antes `telemetria_astronauta`) | `x, y, sigma_m (0 en v1), O2_restante_L, VO2_L_min, FC_lpm, velocidad_m_s, carga_kg` |
| `peligro` | `id, forma: "circulo", x, y, radio_m, efecto: "bloqueo"\|"multiplicador", factor` |
| `ventanas` | `sitios: [{ id, ventana: [ini_h, fin_h] }]` (solo los que cambian) |
| `SPE` | `nivel: "alerta"\|"critico", llegada_s` |

### 10.4 Modelo de biodatos (sugerido, lo implementa Dana)
- El astronauta sigue la polilínea del último `plan_actualizado` o `abortar`, interpolando con `llegada_s` (±5 % de ruido en la velocidad); en cada parada se queda `perforacion_min`.
- M: Pandolf al caminar; ~250 W al perforar o descansar.
- `VO2 = M·κ·(1 + ε_t)`, con `ε_t = 0.9·ε_{t−1} + N(0, 0.03)` (desviación típica ≈ 7 %).
- `O2(t) = O2(t − Δt) − VO2·Δt/60`.
- `FC = 70 + 55·VO2` ± 3, limitada a [60, 190].

## 11. Contrato del optimizador: pedido y respuesta

### 11.1 Pedido de plan
```json
{ "version": "1.0", "inicio": { "x": 120.0, "y": 120.0 }, "hora_solar": 10.0,
  "O2_disponible_L": 40.0, "capacidad_kg": 5.0,
  "sitios": [ { "id": 3, "x": 150.0, "y": 95.0, "valor": 8, "mineral": "filosilicatos",
                "masa_kg": 0.4, "perforacion_min": 6, "ventana": [10.0, 13.5] } ] }
```
`valor` de 1 a 10 · máx. 12 sitios · `ventana` en `hora_solar`.

### 11.2 Respuesta del plan
```json
{ "version": "1.0", "plan_id": "pl-0007", "factible": true,
  "orden": ["H", 3, 7, 1, "H"],
  "polilinea": [[120.0, 120.0], [122.5, 117.5]],
  "paradas": [ { "id": 3, "x": 150.0, "y": 95.0, "llegada_s": 1260, "salida_s": 1620, "O2_acum_L": 5.2 } ],
  "O2_total_L": 28.4, "O2_reserva_L": 6.0, "ciencia_Z": 21.7,
  "ruta_escape": [[150.0, 95.0]], "tiempo_calculo_ms": 340, "optimo": true }
```
Sin ruta factible: `factible: false`, `orden: ["H", "H"]` y la polilínea de vuelta directa. Nunca una respuesta vacía.

### 11.3 Mensajes en vivo (salida)
```json
{ "version": "1.0", "tipo": "plan_actualizado", "t": 2400.0,
  "motivo": "inicial|peligro|recalibracion|ventana|spe_alerta|pedido",
  "seq_evento": 241, "plan": { "…": "respuesta del plan (11.2)" } }

{ "version": "1.0", "tipo": "abortar", "t": 9600.0, "motivo": "spe_critico|no_retorno",
  "seq_evento": 961, "ruta_escape": [[150.0, 95.0]], "O2_previsto_L": 7.9 }

{ "version": "1.0", "tipo": "estado_aborto", "t": 1230.0,
  "O2_restante_L": 31.2, "R_L": 6.8, "O2_minimo_L": 7.8, "margen_pct": 359 }
```
- `abortar` lleva además el campo **opcional** `destino: {tipo: "habitat"|"refugio", id, x, y}` (propuesta, aditivo: quien no lo conozca lo ignora). Con `spe_critico` y `refugios` en el terreno, el destino es el refugio más barato en O₂ si cuesta menos que el hábitat; `ruta_escape` y `O2_previsto_L` van hasta ese destino. Con `no_retorno`, siempre el hábitat.
- `seq_evento` es `null` si el plan vino de un pedido.
- El primer plan de la sesión también se emite como `plan_actualizado` con `motivo: "inicial"`.

| Evento recibido | Salida |
|---|---|
| `estado_astronauta` | `[estado_aborto]` (+ `plan_actualizado` o `abortar`) |
| `peligro`, `ventanas` | `[plan_actualizado]` o `[]` |
| `SPE` `alerta` | `[plan_actualizado]` |
| `SPE` `critico` | `[abortar]` |

## 12. Interfaz Python del optimizador

```python
from optimizador import Motor

motor = Motor(ruta_terreno="terreno/")                   # < 1 s, una vez
motor.cargar_perfil(perfil: dict) -> None                # reinicia la sesión
motor.planificar(pedido: dict) -> dict                   # ≤ 2 s
motor.procesar_evento(evento: dict) -> list[dict]        # estado_astronauta < 5 ms; otros ≤ 2 s
motor.como_mensaje(respuesta: dict) -> dict              # → plan_actualizado, motivo "pedido"
motor.estado() -> dict                                   # plan vigente, último estado_aborto, peligros activos
```

- **Estado interno:** el `Motor` guarda el perfil, el plan vigente, R(p), los peligros activos y el último `estado_astronauta`. Una sola sesión a la vez.
- **Requisitos del que llama:** una llamada a la vez, eventos en orden de `seq`, `cargar_perfil` primero, y las llamadas lentas en un hilo aparte (`asyncio.to_thread`).
- **Excepciones** (heredan de `ErrorOptimizador`): `PedidoInvalido`, `VersionNoSoportada`, `SinPerfil`.
- **Garantías:** siempre hay `ruta_escape` · nunca más de 2 s · determinista con la misma entrada y la misma semilla.
- **Si el backend no es Python:** servicio FastAPI en `:8001`: `POST /perfil`, `POST /plan`, `POST /evento` (devuelve una lista), `GET /estado`.

## 13. Guion de misión (`contratos/ejemplos/guion_mision.json`)

Terreno real `terreno/` · O₂ inicial 170 L (parámetro del escenario en el perfil; la constante del contrato sigue siendo 40 L, que solo da ~50 min) · ~152 min simulados · 7 muestras (sulfatos, filosilicatos, sílice).

| Min. sim. | Evento | Reacción |
|---|---|---|
| 0 | salida del hábitat | plan inicial de 9 sitios |
| 22–143 | 7 muestras (sitios 1, 3, 2, 6, 7, 10, 4) | hitos `muestra` |
| 24,5 | roca de 3 m que el mapa no mostraba, a 30 m sobre la ruta (`bloqueo`) | `peligro`: rodea |
| 55 | la sombra cierra la ventana de un sitio pendiente | `ventana`: sale del plan |
| 81 | fatiga VO₂ ×1,3 de min 80 a 95 | `recalibracion` |
| 88 | arena suelta, ×3 en O₂ (`multiplicador`) | `peligro`: replanifica |
| 125 | `SPE` `alerta`, `llegada_s` = 1500 | ρ = 0,25 |
| 150 | `SPE` `critico` | `abortar` al hábitat |
| 152 | llega al hábitat | quedan ~54 L |

```
python herramientas/generar_registro.py     # logs/sesion-<fecha>-mision.jsonl + .marcadores.json + demo/visor_mision.html
python -m optimizador.pruebas.simular_guion # la misma corrida, solo por consola
```

- La tormenta solar y los demás eventos son **del escenario**, no datos medidos.
- El `.jsonl` trae un mensaje por línea y, además de los del contrato, líneas `hito` (`llegada`, `muestra`, `fin`); quien ignore tipos desconocidos las salta.
- `*.marcadores.json` es la lista de saltos: `{id, t, min, clase, titulo, detalle, linea, nivel}`. `nivel` 1 = botón; `nivel` 2 = llegadas. **Saltar a un instante `t` = reaplicar sobre un estado vacío todos los mensajes con `m.t ≤ t`**. Referencia: `demo/visor_mision.html` (doble clic).
- Los eventos del guion se colocan solos sobre la ruta vigente (`sobre_ruta_m`, `sitio_en_plan`): si cambia el terreno, el guion sigue siendo válido, pero conviene revisar que cada evento caiga donde se quiere.

## 14. Visualización (acordado; detalle en la guía del front)

- El front y el VR **no calculan nada**: todo número en pantalla sale de un mensaje.
- Colores de seguridad: verde (margen > 30 %), ámbar (15–30 %), rojo (≤ 15 % = zona de aborto). Verde, ámbar y rojo solo para seguridad (O₂, peligros, alertas).
- Minerales: filosilicatos #7F77DD círculo · sulfatos #D4537E rombo · hematita #712B13 triángulo · sílice #378ADD cuadrado.
- Ruta por recorrer: línea gruesa clara · recorrida: gris al 40 % · escape: punteada · al replanificar, la ruta vieja se desvanece en 2 s.
- Vistas: lejana (orbital) y astronauta (tercera persona, sobre el hombro). Al llegar un `abortar`: 3 s en la vista lejana.
- Barra de O₂ con una línea fija en `O2_minimo_L`. Cada `plan_actualizado` con `motivo` distinto de `inicial` muestra un aviso de 4 s.
- VR: recorrido de 60–90 s reproduciendo el registro JSONL; plan B: video 360° grabado de la misma corrida.

## 15. Pruebas mínimas del optimizador

- [x] El pedido de ejemplo da un plan factible en menos de 2 s.
- [x] Sin O₂ suficiente → `factible: false` con la vuelta directa.
- [x] El guion de misión produce la reacción esperada en cada evento.
- [x] Cada `estado_astronauta` se procesa en menos de 5 ms.
- [x] Dos corridas con la semilla 42 dan exactamente los mismos mensajes.
- [x] Toda salida valida contra `contratos/schemas/`.

Las cubre `python -m optimizador.pruebas.test_nucleo` (12 pruebas sobre el terreno real).

## 16. Advertencias

- Pandolf a 0,38 g **no está validado**: presentarlo como aproximación de diseño. Contrastar con literatura de locomoción en gravedad reducida.
- No afirmar compatibilidad con hardware de vuelo (RAD750) sin benchmarks propios.
- Todo dato del astronauta es **simulado**; no hay telemetría real. Los valores de VO₂ y frecuencia cardíaca son órdenes de magnitud para la demo, no datos fisiológicos validados.
- La cifra "3,4 veces" que aparecía en material anterior no tiene fuente: no usarla.
- Los índices CRISM son **indicios** espectrales, no detecciones confirmadas: `BD2210_2` (sílice) es débil y ambiguo con arcillas de Al. El `valor` de cada sitio es un criterio nuestro, no una prioridad de la NASA.
- El corregistro de CRISM tiene ±9 m; a esa escala un sitio puede caer en el píxel vecino.
- El umbral de 30° de `peligro` y los parámetros de cada parada son supuestos, no datos.
