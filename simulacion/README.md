# Simulación de datos (Dana)

Lee primero: `contratos/INTEGRACION.md §5.1`.

- No hay telemetría real: tu programa **simula** al astronauta y los eventos, y deja escrito el conjunto de datos de la misión.
- Corre en el mismo proceso que el optimizador; no hay transmisión en vivo.
- **Produces:** `perfil` (una vez), `estado_astronauta` cada 10 s simulados, `peligro`, `ventanas`, `SPE`, `hito`, y el registro `.jsonl` con sus marcadores.
- **Consumes:** `plan_actualizado` y `abortar`, que te devuelve `Motor.procesar_evento`. El astronauta sigue la polilínea del último que llegue.
- Eres la única parte que descuenta el O₂. No hay rover.
- **Punto de partida:** `optimizador/pruebas/simular_guion.py` ya hace todo esto sin ruido, y `herramientas/generar_registro.py` escribe el registro. Guion: `contratos/ejemplos/guion_mision.json`.
- Consumo: `from optimizador import pandolf, potencia`. Terreno: `from optimizador.terreno import Terreno`.
- Comprueba tu salida: `python contratos/validar.py tu_registro.jsonl`.
