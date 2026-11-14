# Simulación 3D y VR (Luis)

Lee primero: `contratos/INTEGRACION.md §3 y §5.4`.

- Escena 3D (vistas lejana y astronauta; ya no hay rover) y recorrido en casco. **No calculas nada.**
- Malla: `terreno/elevacion.bin`, 192 × 192 alturas float32 en metros, celdas de 2,5 m, fila 0 = sur, sin exageración vertical.
- Textura: `terreno/ortofoto.jpg` (1920 × 1920, 0,25 m/px, fila 0 = **norte**). Cubre exactamente la misma ventana de 480 m.
- Ejes sugeridos: `(x_escena, y_escena, z_escena) = (x, elevación, −y)`. Decídelo con Frank y avisa.
- La ruta llega solo con `x`, `y`: pégala a tu malla con raycast.
- Reproduce `logs/sesion-2026-11-13-mision.jsonl` (datos simulados); saltar a un instante = reaplicar los mensajes con `t` menor o igual (INTEGRACION §5.5).
