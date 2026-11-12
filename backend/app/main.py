"""ARES-TWIN Albert adapter: HTTP + WebSocket transport, no routing physics."""
from __future__ import annotations

import asyncio
import json
import logging
import secrets
from contextlib import asynccontextmanager, suppress
from pathlib import Path
from typing import Callable

from fastapi import Body, Depends, FastAPI, Header, HTTPException, Query, Request, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from optimizador import Motor

from .service import BackendError, Service
from .settings import Settings

logger = logging.getLogger('ares.backend')
logging.basicConfig(level=logging.INFO, format='%(asctime)s %(levelname)s %(name)s: %(message)s')


def create_app(settings: Settings | None = None, motor_factory: Callable = Motor) -> FastAPI:
    settings = settings or Settings()

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        motor = await asyncio.to_thread(motor_factory, str(settings.terrain_dir))
        app.state.backend = Service(settings, motor)
        logger.info('Motor inicializado: %s', settings.terrain_dir)
        yield

    app = FastAPI(title='ARES-TWIN · Backend Albert', version='1.0.0', lifespan=lifespan,
                  description='API HTTP/WS de sesión única. Contrato JSON v1.0 de CLAUDE.md.')
    app.add_middleware(CORSMiddleware, allow_origins=list(settings.cors_origins),
                       allow_methods=['GET', 'POST'], allow_headers=['Content-Type', 'Authorization', 'X-API-Key'])

    @app.exception_handler(BackendError)
    async def backend_exception(_request: Request, exc: BackendError):
        return JSONResponse(status_code=exc.status, content=exc.as_payload())

    def current(req: Request) -> Service:
        return req.app.state.backend

    def authorized(token: str, required: str) -> bool:
        return not required or bool(token) and secrets.compare_digest(token, required)

    def _header_token(api_key: str | None, authorization: str | None) -> str:
        if api_key:
            return api_key
        if authorization and authorization.lower().startswith('bearer '):
            return authorization[7:]
        return ''

    async def writer_auth(x_api_key: str | None = Header(None), authorization: str | None = Header(None)):
        if not authorized(_header_token(x_api_key, authorization), settings.write_token):
            raise HTTPException(401, detail='Token de escritura requerido')

    async def reader_auth(x_api_key: str | None = Header(None), authorization: str | None = Header(None)):
        if not authorized(_header_token(x_api_key, authorization), settings.read_token):
            raise HTTPException(401, detail='Token de lectura requerido')

    @app.get('/health', tags=['Salud'])
    def health():
        return {'version': '1.0', 'servicio': 'backend', 'estado': 'ok',
                'motor': 'cargado', 'sitio': 'Mount Sharp (Gale)', 'sesion_unica': True}

    @app.get('/api/v1/contrato', dependencies=[Depends(reader_auth)], tags=['Contrato'])
    def contract():
        return {'version': '1.0', 'ws': '/ws?rol=dana|front|vr',
                'http': {'perfil': '/api/v1/perfil', 'plan': '/api/v1/plan',
                         'evento': '/api/v1/evento', 'estado': '/api/v1/estado'},
                'roles': {'dana': 'publica perfil y eventos', 'front': 'recibe telemetria y planes',
                          'vr': 'recibe telemetria y planes'},
                'seq': 'consecutivo desde 1 por sesion; t no decreciente',
                'motor': 'singleton; una llamada a la vez; asyncio.to_thread'}

    @app.get('/api/v1/terreno', dependencies=[Depends(reader_auth)], tags=['Terreno'])
    def terrain_manifest():
        return json.loads((settings.terrain_dir / 'manifest.json').read_text(encoding='utf-8'))

    @app.get('/api/v1/terreno/sitios', dependencies=[Depends(reader_auth)], tags=['Terreno'])
    def terrain_sites():
        return json.loads((settings.terrain_dir / 'sitios.json').read_text(encoding='utf-8'))

    @app.get('/api/v1/terreno/capas/{nombre}', dependencies=[Depends(reader_auth)], tags=['Terreno'])
    def terrain_layer(nombre: str):
        manifest = json.loads((settings.terrain_dir / 'manifest.json').read_text(encoding='utf-8'))
        info = manifest['capas'].get(nombre)
        if info is None:
            raise HTTPException(404, 'Capa de terreno no encontrada')
        filename = info['archivo'] if isinstance(info, dict) else info
        filename = Path(filename).name  # Avoid path traversal from manifests
        return FileResponse(settings.terrain_dir / filename, media_type='application/octet-stream',
                            filename=filename, headers={'X-ARES-Dtype': info.get('dtype','float32') if isinstance(info,dict) else 'float32',
                                                        'X-ARES-Fila-0': manifest.get('fila_0','sur')})

    @app.get('/api/v1/demo/pedido', dependencies=[Depends(reader_auth)], tags=['Demo'])
    def demo_plan():
        return json.loads((settings.examples_dir / 'pedido.json').read_text(encoding='utf-8'))

    @app.get('/api/v1/demo/perfil', dependencies=[Depends(reader_auth)], tags=['Demo'])
    def demo_profile():
        return json.loads((settings.examples_dir / 'guion_demo.json').read_text(encoding='utf-8'))['perfil']

    @app.post('/api/v1/perfil', dependencies=[Depends(writer_auth)], tags=['Sesion'])
    async def profile(req: Request, body: dict = Body(...)):
        return await current(req).load_profile(body, 'http')

    @app.post('/api/v1/plan', dependencies=[Depends(writer_auth)], tags=['Sesion'])
    async def plan(req: Request, body: dict = Body(...)):
        return await current(req).plan(body, 'http')

    @app.post('/api/v1/evento', dependencies=[Depends(writer_auth)], tags=['Sesion'])
    async def event(req: Request, body: dict = Body(...)):
        return await current(req).event(body, 'http')

    @app.get('/api/v1/estado', dependencies=[Depends(reader_auth)], tags=['Sesion'])
    async def state(req: Request):
        return await current(req).snapshot()

    @app.get('/api/v1/sesion/log', dependencies=[Depends(reader_auth)], tags=['Sesion'])
    def log(req: Request):
        path = current(req).journal.path
        if path is None or not path.is_file():
            raise HTTPException(404, 'No hay registro de sesión todavía')
        return FileResponse(path, media_type='application/x-ndjson', filename=path.name)

    @app.websocket('/ws')
    async def ws_endpoint(ws: WebSocket, rol: str = Query('front'), token: str = Query('')):
        service: Service = ws.app.state.backend
        if rol not in ('dana', 'front', 'vr'):
            await ws.close(code=1008, reason='Rol no valido')
            return
        origin = ws.headers.get('origin')
        if origin and origin not in settings.cors_origins:
            await ws.close(code=1008, reason='Origin no permitido')
            return
        secret = settings.write_token if rol == 'dana' else settings.read_token
        if not authorized(token or ws.headers.get('x-api-key',''), secret):
            await ws.close(code=1008, reason='Token no autorizado')
            return
        async with service.lock:
            client = service.hub.attach(ws, rol)
            if client is None:
                await ws.close(code=1008, reason='Ya existe productor Dana conectado')
                return
            # Queue snapshot under the same lock to guarantee correct ordering.
            snapshot = await asyncio.to_thread(service.snapshot_locked)
            client.queue.put_nowait(snapshot)
        await ws.accept()
        sender = asyncio.create_task(service.hub.sender(client))
        try:
            while True:
                raw = await ws.receive_text()
                if rol != 'dana':
                    client.queue.put_nowait({'version':'1.0', 'tipo':'error',
                                             'codigo':'solo_lectura', 'detalle':'Este rol solo recibe mensajes'})
                    continue
                if len(raw.encode('utf-8')) > settings.ws_message_bytes:
                    client.queue.put_nowait({'version':'1.0', 'tipo':'error',
                                             'codigo':'mensaje_grande', 'detalle':'Supera tamaño máximo'})
                    continue
                try:
                    data = json.loads(raw, parse_constant=lambda s: (_ for _ in ()).throw(ValueError(s)))
                    if not isinstance(data, dict):
                        raise ValueError('Se requiere objeto JSON')
                    if data.get('tipo') == 'perfil':
                        response = await service.load_profile(data, 'ws:dana')
                    else:
                        response = await service.event(data, 'ws:dana')
                        if response['tipo'] == 'ack':
                            # WS already receives raw Motor messages separately.
                            # Do not duplicate them inside the acknowledgment.
                            response = {'version':'1.0', 'tipo':'ack', 'seq': response['seq'],
                                        'mensajes_emitidos': len(response['mensajes_motor'])}
                except (BackendError, ValueError, TypeError) as exc:
                    response = exc.as_payload() if isinstance(exc, BackendError) else {
                        'version':'1.0', 'tipo':'error', 'codigo':'json_invalido', 'detalle':str(exc)}
                client.queue.put_nowait(response)
        except (WebSocketDisconnect, RuntimeError, asyncio.CancelledError):
            pass
        finally:
            service.hub.detach(client)
            sender.cancel()
            with suppress(asyncio.CancelledError, Exception):
                await sender

    return app


app = create_app()
