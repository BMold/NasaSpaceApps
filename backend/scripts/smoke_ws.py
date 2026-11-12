"""Smoke demo for Albert's backend, NOT Dana's final biometric simulator.

Run from repo root after starting server:
    python -m backend.scripts.smoke_ws [--url ws://localhost:8000/ws?rol=dana]
This script replays profile + initial tele + discrete danger/window/SPE events.
"""
from __future__ import annotations
import argparse
import json
from pathlib import Path
from websockets.sync.client import connect

ROOT = Path(__file__).resolve().parents[2]


def main():
    parser = argparse.ArgumentParser(description='Replay breve por WebSocket')
    parser.add_argument('--url', default='ws://localhost:8000/ws?rol=dana')
    parser.add_argument('--token', default='', help='token de escritura si fue configurado')
    args = parser.parse_args()
    url = args.url + ('&' if '?' in args.url else '?') + 'token=' + args.token if args.token else args.url
    script = json.loads((ROOT / 'contratos/ejemplos/guion_demo.json').read_text(encoding='utf-8'))
    profile = script['perfil']
    habitat = json.loads((ROOT / 'terreno/manifest.json').read_text(encoding='utf-8'))['habitat']
    event0 = {
        'version':'1.0', 'seq':1,'t':0,'hora_solar':profile['t0_hora_solar'],
        'tipo':'telemetria_astronauta',
        'datos': {'x':habitat['x'],'y':habitat['y'],'sigma_m':0,
                  'O2_restante_L':profile['astronauta']['O2_inicial_L'],
                  'VO2_L_min':0.745,'FC_lpm':111,'velocidad_m_s':0,'carga_kg':0},
    }
    with connect(url, open_timeout=10, max_size=2**21) as ws:
        print('CONEXION',json.loads(ws.recv())['tipo'])
        ws.send(json.dumps(profile))
        print('PERFIL',json.loads(ws.recv()))
        for seq, event in enumerate([event0, *script['eventos']], start=1):
            message = dict(event)
            message['version']='1.0'
            message['seq']=seq
            message['hora_solar']=profile['t0_hora_solar']+message['t']/3699
            ws.send(json.dumps(message, ensure_ascii=False))
            responses=[]
            while True:
                response=json.loads(ws.recv())
                if response['tipo'] in ('ack','error','ignorado'):
                    if response['tipo']=='error':
                        raise SystemExit(f'Error secuencia {seq}: {response}')
                    break
                responses.append(f"{response['tipo']} ({response.get('motivo','')})")
            print('SEQ',seq,'t=',message['t'],'entrada=',message['tipo'], 'salidas=',responses)
    print('Guion breve reproducido. El script de Dana será el dueño del movimiento y O2 real.')


if __name__ == '__main__':
    main()
