"""Boundary validation of the frozen CLAUDE.md v1.0 data contracts.

No field is re-labelled/recalculated before passing the original dict to Motor.
"""
from __future__ import annotations

from typing import Annotated, Literal, Union
from pydantic import BaseModel, BeforeValidator, ConfigDict, Field, ValidationError, field_validator, model_validator

def json_number(v):
    if type(v) not in (float, int):
        raise ValueError('se requiere numero JSON, no texto ni booleano')
    return v

Positive = Annotated[float, BeforeValidator(json_number), Field(gt=0, allow_inf_nan=False)]
Nonnegative = Annotated[float, BeforeValidator(json_number), Field(ge=0, allow_inf_nan=False)]
Number = Annotated[float, BeforeValidator(json_number), Field(allow_inf_nan=False)]
Hour = Annotated[float, BeforeValidator(json_number), Field(ge=0, le=24, allow_inf_nan=False)]
Seq = Annotated[int, Field(strict=True, ge=1)]


class StrictContract(BaseModel):
    model_config = ConfigDict(extra='forbid', validate_assignment=True)


class XY(StrictContract):
    x: Number
    y: Number


class Astronauta(StrictContract):
    masa_kg: Positive
    masa_traje_kg: Nonnegative
    v0_m_s: Positive
    kappa_O2_L_W_min: Positive
    O2_inicial_L: Positive
    capacidad_muestras_kg: Nonnegative


class Rover(StrictContract):
    v_m_s: Positive
    R_comm_m: Positive


class Perfil(StrictContract):
    version: Literal['1.0']
    tipo: Literal['perfil']
    escenario_id: Annotated[str, Field(min_length=1, max_length=80)]
    semilla: Annotated[int, Field(strict=True)]
    t0_hora_solar: Hour
    factor_tiempo: Positive
    duracion_eva_s: Positive
    astronauta: Astronauta
    rover: Rover


class Sitio(XY):
    id: Annotated[int, Field(strict=True, ge=1)]
    valor: Annotated[float, BeforeValidator(json_number), Field(ge=1, le=10, allow_inf_nan=False)]
    mineral: Literal['filosilicatos', 'sulfatos', 'hematita', 'silice']
    masa_kg: Nonnegative
    perforacion_min: Nonnegative
    ventana: tuple[Hour, Hour]

    @field_validator('ventana')
    @classmethod
    def ordered_window(cls, value):
        if value[0] > value[1]:
            raise ValueError('ventana inicial mayor que final')
        return value


class Pedido(StrictContract):
    version: Literal['1.0']
    inicio: XY
    hora_solar: Hour
    O2_disponible_L: Nonnegative
    capacidad_kg: Nonnegative
    sitios: Annotated[list[Sitio], Field(max_length=12)]

    @model_validator(mode='after')
    def unique_ids(self):
        ids = [s.id for s in self.sitios]
        if len(ids) != len(set(ids)):
            raise ValueError('IDs de sitio duplicados')
        return self


class CabeceraEvento(StrictContract):
    version: Literal['1.0']
    t: Nonnegative
    hora_solar: Hour
    seq: Seq
    tipo: str
    datos: dict


class AstronautaDatos(XY):
    sigma_m: Nonnegative
    O2_restante_L: Nonnegative
    VO2_L_min: Nonnegative
    FC_lpm: Annotated[float, BeforeValidator(json_number), Field(ge=0, le=250, allow_inf_nan=False)]
    velocidad_m_s: Nonnegative
    carga_kg: Nonnegative


class RoverDatos(XY):
    bateria_pct: Annotated[float, BeforeValidator(json_number), Field(ge=0, le=100, allow_inf_nan=False)]


class PeligroDatos(XY):
    id: Annotated[str, Field(min_length=1, max_length=80)]
    forma: Literal['circulo']
    radio_m: Nonnegative
    efecto: Literal['bloqueo', 'multiplicador']
    factor: Annotated[float, BeforeValidator(json_number), Field(ge=1, le=5, allow_inf_nan=False)]


class VentanaSitio(StrictContract):
    id: Annotated[int, Field(strict=True, ge=1)]
    ventana: tuple[Hour, Hour]

    @field_validator('ventana')
    @classmethod
    def ordered_window(cls, value):
        if value[0] > value[1]:
            raise ValueError('ventana inicial mayor que final')
        return value


class VentanasDatos(StrictContract):
    sitios: list[VentanaSitio]


class SPEDatos(StrictContract):
    nivel: Literal['alerta', 'critico']
    llegada_s: Nonnegative


DATA_TYPES: dict[str, type[StrictContract]] = {
    'telemetria_astronauta': AstronautaDatos,
    'telemetria_rover': RoverDatos,
    'peligro': PeligroDatos,
    'ventanas': VentanasDatos,
    'SPE': SPEDatos,
}


def validate_event(message: dict) -> bool:
    """Validate the message and known data. Unknown types are deliberately ignored.

    Returns True if supported, False if well-formed but unknown (CLAUDE.md §9).
    """
    header = CabeceraEvento.model_validate(message)
    data_type = DATA_TYPES.get(header.tipo)
    if data_type is None:
        return False
    data_type.model_validate(message['datos'])
    return True


def validate_profile(message: dict) -> None:
    Perfil.model_validate(message)


def validate_plan(message: dict) -> None:
    Pedido.model_validate(message)
