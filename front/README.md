# Frontend (Frank)

Lee primero: `contratos/INTEGRACION.md §3 y §5.4`.

- Mapa cenital por capas y HUD. **No calculas nada:** cada número en pantalla sale de un mensaje (tabla de §5.4).
- Datos: `terreno/` (ortofoto como base; `crism_*.bin`, `pendiente_deg.bin` y `peligro.bin` como capas; `sitios.json`; `manifest.contexto` para la inercia térmica).
- Ojo con la orientación: en los `.bin` la fila 0 es el **sur**; en `ortofoto.jpg` la fila 0 es el **norte**.
- **Referencia que ya funciona:** `demo/visor_mision.html` (código en `demo/visor_plantilla.html`): lee las capas, reproduce el registro y salta entre marcadores.
- Los datos del astronauta están en `logs/sesion-2026-11-13-mision.jsonl` y su `.marcadores.json`. Son simulados: indícalo en pantalla.
- No hay rover. Colores: CLAUDE.md §14. Verde, ámbar y rojo solo para seguridad.
