"""Single-session coordinator with serialized Motor calls and ordered broadcast."""
from __future__ import annotations
import asyncio
import copy
import json
import logging
from pathlib import Path
from fastapi import HTTPException
from pydantic import ValidationError
from optimizador import Motor, PedidoInvalido, SinPerfil, VersionNoSoportada
from .hub import Hub
from .journal import Journal
from .schemas import validate_profile, validate_plan, validate_event
from .output_schemas import PlanSalida, check_output
from .settings import Settings

logger = logging.getLogger('ares.backend')


class BackendError(Exception):
    def __init__(self, status: int, code: str, detail: str):
        self.status, self.code, self.detail = status, code, detail
        super().__init__(detail)

    def as_payload(self) -> dict:
        return {'version': '1.0', 'tipo': 'error', 'codigo': self.code, 'detalle': self.detail}


def convert_error(exc: Exception) -> BackendError:
    if isinstance(exc, BackendError):
        return exc
    if isinstance(exc, ValidationError):
        issues = '; '.join('.'.join(str(t) for t in err['loc']) + ': ' + err['msg'] for err in exc.errors()[:4])
        return BackendError(422, 'contrato_invalido', issues)
    if isinstance(exc, VersionNoSoportada):
        return BackendError(422, 'version_no_soportada', str(exc))
    if isinstance(exc, PedidoInvalido):
        return BackendError(422, 'pedido_invalido', str(exc))
    if isinstance(exc, SinPerfil):
        return BackendError(409, 'sin_perfil', str(exc))
    if isinstance(exc, (KeyError, ValueError, TypeError)):
        return BackendError(422, 'contrato_invalido', str(exc))
    logger.exception('Error interno de integración con el Motor', exc_info=exc)
    return BackendError(500, 'motor_error', 'El optimizador reportó un error interno')


