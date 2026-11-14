"""Formal v1.0 optimizer output shapes. Does not alter or manufacture responses."""
from __future__ import annotations
from typing import Annotated, Literal
from pydantic import Field
from .schemas import StrictContract, Number, Nonnegative

class Parada(StrictContract):
    id: int
    x: Number
    y: Number
    llegada_s: Nonnegative
    salida_s: Nonnegative
    O2_acum_L: Nonnegative

class PlanSalida(StrictContract):
    version: Literal['1.0']
    plan_id: str
    factible: bool
    orden: list[int | Literal['H']]
    polilinea: list[tuple[Number, Number]]
    paradas: list[Parada]
    O2_total_L: Nonnegative
    O2_reserva_L: Nonnegative
    ciencia_Z: Nonnegative
    ruta_escape: list[tuple[Number, Number]]
    tiempo_calculo_ms: Nonnegative
    optimo: bool

class PlanActualizado(StrictContract):
    version: Literal['1.0']
    tipo: Literal['plan_actualizado']
    t: Nonnegative
    motivo: Literal['inicial','pedido','peligro','recalibracion','ventana','spe_alerta']
    seq_evento: int | None
    plan: PlanSalida

class Destino(StrictContract):
    tipo: Literal['habitat', 'refugio']
    id: str
    x: Number
    y: Number

class Abortar(StrictContract):
    version: Literal['1.0']
    tipo: Literal['abortar']
    t: Nonnegative
    motivo: Literal['spe_critico','no_retorno']
    seq_evento: int | None
    ruta_escape: list[tuple[Number, Number]]
    O2_previsto_L: Number
    destino: Destino | None = None  # optional and additive (CLAUDE.md §11.3)

class EstadoAborto(StrictContract):
    version: Literal['1.0']
    tipo: Literal['estado_aborto']
    t: Nonnegative
    O2_restante_L: Nonnegative
    R_L: Nonnegative
    O2_minimo_L: Nonnegative
    margen_pct: Number

OUTPUT_TYPES = {'plan_actualizado': PlanActualizado,
                'abortar': Abortar, 'estado_aborto': EstadoAborto}


def check_output(message: dict) -> None:
    OUTPUT_TYPES[message['tipo']].model_validate(message)
