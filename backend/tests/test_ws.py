from fastapi.testclient import TestClient
from backend.app.settings import Settings, ROOT
from backend.app.main import create_app
from .conftest import tele


def test_front_receives_raw_messages_ordered(client, fixtures):
    with client.websocket_connect('/ws?rol=front') as viewer:
        snap=viewer.receive_json()
        assert snap['tipo']=='snapshot' and snap['estado'] is None
        with client.websocket_connect('/ws?rol=dana') as producer:
            assert producer.receive_json()['tipo']=='snapshot'
            producer.send_json(fixtures['perfil'])
            assert producer.receive_json()['tipo']=='perfil_cargado'
            assert viewer.receive_json()==fixtures['perfil']
            producer.send_json(tele(1))
            # Optimizer messages are delivered raw to Dana, followed by ack.
            m1=producer.receive_json(); m2=producer.receive_json(); ack=producer.receive_json()
            assert [m1['tipo'],m2['tipo']]==['estado_aborto','plan_actualizado']
            assert ack['tipo']=='ack' and ack['seq']==1
            assert viewer.receive_json()['tipo']=='telemetria_astronauta'
            assert viewer.receive_json()['tipo']=='estado_aborto'
            planned=viewer.receive_json()
            assert planned['tipo']=='plan_actualizado' and planned['motivo']=='inicial'
            producer.send_json(tele(1))
            err=producer.receive_json()
            assert err['tipo']=='error' and err['codigo']=='seq_fuera_de_orden'


def test_http_plan_broadcast_to_vr(client,fixtures):
    client.post('/api/v1/perfil',json=fixtures['perfil'])
    with client.websocket_connect('/ws?rol=vr') as vr:
        assert vr.receive_json()['tipo']=='snapshot'
        plan=client.post('/api/v1/plan',json=fixtures['pedido']).json()
        msg=vr.receive_json()
        assert msg['tipo']=='plan_actualizado'
        assert msg['plan']==plan
        vr.send_json({'version':'1.0','tipo':'perfil'})
        assert vr.receive_json()['codigo']=='solo_lectura'


def test_spe_critical_broadcast(client,fixtures):
    client.post('/api/v1/perfil',json=fixtures['perfil'])
    with client.websocket_connect('/ws?rol=front') as viewer:
        viewer.receive_json()
        ev={'version':'1.0','t':2,'hora_solar':10,'seq':1,'tipo':'SPE','datos':{'nivel':'critico','llegada_s':0}}
        result=client.post('/api/v1/evento',json=ev)
        assert result.status_code==200
        assert viewer.receive_json()==ev
        msg=viewer.receive_json()
        assert msg['tipo']=='abortar' and msg['motivo']=='spe_critico'


def test_write_token_required(tmp_path,fixtures):
    conf=Settings(terrain_dir=ROOT/'terreno',examples_dir=ROOT/'contratos'/'ejemplos',
                  logs_dir=tmp_path,write_token='supersecret',read_token='readsecret',
                  cors_origins=('http://localhost:5173',))
    with TestClient(create_app(settings=conf)) as c:
        assert c.post('/api/v1/perfil',json=fixtures['perfil']).status_code==401
        assert c.get('/api/v1/estado').status_code==401
        assert c.post('/api/v1/perfil',json=fixtures['perfil'],headers={'x-api-key':'supersecret'}).status_code==200
        assert c.get('/api/v1/estado',headers={'x-api-key':'readsecret'}).status_code==200
        with c.websocket_connect('/ws?rol=front&token=readsecret') as ws:
            assert ws.receive_json()['tipo']=='snapshot'


def test_one_dana_writer_only(client):
    from starlette.websockets import WebSocketDisconnect
    with client.websocket_connect('/ws?rol=dana') as writer:
        assert writer.receive_json()['tipo']=='snapshot'
        try:
            with client.websocket_connect('/ws?rol=dana') as second:
                second.receive_json()
        except WebSocketDisconnect as exc:
            assert exc.code == 1008
        else:
            raise AssertionError('El segundo productor no debe conectarse')