class Service:
    def __init__(self, settings: Settings, motor: Motor):
        self.settings = settings
        self.motor = motor
        self.lock = asyncio.Lock()  # HTTP and WS share one Motor; calls never overlap
        self.hub = Hub(settings.ws_queue_limit)
        self.journal = Journal(settings.logs_dir)
        self.profile: dict | None = None
        self.last_seq = 0
        self.last_t = -1.0
        self.last_telemetry: dict[str, dict] = {}

    def snapshot_locked(self) -> dict:
        state = self.motor.estado() if self.profile is not None else None
        return {'version': '1.0', 'tipo': 'snapshot',
                'perfil': copy.deepcopy(self.profile), 'estado': state,
                'ultima_telemetria': copy.deepcopy(self.last_telemetry),
                'ultimo_seq': self.last_seq}

    async def snapshot(self) -> dict:
        async with self.lock:
            return await asyncio.to_thread(self.snapshot_locked)

    async def load_profile(self, profile: dict, channel: str) -> dict:
        try:
            validate_profile(profile)
            async with self.lock:
                await asyncio.to_thread(self.motor.cargar_perfil, profile)
                self.profile = copy.deepcopy(profile)
                self.last_seq, self.last_t = 0, -1.0
                self.last_telemetry.clear()
                self.journal.new_session(profile['escenario_id'])
                await asyncio.to_thread(self.journal.record, 'entrada', profile, channel)
                # Broadcast original message exactly; Dana is the source of truth.
                self.hub.enqueue(profile)
                return {'version': '1.0', 'tipo': 'perfil_cargado', 'escenario_id': profile['escenario_id']}
        except Exception as exc:
            raise convert_error(exc) from exc

    def _inside_map(self, x: float, y: float) -> bool:
        ter = self.motor.terreno
        return ter.x0 <= x < ter.x0 + ter.columnas * ter.tam and ter.y0 <= y < ter.y0 + ter.filas * ter.tam

    def _check_coords(self, x: float, y: float) -> None:
        if not self._inside_map(x, y):
            raise BackendError(422, 'fuera_del_mapa', f'Coordenadas fuera de la malla: ({x},{y})')

    async def plan(self, pedido: dict, channel: str) -> dict:
        try:
            validate_plan(pedido)
            self._check_coords(pedido['inicio']['x'], pedido['inicio']['y'])
            for s in pedido['sitios']:
                self._check_coords(s['x'], s['y'])
            async with self.lock:
                if self.profile is None:
                    raise BackendError(409, 'sin_perfil', 'Debes cargar un perfil antes de solicitar planes')
                if self.motor.estado().get('abortado'):
                    raise BackendError(409, 'sesion_abortada', 'Carga un perfil nuevo para volver a planificar')
                response = await asyncio.to_thread(self.motor.planificar, pedido)
                PlanSalida.model_validate(response)  # verify, but return the original dict
                event = self.motor.como_mensaje(response)
                check_output(event)
                await asyncio.to_thread(self.journal.record, 'entrada', pedido, channel)
                await asyncio.to_thread(self.journal.record, 'salida', event, 'motor')
                self.hub.enqueue(event, roles=('dana','front','vr'))
                return response
        except Exception as exc:
            raise convert_error(exc) from exc

    async def hito(self, evento: dict, channel: str) -> dict:
        """`hito` (contratos/schemas/hito.json, INTEGRACION §5.1): flat message from the telemetry that does
        NOT consume `seq` and that the Motor ignores. The views need it (a site is "recogido" on its hito
        `muestra`, §5.4), so it is logged and broadcast as is."""
        if evento.get('clase') not in ('llegada', 'muestra', 'fin') or not isinstance(evento.get('t'), (int, float)):
            raise BackendError(422, 'contrato_invalido', 'hito requiere clase (llegada|muestra|fin) y t')
        async with self.lock:
            if self.profile is None:
                raise BackendError(409, 'sin_perfil', 'No se aceptan eventos sin perfil')
            await asyncio.to_thread(self.journal.record, 'entrada', evento, channel)
            self.hub.enqueue(evento)
        return {'version': '1.0', 'tipo': 'ack', 'seq': None, 'mensajes_motor': []}

    async def event(self, evento: dict, channel: str) -> dict:
        if isinstance(evento, dict) and evento.get('tipo') == 'hito':
            return await self.hito(evento, channel)
        try:
            supported = validate_event(evento)
            if supported and evento['tipo'] in ('telemetria_astronauta', 'telemetria_rover', 'peligro'):
                self._check_coords(evento['datos']['x'], evento['datos']['y'])
            async with self.lock:
                if self.profile is None:
                    raise BackendError(409, 'sin_perfil', 'No se aceptan eventos sin perfil')
                if evento['seq'] != self.last_seq + 1:
                    raise BackendError(409, 'seq_fuera_de_orden', f'Se esperaba seq={self.last_seq+1}, se recibió {evento["seq"]}')
                if evento['t'] < self.last_t:
                    raise BackendError(409, 'tiempo_retrocede', f't={evento["t"]} menor que t previo={self.last_t}')
                if not supported:
                    # Consume the sequence even for unknown types, so later valid events
                    # cannot be blocked by a previously received unknown event.
                    self.last_seq, self.last_t = evento['seq'], evento['t']
                    await asyncio.to_thread(self.journal.record, 'ignorado', evento, channel)
                    return {'version': '1.0', 'tipo': 'ignorado', 'seq': evento['seq'], 'razon': 'tipo_desconocido'}
                messages = await asyncio.to_thread(self.motor.procesar_evento, evento)
                for message in messages:
                    check_output(message)
                self.last_seq, self.last_t = evento['seq'], evento['t']
                if evento['tipo'].startswith('telemetria_'):
                    self.last_telemetry[evento['tipo']] = copy.deepcopy(evento)
                await asyncio.to_thread(self.journal.record, 'entrada', evento, channel)
                self.hub.enqueue(evento)
                for message in messages:
                    await asyncio.to_thread(self.journal.record, 'salida', message, 'motor')
                    self.hub.enqueue(message, roles=('dana','front','vr'))
                return {'version': '1.0', 'tipo': 'ack', 'seq': evento['seq'], 'mensajes_motor': messages}
        except Exception as exc:
            error = convert_error(exc)
            logger.warning('Evento rechazado: %s (%s)', error.code, error.detail)
            if self.journal.path is not None:
                async with self.lock:
                    await asyncio.to_thread(self.journal.record, 'rechazado',
                                            {'evento': evento, 'error': error.as_payload()}, channel)
            raise error from exc
