"""Ensure the published shared JSON schemas match the Python message contracts."""
import json
from pathlib import Path
from jsonschema import Draft202012Validator
from backend.app.settings import ROOT
from backend.app.output_schemas import check_output
from optimizador import Motor


def test_input_json_schemas(fixtures):
    schemas = ROOT / 'contratos' / 'schemas'
    for name, payload in [('perfil', fixtures['perfil']), ('pedido', fixtures['pedido'])]:
        schema = json.loads((schemas / f'{name}.schema.json').read_text(encoding='utf-8'))
        Draft202012Validator.check_schema(schema)
        Draft202012Validator(schema).validate(payload)


def test_optimizer_actual_output_against_json_schema(fixtures):
    motor=Motor(ROOT / 'terreno')
    motor.cargar_perfil(fixtures['perfil'])
    plan=motor.planificar(fixtures['pedido'])
    check_output(motor.como_mensaje(plan))
    schema=json.loads((ROOT/'contratos/schemas/respuesta_plan.schema.json').read_text())
    Draft202012Validator(schema).validate(plan)
