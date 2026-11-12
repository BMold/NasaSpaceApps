"""Constantes v1.0 (CLAUDE.md §7 y supuestos de desarrollo v1)."""

VERSION = "1.0"

G_REL = 0.38                    # gravedad de Marte / Tierra
MASA_KG = 80.0
MASA_TRAJE_KG = 150.0
V0_M_S = 1.2
KAPPA_O2_L_W_MIN = 0.00298
O2_INICIAL_L = 40.0
CAPACIDAD_MUESTRAS_KG = 5.0

RHO = 0.15                      # reserva
RHO_SPE = 0.25                  # reserva con SPE en alerta
ALFA = 0.5                      # diversidad (psi)
LAMBDA_RIESGO = 0.0             # v1: termino de riesgo apagado
N_MAX_SITIOS = 12
TOPE_SOLVER_S = 2.0
DURACION_EVA_S = 14400.0
SEG_POR_HORA_SOLAR = 3699.0

M_PERFORACION_W = 250.0         # tambien al descansar / esperar una ventana
SUAVIZADO_PASADAS = 2

MINERALES = ("filosilicatos", "sulfatos", "hematita", "silice")

# Reglas en vivo (§9)
MARGEN_ABORTO_PCT = 15.0
FACTOR_O2_MINIMO = 1.15
DESVIO_VO2 = 0.20
VENTANA_VO2_S = 60.0
ENFRIAMIENTO_RECAL_S = 300.0
RADIO_VISITA_M = 5.0
