# Backend Albert — ARES-TWIN

Implementación FastAPI + WebSocket del contrato **v1.0** establecido en `../CLAUDE.md`. Usa **directamente** `optimizador.Motor`; no inventa rutas ni modifica la física. Parte de un terreno **sintético** de Mount Sharp/Gale de `../terreno/`, de 96×96 celdas × 2,5 m.

## Arranque (desde la raíz del repositorio)

```bash
cp .env.example .env
# Desarrollo local: las variables de token pueden quedar vacías.
docker compose up --build -d
docker compose ps
docker compose logs -f backend
```

- API: http://localhost:8000/docs
- Estado: http://localhost:8000/health
- Metadata de mapa: http://localhost:8000/api/v1/terreno

**No requiere PostGIS:** el contrato actual mantiene un solo `Motor` en memoria y registros JSONL. Las capas binarias permanecen en `terreno/`, sin conversión a PNG RGBA.

## Prueba manual con Git Bash, Linux/WSL o macOS

```bash
curl -s http://localhost:8000/health
curl -s http://localhost:8000/api/v1/demo/perfil -o perfil.json
curl -s http://localhost:8000/api/v1/demo/pedido -o pedido.json
curl -s -X POST http://localhost:8000/api/v1/perfil -H 'Content-Type: application/json' --data-binary @perfil.json
curl -s -X POST http://localhost:8000/api/v1/plan -H 'Content-Type: application/json' --data-binary @pedido.json
curl -s http://localhost:8000/api/v1/estado
curl -s http://localhost:8000/api/v1/sesion/log -o sesion.jsonl
```

Si tienes `python` en tu equipo y el paquete `websockets` (instalado al instalar `requirements-dev.txt`), prueba todo el flujo por WebSocket:

```bash
python -m backend.scripts.smoke_ws
```

Este guion es **solo prueba de integración**. No reproduce todos los datos biométricos de Dana ni emula automáticamente el movimiento del astronauta.

## Ejecutar sin Docker

En la **raíz** del repositorio (para resolver `optimizador` y `terreno`):

```bash
python -m venv .venv
source .venv/bin/activate
pip install -r backend/requirements-dev.txt
uvicorn backend.app.main:app --host 127.0.0.1 --port 8000 --workers 1
```

Para pruebas:

```bash
python -m pytest backend/tests optimizador/pruebas -q
```

## Backend: responsabilidades por archivo

| Archivo | Para qué sirve |
| --- | --- |
| `app/main.py` | Rutas HTTP, conexión WebSocket, permisos y arranque |
| `app/service.py` | Única sesión; validación de orden `seq/t`, serializa llamadas a Motor y difunde salidas |
| `app/schemas.py` | Valida el contrato exacto de perfil, pedido y tipos de eventos |
| `app/output_schemas.py` | Valida que el Motor siga el contrato de salida (sin cambiar la respuesta) |
| `app/hub.py` | Gestiona clientes WebSocket con colas independientes y roles |
| `app/journal.py` | Registro reproducible y auditable por sesión en JSONL |
| `app/settings.py` | Directorios, CORS, tokens y límites |
| `tests/` | Pruebas de HTTP, WebSocket, secuencias y respuesta del optimizador |
| `scripts/smoke_ws.py` | Envío de perfil + eventos para prueba sin Dana |

## Ejemplo de Carla/Anni: escuchar el stream

```javascript
const ws = new WebSocket('ws://localhost:8000/ws?rol=front');
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (m.tipo === 'snapshot') console.log('Estado inicial', m.estado);
  if (m.tipo === 'telemetria_astronauta') console.log('O2', m.datos.O2_restante_L);
  if (m.tipo === 'estado_aborto') console.log('Margen', m.margen_pct);
  if (m.tipo === 'plan_actualizado') console.log('Nueva ruta', m.plan.polilinea);
  if (m.tipo === 'abortar') console.log('Ruta escape', m.ruta_escape);
};
```

El front solicita un nuevo plan con `POST /api/v1/plan` enviando el JSON de su contrato. Los mensajes de Dana **no** deben enviarse al optimizador directamente, sino al WebSocket del backend con `?rol=dana`.

Para la especificación completa (errores, secuencia, seguridad, salidas y significado de cada ruta): [`CONTRATO_BACKEND_V1.md`](CONTRATO_BACKEND_V1.md).

## Integración y limitaciones

- La sesión no sobrevive a reiniciar el proceso. JSONL conserva el registro para VR y auditoría; no rehidrata Motor tras reinicio. Enviar de nuevo `perfil` e iniciar `seq=1`.
- El backend no hace streaming por cuenta propia: espera al productor Dana. El tiempo del backend no sustituye `t`/`hora_solar` de la simulación.
- Los datos de terreno en `terreno/` son sintéticos. No convertirlos en mapas NASA medidos sin un ETL de datos reales aparte.
- Una sola instancia Uvicorn/worker 1, rol `dana` escritor único, lectores múltiples. Registro persistente en volumen Docker `ares_logs`; puede descargarse desde HTTP.
- En modo Docker, para conectar frontend desde otra máquina hay que exponer el puerto, configurar CORS/tokens y proteger con HTTPS/WSS.

## Orientación del contrato (nota de main)


Lee primero: `contratos/INTEGRACION.md §5.3 y §7`.

- Todo lo tuyo en el contrato está marcado como **[Propuesta]**: ajústalo y avisa antes del 18-nov.
- Recibes eventos de la telemetría, se los pasas al `Motor` de uno en uno y en orden de `seq`, y difundes todo a las vistas.
- Uso del optimizador (CLAUDE.md §12):

```python
from optimizador import Motor
motor = Motor("terreno/")
motor.cargar_perfil(perfil)
salidas = motor.procesar_evento(evento)   # lista de mensajes; llamadas lentas en un hilo aparte
```

- Registras cada mensaje en `logs/sesion-<fecha>.jsonl` y sirves `terreno/` tal cual por HTTP.
- Para reproducir y saltar: INTEGRACION §6.5. Ya hay un registro completo en `logs/` para probar sin telemetría.
