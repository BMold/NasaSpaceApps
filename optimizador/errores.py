class ErrorOptimizador(Exception):
    """Base de las excepciones del optimizador."""


class PedidoInvalido(ErrorOptimizador):
    pass


class VersionNoSoportada(ErrorOptimizador):
    pass


class SinPerfil(ErrorOptimizador):
    pass
