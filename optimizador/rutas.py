"""Polilineas: simplificacion de puntos colineales y suavizado de Chaikin."""
import math


def simplificar(p):
    """Quita los puntos intermedios colineales (y los repetidos)."""
    sal = []
    for q in p:
        if sal and abs(q[0] - sal[-1][0]) < 1e-9 and abs(q[1] - sal[-1][1]) < 1e-9:
            continue
        while len(sal) >= 2:
            ax, ay = sal[-1][0] - sal[-2][0], sal[-1][1] - sal[-2][1]
            bx, by = q[0] - sal[-1][0], q[1] - sal[-1][1]
            if abs(ax * by - ay * bx) < 1e-9 and ax * bx + ay * by > 0:
                sal.pop()
            else:
                break
        sal.append(q)
    return sal


def chaikin(p, pasadas=2):
    """Chaikin conservando los extremos."""
    for _ in range(pasadas):
        if len(p) < 3:
            break
        q = [p[0]]
        for a, b in zip(p, p[1:]):
            q.append((0.75 * a[0] + 0.25 * b[0], 0.75 * a[1] + 0.25 * b[1]))
            q.append((0.25 * a[0] + 0.75 * b[0], 0.25 * a[1] + 0.75 * b[1]))
        q.append(p[-1])
        p = q
    return p


def suavizar(p, pasadas=2):
    return [[round(x, 2), round(y, 2)] for x, y in chaikin(simplificar(p), pasadas)]


def dist_punto_segmento(px, py, a, b) -> float:
    ax, ay, bx, by = a[0], a[1], b[0], b[1]
    dx, dy = bx - ax, by - ay
    l2 = dx * dx + dy * dy
    u = 0.0 if l2 == 0 else max(0.0, min(1.0, ((px - ax) * dx + (py - ay) * dy) / l2))
    return math.hypot(px - (ax + u * dx), py - (ay + u * dy))


def cruza_circulo(polilinea, x, y, radio) -> bool:
    if len(polilinea) == 1:
        return math.hypot(polilinea[0][0] - x, polilinea[0][1] - y) <= radio
    return any(dist_punto_segmento(x, y, a, b) <= radio for a, b in zip(polilinea, polilinea[1:]))


def desde_mas_cercano(polilinea, x, y):
    """Tramo de la polilinea desde el vertice mas cercano a (x, y)."""
    if not polilinea:
        return polilinea
    k = min(range(len(polilinea)), key=lambda i: (polilinea[i][0] - x) ** 2 + (polilinea[i][1] - y) ** 2)
    return polilinea[k:]
