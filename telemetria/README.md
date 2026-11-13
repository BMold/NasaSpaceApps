# Telemetría (Dana, Erick)

Lee primero: `contratos/INTEGRACION.md §5.1`.

- **Envías:** `perfil` (una vez), `telemetria_astronauta` y `telemetria_rover` cada 10 s simulados, `peligro`, `ventanas`, `SPE` e `hito`.
- **Recibes:** solo `plan_actualizado` y `abortar`. El astronauta sigue la polilínea del último que llegue.
- Eres la única parte que descuenta el O₂.
- **Punto de partida:** `optimizador/pruebas/simular_guion.py` ya hace todo esto sin ruido; cópialo y añade el ruido de CLAUDE.md §10.4.
- Consumo: `from optimizador import pandolf, potencia`. Terreno: `from optimizador.terreno import Terreno`.
- Guion de referencia: `contratos/ejemplos/guion_mision.json`.
- Comprueba tu salida: `python contratos/validar.py tu_registro.jsonl`.
