import copy
import json
from .conftest import tele


def test_health_terrain_and_contract(client):
    assert client.get('/health').json()['estado']=='ok'
    m=client.get('/api/v1/terreno').json()
    assert (m['filas'],m['columnas'],m['fila_0']) == (96,96,'sur')
    assert len(client.get('/api/v1/terreno/capas/elevacion').content)==96*96*4
    assert len(client.get('/api/v1/terreno/capas/peligro').content)==96*96
    assert len(client.get('/api/v1/terreno/sitios').json()['sitios'])==12
    assert client.get('/api/v1/terreno/capas/missing').status_code==404
    assert client.get('/api/v1/contrato').json()['version']=='1.0'
    assert client.get('/api/v1/estado').json()['estado'] is None


def test_profile_plan_telemetry_log(client, fixtures):
    assert client.post('/api/v1/plan', json=fixtures['pedido']).status_code==409
    assert client.post('/api/v1/evento',json=tele(1)).status_code==409
    assert client.post('/api/v1/perfil',json=fixtures['perfil']).status_code==200
    plan=client.post('/api/v1/plan',json=fixtures['pedido'])
    assert plan.status_code==200, plan.text
    assert plan.json()['factible'] and plan.json()['ruta_escape']
    assert plan.json()['orden'][0]=='H'
    event=client.post('/api/v1/evento',json=tele(1))
    assert event.status_code==200
    assert [m['tipo'] for m in event.json()['mensajes_motor']]==['estado_aborto']
    assert client.get('/api/v1/estado').json()['ultimo_seq']==1
    lines=[json.loads(ln) for ln in client.get('/api/v1/sesion/log').text.splitlines()]
    assert any(x['mensaje'].get('tipo')=='estado_aborto' for x in lines)
    assert any(x['mensaje'].get('tipo')=='plan_actualizado' for x in lines)
    assert [x['direccion'] for x in lines].count('entrada')==3


def test_initial_plan_from_first_telemetry(client,fixtures):
    client.post('/api/v1/perfil',json=fixtures['perfil'])
    result=client.post('/api/v1/evento',json=tele(1))
    assert result.status_code==200
    types=[m['tipo'] for m in result.json()['mensajes_motor']]
    assert types==['estado_aborto','plan_actualizado']
    assert result.json()['mensajes_motor'][-1]['motivo']=='inicial'


def test_seq_time_and_reset(client,fixtures):
    client.post('/api/v1/perfil',json=fixtures['perfil'])
    assert client.post('/api/v1/evento',json=tele(1,t=10)).status_code==200
    duplicate=client.post('/api/v1/evento',json=tele(1,t=20))
    assert duplicate.status_code==409 and duplicate.json()['codigo']=='seq_fuera_de_orden'
    skipped=client.post('/api/v1/evento',json=tele(3,t=20))
    assert skipped.status_code==409
    backward=client.post('/api/v1/evento',json=tele(2,t=5))
    assert backward.status_code==409 and backward.json()['codigo']=='tiempo_retrocede'
    assert client.get('/api/v1/estado').json()['ultimo_seq']==1
    unknown={'version':'1.0','seq':2,'t':20,'hora_solar':10,'tipo':'futura_extension','datos':{}}
    assert client.post('/api/v1/evento',json=unknown).json()['tipo']=='ignorado'
    assert client.post('/api/v1/evento',json=tele(3,t=30)).status_code==200
    client.post('/api/v1/perfil',json=fixtures['perfil'])
    assert client.get('/api/v1/estado').json()['ultimo_seq']==0
    assert client.post('/api/v1/evento',json=tele(1)).status_code==200


def test_contract_validation_422(client,fixtures):
    invalid=copy.deepcopy(fixtures['perfil']);invalid['version']='2.0'
    assert client.post('/api/v1/perfil',json=invalid).status_code==422
    client.post('/api/v1/perfil',json=fixtures['perfil'])
    invalid=copy.deepcopy(fixtures['pedido']);invalid['sitios'][0]['mineral']='oro'
    assert client.post('/api/v1/plan',json=invalid).status_code==422
    invalid=copy.deepcopy(fixtures['pedido']);invalid['sitios'][0]['x']=999999
    assert client.post('/api/v1/plan',json=invalid).json()['codigo']=='fuera_del_mapa'
    invalid=copy.deepcopy(fixtures['pedido']);invalid['O2_disponible_L']='40'
    assert client.post('/api/v1/plan',json=invalid).status_code==422
    assert client.post('/api/v1/evento',json={'version':'1.0','t':0,'hora_solar':10,'seq':1,'tipo':'SPE','datos':{'nivel':'desconocido','llegada_s':0}}).status_code==422
    assert client.get('/api/v1/estado').json()['ultimo_seq']==0


def test_abort_prevents_new_plan(client,fixtures):
    client.post('/api/v1/perfil',json=fixtures['perfil'])
    event={'version':'1.0','t':0,'hora_solar':10,'seq':1,'tipo':'SPE','datos':{'nivel':'critico','llegada_s':0}}
    out=client.post('/api/v1/evento',json=event)
    assert out.status_code==200 and out.json()['mensajes_motor'][0]['tipo']=='abortar'
    assert client.post('/api/v1/plan',json=fixtures['pedido']).status_code==409
    assert client.post('/api/v1/evento',json=tele(2,t=10)).json()['mensajes_motor'][0]['tipo']=='estado_aborto'
