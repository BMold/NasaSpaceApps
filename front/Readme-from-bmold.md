# Frontend (Frank)

Lee primero: `contratos/INTEGRACION.md §3 y §5.4`.

- Mapa cenital por capas y HUD. **No calculas nada:** cada número en pantalla sale de un mensaje (tabla de §5.4).
- Datos: `terreno/` (ortofoto como base; `crism_*.bin` y `pendiente_deg.bin` como capas; `sitios.json`).
- Ojo con la orientación: en los `.bin` la fila 0 es el **sur**; en `ortofoto.jpg` la fila 0 es el **norte**.
- **Referencia que ya funciona:** `demo/visor_mision.html` (código en `demo/visor_plantilla.html`): lee los `.bin`, reproduce el registro y salta entre marcadores.
- Para trabajar sin backend: `logs/sesion-2026-11-12-mision.jsonl` y su `.marcadores.json`.
- Colores: CLAUDE.md §14. Verde, ámbar y rojo solo para seguridad.
