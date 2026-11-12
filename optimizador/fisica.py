"""Costo metabolico: Pandolf adaptado a 0,38 g (CLAUDE.md §8.2).

APROXIMACION DE DISENO, NO VALIDADA. Las funciones aceptan escalares o arrays de numpy.
"""
import numpy as np

from . import constantes as K


def astronauta_de(perfil=None) -> dict:
    """Devuelve el dict del astronauta a partir de un perfil (10.1), de su bloque
    `astronauta` o de None (constantes por defecto)."""
    base = {
        "masa_kg": K.MASA_KG,
        "masa_traje_kg": K.MASA_TRAJE_KG,
        "v0_m_s": K.V0_M_S,
        "kappa_O2_L_W_min": K.KAPPA_O2_L_W_MIN,
        "O2_inicial_L": K.O2_INICIAL_L,
        "capacidad_muestras_kg": K.CAPACIDAD_MUESTRAS_KG,
    }
    if perfil:
        base.update(perfil.get("astronauta", perfil))
    return base


def velocidad(G, eta, perfil=None):
    """Velocidad [m/s] con pendiente firmada G [%] y factor de terreno eta en [1, 2]."""
    a = astronauta_de(perfil)
    v = a["v0_m_s"] * np.exp(-0.042 * np.abs(G)) * (1.0 - 0.28 * eta)
    return np.maximum(v, 1e-3)


def potencia(G, eta, perfil=None):
    """Tasa metabolica M [W]."""
    a = astronauta_de(perfil)
    W = a["masa_kg"]
    L_eff = (W + a["masa_traje_kg"]) * K.G_REL - W
    v = velocidad(G, eta, a)
    return (1.5 * W
            + 2.0 * (W + L_eff) * (L_eff / W) ** 2
            + eta * (W + L_eff) * (1.5 * v ** 2 + np.maximum(0.0, 0.35 * v * G)))


def pandolf(G, eta, perfil=None, distancia_m=2.5):
    """O2 [L] para recorrer `distancia_m` con pendiente firmada G [%] y terreno eta."""
    a = astronauta_de(perfil)
    v = velocidad(G, eta, a)
    return potencia(G, eta, a) * (distancia_m / (60.0 * v)) * a["kappa_O2_L_W_min"]


def o2_reposo_L_s(perfil=None) -> float:
    """Consumo [L/s] al perforar, descansar o esperar una ventana (~250 W)."""
    return K.M_PERFORACION_W * astronauta_de(perfil)["kappa_O2_L_W_min"] / 60.0
