# Contrato Albert · API HTTP / WebSocket · v1.0

**Autoridad:** `CLAUDE.md` + contratos adjuntos «Backend ↔ Optimizador» y «Dana ↔ Optimizador» (11-11-2026). El backend no altera unidades ni campos antes de pasar el mensaje al `optimizador.Motor`. Define exclusivamente **transporte, validación, sesión, errores y difusión**.

## Alcance

- Un **solo** `Motor` en memoria por proceso, **una sola EVA por vez** (v1); un `perfil` nuevo reinicia toda la sesión.
- Un perfil válido debe llegar antes de pedir un plan o procesar un evento.
- Los eventos de Dana son JSON UTF-8 con `version:"1.0"`, `seq` comenzando en 1 y subiendo exactamente de 1 en 1, `t` monótono no decreciente, campos `snake_case` y magnitudes en las unidades originales.
- `Motor` ejecuta sus cálculos en `asyncio.to_thread()` bajo un `asyncio.Lock` compartido. No se invoca simultáneamente desde HTTP y WS.
- Los datos de terreno `terreno/` son 96×96, 2.5 m, coordenadas locales ENU (x este, y norte), **sintéticos**. El origen definitivo para el frontend sigue pendiente de acuerdo. No hay conversión a Jezero ni a RGBA.
- No se genera telemetría real en Albert; Dana envía **la telemetría y es quien descuenta O₂**.

## HTTP

Base por defecto: `http://localhost:8000`. OpenAPI: `/docs`.

| Método | Ruta | Entrada | Salida | Dueño |
| --- | --- | --- | --- | --- |
| GET | `/health` | — | estado servidor / motor | Todos |
| GET | `/api/v1/contrato` | — | descubrimiento de rutas/roles | Todos |
| GET | `/api/v1/terreno` | — | `manifest.json` sin cambios | Front, VR |
| GET | `/api/v1/terreno/sitios` | — | `sitios.json` sin cambios | Front, VR |
| GET | `/api/v1/terreno/capas/{nombre}` | — | bytes originales `float32 LE` o `uint8`, fila 0=sur | Front, VR |
| GET | `/api/v1/demo/perfil` | — | `perfil` del guion de ejemplo | Tests |
| GET | `/api/v1/demo/pedido` | — | pedido de ejemplo de 12 sitios | Tests |
| POST | `/api/v1/perfil` | Perfil de Dana v1 | `{version, tipo:"perfil_cargado", escenario_id}` | Dana o pruebas |
| POST | `/api/v1/plan` | Pedido v1 del front | **Respuesta del Motor sin alteración** | Front |
| POST | `/api/v1/evento` | Evento v1 de Dana | `ack` y `mensajes_motor` originales | Dana o pruebas |
| GET | `/api/v1/estado` | — | `snapshot` con `estado()` y último evento | Front, VR |
| GET | `/api/v1/sesion/log` | — | JSONL de la sesión actual | VR, demo |

Ejemplo para HTTP `POST /api/v1/evento`:

```json
{"version":"1.0","t":0,"hora_solar":10,"seq":1,"tipo":"telemetria_astronauta","datos":{"x":120,"y":120,"sigma_m":0,"O2_restante_L":40,"VO2_L_min":0.745,"FC_lpm":111,"velocidad_m_s":0,"carga_kg":0}}
```

Respuesta HTTP del backend (el Motor retorna los mensajes bajo `mensajes_motor`):

```json
{"version":"1.0","tipo":"ack","seq":1,"mensajes_motor":[{"version":"1.0","tipo":"estado_aborto","t":0,"O2_restante_L":40,"R_L":0,"O2_minimo_L":0,"margen_pct":9999}]}
```

El ejemplo numérico anterior es ilustrativo; los valores reales del motor variarán según la ubicación y el perfil.

## WebSocket

**URL:** `ws://localhost:8000/ws?rol=dana` para productor; `?rol=front` y `?rol=vr` para suscriptores. Acepta como máximo **un Dana productor conectado**. Varios front/VR pueden escuchar simultáneamente.

