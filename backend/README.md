# Backend (Albert)

Lee primero: `contratos/INTEGRACION.md §5.3 y §7`.

- Todo lo tuyo en el contrato está marcado como **[Propuesta]**: ajústalo y avisa antes del 18-nov.
- Recibes eventos de la telemetría, se los pasas al `Motor` de uno en uno y en orden de `seq`, y difundes todo a las vistas.
- Uso del optimizador (CLAUDE.md §12):

```python
from optimizador import Motor
motor = Motor("terreno/")
motor.cargar_perfil(perfil)
salidas = motor.procesar_evento(evento)   # lista de mensajes; llamadas lentas en un hilo aparte
```

- Registras cada mensaje en `logs/sesion-<fecha>.jsonl` y sirves `terreno/` tal cual por HTTP.
- Para reproducir y saltar: INTEGRACION §6.5. Ya hay un registro completo en `logs/` para probar sin telemetría.
