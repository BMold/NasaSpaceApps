"""Ensure the published shared JSON schemas match the Python message contracts.

The shared schemas (contratos/schemas/*.json) reference each other ($ref to comunes.json),
so they are checked with the project's own validator, contratos/validar.py.
"""
from backend.app.output_schemas import check_output
from backend.app.settings import ROOT
from contratos.validar import validar_con
from optimizador import Motor


def test_input_json_schemas(fixtures):
    for name, payload in [('perfil', fixtures['perfil']), ('pedido', fixtures['pedido'])]:
        assert validar_con(name, payload) == []


def test_optimizer_actual_output_against_json_schema(fixtures):
    motor = Motor(ROOT / 'terreno')
    motor.cargar_perfil(fixtures['perfil'])
    plan = motor.planificar(fixtures['pedido'])
    check_output(motor.como_mensaje(plan))
    assert validar_con('plan', plan) == []