- Al conectar, todos reciben un mensaje `snapshot`: `{"version":"1.0","tipo":"snapshot","perfil":null|{...},"estado":null|{...},"ultima_telemetria":{},"ultimo_seq":0}`. Si ya existe una EVA, contiene su último estado.
- `rol=dana` envía **el perfil completo** `tipo:"perfil"` y después **eventos completos**; no mete el evento dentro de otra envoltura. Recibe `perfil_cargado` y, por cada evento válido, los mensajes de `Motor` y un `ack` con `seq` y `mensajes_emitidos` (el `ack` suele llegar después de los mensajes del motor, sin duplicarlos dentro del ACK). Si hay un error recibe `{"version":"1.0","tipo":"error","codigo":"...","detalle":"..."}` y el evento se descarta.
- `rol=front` y `rol=vr` solo escuchan. Reciben perfiles/telemetrías/eventos originales de Dana y las salidas `plan_actualizado`, `estado_aborto`, `abortar` de `Motor`. **No recalculan las métricas.**
- Cuando el front hace `POST /api/v1/plan`, la respuesta HTTP contiene el plan puro y la difusión WebSocket contiene el `plan_actualizado` generado con `Motor.como_mensaje(...), motivo:"pedido"`. El primer `plan_actualizado` automático al recibir telemetría sin plan tiene `motivo:"inicial"`.
- Eventos desconocidos bien formados se ignoran (no se reenvían al optimizador), pero **consumen su `seq`** para evitar que una extensión desconocida bloquee la siguiente lectura válida. Retornan `tipo:"ignorado"` solo a Dana.
- Si un receptor no lee lo suficientemente rápido y su cola se llena, el servidor cierra ese receptor con 1013 en vez de perder silenciosamente eventos. Tras reconectar recibe el snapshot vigente.
- No hay replay continuo automático del JSONL por WS: VR puede descargar y reproducir `/api/v1/sesion/log`.

### Error HTTP / WS

```json
{"version":"1.0","tipo":"error","codigo":"seq_fuera_de_orden","detalle":"Se esperaba seq=2, se recibió 3"}
```

- **422**: `contrato_invalido`, `version_no_soportada`, `pedido_invalido`, `fuera_del_mapa`.
- **409**: `sin_perfil`, `seq_fuera_de_orden`, `tiempo_retrocede`, `sesion_abortada`.
- **500**: `motor_error` (fallo inesperado, sin filtrar trazas al cliente).
- **401**: token HTTP inválido (si está configurado). WS inválido: cierre **1008**.

### Autorización y despliegue

En **desarrollo local**, `ARES_WRITE_TOKEN` y `ARES_READ_TOKEN` pueden estar vacíos; la API Docker se publica solo en `127.0.0.1:8000` por defecto. Para exponerla a otros equipos, configurar secretos no triviales y HTTPS/WSS detrás de proxy.

- HTTP escritura: `X-API-Key: <ARES_WRITE_TOKEN>` o `Authorization: Bearer <token>`.
- HTTP lectura: igual, usando `ARES_READ_TOKEN`.
- WS: parámetro `&token=...` o encabezado `X-API-Key` si el cliente lo admite. Evita secretos en URLs/proxies públicos.
- Solo orígenes web configurados en `ARES_CORS_ORIGINS` son aceptados en navegador para HTTP/WS. Los clientes no navegador pueden omitir `Origin`.
- **No configurar múltiples trabajadores Uvicorn ni múltiples réplicas**, porque cada uno tendría un Motor independiente y rompería la sesión única. Para escalar se necesitaría un dueño de sesión externo y un bus de eventos compartido (fuera de v1).

## JSONL

`logs/sesion-YYYYMMDDTHHMMSSZ-escenario-id-xxxxxxxx.jsonl` (dentro del volumen Docker), con un registro por mensaje y campos:

```json
{"timestamp_utc":"2026-11-12T12:00:00+00:00","direccion":"entrada","canal":"ws:dana","mensaje":{"version":"1.0","tipo":"perfil"}}
```

Direcciones `entrada`, `salida`, `rechazado`, `ignorado`. El JSONL contiene telemetría simulada, no datos biométricos reales. No se registran tokens.

## Tres acuerdos pendientes (NO asumir)

1. Carla/Anni/Ignacio: origen geográfico exacto y correspondencia con el modelo Blender; el contrato local ENU ya existe.
2. Dana/Albert: URL final WSS, tokens si se despliega y duración/reloj de la demo. **El perfil y `seq` deben reiniciarse juntos**.
3. Equipo: el guion actual del repositorio dura unos 26–28 min simulados (~1 min real a ×30). No es el guion antiguo de 175 min; su física y tiempos deberán acordarse con Dana.
