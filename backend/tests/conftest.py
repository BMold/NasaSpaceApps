from __future__ import annotations
import json
from pathlib import Path
import pytest
from fastapi.testclient import TestClient
from backend.app.main import create_app
from backend.app.settings import Settings, ROOT


@pytest.fixture
def fixtures():
    folder = ROOT / 'contratos' / 'ejemplos'
    return {'perfil': json.loads((folder / 'guion_demo.json').read_text())['perfil'],
            'pedido': json.loads((folder / 'pedido.json').read_text())}


@pytest.fixture
def client(tmp_path):
    app = create_app(settings=Settings(terrain_dir=ROOT/'terreno',
                                     examples_dir=ROOT/'contratos'/'ejemplos',
                                     logs_dir=tmp_path/'logs',cors_origins=('http://localhost:5173',)))
    with TestClient(app) as c:
        yield c


def tele(seq, t=0, x=120, y=120, o2=40):
    return {'version':'1.0','t':t,'hora_solar':10+t/3699,'seq':seq,
            'tipo':'telemetria_astronauta',
            'datos':{'x':x,'y':y,'sigma_m':0,'O2_restante_L':o2,'VO2_L_min':0.745,
                     'FC_lpm':111,'velocidad_m_s':0,'carga_kg':0}}
