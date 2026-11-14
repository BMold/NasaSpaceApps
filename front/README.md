# ARES-TWIN · Visor VR (NASA Space Apps)

Copia de `nassa-rover` convertida en una experiencia centrada en el traje del astronauta: el **celular** dentro de un Cardboard es el casco (rotación de la cabeza) y la **laptop** es el espectador y el control (posición con el teclado). Se sincronizan en la red local con Socket.io.

## Realismo visual

La escena está iluminada con valores físicos y datos reales de la NASA, para que se vea como una fotografía de Marte y no como una animación:

- **Cielo y luz:** un modelo de dispersión del polvo marciano (`src/render/marsSky.ts`) da el cielo color caramelo, la aureola azulada alrededor del Sol y el atardecer azul. Del mismo modelo salen la luz del Sol, la luz ambiente (mapa de entorno), la bruma de la distancia y la exposición de la cámara, así que todo es coherente entre sí. La hora solar y el polvo en el aire se cambian desde el panel de la laptop.
- **Cráter Gale real:** más allá del sitio de 240 m se ve el relieve verdadero hasta 108 km: laderas del Monte Sharp, piso del cráter y su borde (topografía MOLA de 16 bits y DEM HiRISE; imágenes HiRISE y CTX), con la curvatura de Marte y la bruma del polvo.
- **Suelo:** regolito con piedritas, arena con ondas de viento y roca fracturada con vetas, con relieve en la iluminación a dos escalas, sombras de las piedritas, sombras del relieve horneadas y oclusión del cielo en cráteres y cañón.
- **Rocas:** bloques con caras de fractura, lajas y cantos rodados, con polvo depositado arriba y tierra acumulada al pie; miles de piedras sueltas alrededor del astronauta.
- **Astronauta:** traje EVA blanco de estilo SpaceX (casco con visor espejado, paneles oscuros, botas, mochila de soporte vital). Camina con pasos reales: cada bota se apoya en el terreno y no patina; a más de ~1,4 m/s pasa a un trote «flotante» por la gravedad de Marte (0,38 g). Las botas se apoyan sobre el suelo tal como está dibujado (talón y punta nunca lo atraviesan), las rodillas nunca se traban rectas y la cadera no baja de un leve agache. Las rocas son sólidas: el astronauta las rodea. Deja huellas y levanta polvo. En primera persona, al mirar abajo ves tu propio cuerpo y tu sombra.
- **Cabeza y cuerpo:** la cabeza gira sola hasta unos 55°; si mirás más allá, el astronauta gira el cuerpo hasta quedar de frente. Al caminar, el cuerpo mira hacia donde avanza.
- **Dron:** helicóptero coaxial tipo Ingenuity, a escala real, plegado sobre la mochila. Al desplegarlo abre patas y palas, toma revoluciones, despega, escanea y vuelve a plegarse.

### Calidad y rendimiento

La calidad se elige sola: `low` en el celular (se dibuja dos veces, una por ojo), `medium` en laptops con gráfica integrada y `high` con gráfica dedicada. Se puede forzar con `?q=low|medium|high`. Además, un regulador baja la resolución de render si los cuadros por segundo caen y la vuelve a subir cuando hay margen (el panel de la laptop muestra fps y resolución).

### Regenerar los datos horneados

Los datos reales y las texturas ya están en `public/gale/` y `public/textures/`. Para rehacerlos (Python con numpy, Pillow y scipy):

```bash
python scripts/bake-gale.py        # descarga MOLA, HiRISE y CTX y recorta el sitio
python scripts/bake-textures.py    # texturas del suelo y de las rocas
```

## Arranque

```bash
npm install
npm run dev:vr     # un solo proceso: Vite HTTPS en la red local + sincronización Socket.io
```

- Laptop: `https://localhost:5173/?role=spectator`
- Celular (misma Wi-Fi): `https://IP-DE-LA-LAPTOP:5173/?role=vr`, aceptá el certificado y tocá **Entrar al casco**. La terminal muestra las direcciones exactas al arrancar.

**Tiene que ser `https`:** los celulares sólo entregan el giroscopio y la brújula a páginas seguras. Si abrís con `http`, la pantalla del casco lo avisa.

La sincronización corre dentro del mismo servidor de Vite (`sync-core.js`), así que no hace falta un segundo proceso. `server.js` queda para servir la build de producción en el puerto 3000 (`npm run build && npm run server`), pero sin HTTPS el celular no entrega el sensor.

## Terreno real y backend

Por defecto la escena usa el paquete real `../terreno/` (CLAUDE.md §6), el mismo que lee el optimizador: ventana de 480 × 480 m en Mount Sharp, DEM de USGS, ortofoto HiRISE y los sitios minerales de CRISM. **No se copia nada a `public/`:** Vite sirve `../terreno` en `/terreno/` (y `server.js` también).

- **Marco:** paquete ENU con origen en la esquina SO (x = este, y = norte). En la escena: `x_escena = x − 240`, `z_escena = 240 − y` (−z = norte). En los `.bin` la fila 0 es el sur y en `ortofoto.jpg` es el norte; el cargador ([src/lib/realTerrain.ts](src/lib/realTerrain.ts)) ya lo resuelve.
- **Sitios y capas:** primero se piden al backend de Albert (`/api/v1/terreno`, `/api/v1/terreno/sitios`, `/api/v1/terreno/capas/elevacion`, reenviados a `ARES_BACKEND`, por defecto `http://127.0.0.1:8000`). Si no responde, se leen de `/terreno/`. El panel de la laptop y cada etiqueta dicen de dónde salieron. Si el backend pide token de lectura: `VITE_ARES_TOKEN=…`.
- **Malla de costos:** 192 × 192 celdas de 2,5 m, la misma grilla del optimizador. A* recalcula desde los pies del astronauta cuando se desvía más de 3,5 m.
- **Marcadores holográficos:** un prisma por sitio con la forma y el color acordados (filosilicatos: prisma redondo · sulfatos: rombo · hematita: prisma triangular · sílice: cubo), un haz hasta el suelo, un anillo en el punto de muestreo y una etiqueta dibujada como textura, que se ve en los dos ojos del Cardboard.
- `?terreno=procedural` vuelve al sitio análogo anterior (240 m, cañón y escaneo con dron).

```bash
# con el backend corriendo en otra máquina o puerto
ARES_BACKEND=http://192.168.1.50:8000 npm run dev:vr
```

## Fuentes de la escena: libre, misión registrada y backend en vivo

El panel de la laptop elige la **Fuente** (o la URL `?modo=`):

| Fuente | URL | Qué mueve al astronauta y de dónde salen los números |
|---|---|---|
| Libre | `?role=spectator` | Teclado o mirar abajo. Ruta A* local, biodatos simulados (§10.4). Para jugar con la VR. |
| Misión registrada | `?role=spectator&modo=mision` | Reproduce `../logs/sesion-2026-11-12-mision.jsonl` (`&registro=<nombre>` para otro). Play/pausa, ×10–×120, línea de tiempo y saltos por marcador (empiezan 30 s antes). |
| Backend en vivo | `?role=spectator&modo=vivo` | WebSocket `/ws?rol=vr` del backend (Vite lo reenvía a `ARES_BACKEND`). |

En los dos modos de misión la vista **no calcula nada** (CLAUDE.md §14). Cada elemento sale de un mensaje:
- **Posición:** la telemetría, interpolada.
- **Ruta:** `plan.polilinea`, y después de `abortar`, `ruta_escape`. La ruta vieja se desvanece en 2 s.
- **O₂, margen y O₂ mínimo:** `estado_aborto`.
- **Pulso y VO₂:** la telemetría.
- **Hora solar:** el sol Mars24 de la escena.
- **Sitios en el plan o recogidos:** `plan.paradas` y `hito` `muestra`.
- **Peligros:** cilindros rojos para `bloqueo` y ámbar para `multiplicador`.
- **Avisos:** 4 s en el visor cuando hay replanificación o aborto.
- **Vista lejana:** 3 s al llegar un `abortar`.

El celular recibe todo esto desde la laptop.

Para probar el modo en vivo sin la telemetría real:

```bash
python -m uvicorn backend.app.main:app --port 8000      # desde la raíz del repo
python herramientas/reproducir_en_backend.py            # hace de telemetría: manda el registro al backend a ×30
```

## Capas del paquete sobre el relieve

**Capa** en la laptop (el celular la sigue):
- **Minerales:** los índices CRISM de cada mineral, o todos juntos (gana el más fuerte), con su color acordado. La intensidad es cuánto supera el índice el p90 de la escena. Son indicios, no detecciones.
- **Pendiente:** ámbar hasta 30°, rojo donde no se puede caminar.
- **Inercia térmica TES:** se muestra como número (241 en toda la ventana, que cae en un único píxel de ~3 km). No se pinta, para no sugerir un detalle que no existe.

## Vista JARVIS (`src/jarvis/`)

Visión aumentada en primera persona, compartida por el casco y la laptop.

- **Detección en tiempo real (simulada):** 10 veces por segundo, el sensor del traje reporta los objetos del campo visual que están al alcance y a la vista (el relieve puede taparlos): rocas y bloques de 0,5 m o más, sitios CRISM, el hábitat, los peligros de la misión y las anomalías de campo. El tamaño medido tiene un error que crece con la distancia. **No hay una red neuronal sobre la cámara:** la escena conoce sus objetos y el sensor los informa.
- **Comparación con una BD simulada:** un relevamiento orbital (tipo HiRISE) con el 82 % de las rocas grandes, medidas con ruido. Cada detección se compara por posición, tamaño y forma con la entrada más parecida:
  - **catalogado** (≥ 75 %, cian);
  - **parecido**, hay que revisarlo (45–75 %, blanco);
  - **NUEVO** (magenta).
- **Lo nuevo que vale la pena demostrar:** las anomalías de campo (posible meteorito metálico, veta clara, concreciones) no están en ninguna BD y se marcan con **★ vale la pena documentar** y el motivo. Quedan en el registro de **Hallazgos** de la laptop, con posición y momento.
- **En el visor:** marcos y etiquetas grandes a la profundidad real de cada objeto (se ven bien en el Cardboard), una cinta de rumbo con el hábitat y el próximo objetivo, y paneles de O₂ y pulso más grandes.
- **JARVIS o vista normal:** con la tecla **J** o el botón de la laptop, o con **un toque** en el celular (el botón del Cardboard). Los dos dispositivos se sincronizan. La vista normal deja solo las alertas de seguridad y los efectos de lente. El doble toque sigue recentrando.
- **Menú de la laptop:** se pliega a su encabezado con el botón o la tecla **M**, y recuerda el estado.

## HUD del traje (`src/hud/`)

Sin paneles planos: todo lo que ve el astronauta es un holograma 3D dentro de la escena, así que el Cardboard lo dibuja en cada ojo con su profundidad.

- **Biodatos** ([bio.ts](src/hud/bio.ts)): la laptop los simula con el modelo de CLAUDE.md §10.4. Pandolf al caminar (a paso de 1,4 m/s, aunque la demo te mueva más rápido), 250 W quieto; `VO₂ = M·κ·(1 + ε)`; `FC = 70 + 55·VO₂`. Parte de 40 L de O₂ y los envía al celular en el estado sincronizado. Son órdenes de magnitud para la demo.
- **Visor** ([VisorHud.tsx](src/hud/VisorHud.tsx)): a la izquierda, O₂ (anillo con la marca fija de `O2_minimo_L`, litros, minutos, margen, O₂ para volver); a la derecha, pulso con ECG en vivo, VO₂ y potencia; arriba, un aviso solo en crisis. En tercera persona, los paneles flotan junto al astronauta.
- **Barrera de supervivencia** ([ReturnBarrier.tsx](src/hud/ReturnBarrier.tsx)): el campo de retorno R(p) (Dijkstra inverso desde el hábitat) se dibuja como una cortina de luz roja donde `O₂ = 1,15·R(p)`, que es la línea de aborto de §9. Una línea ámbar marca el 30 %. Se cierra hacia el hábitat a medida que baja el O₂.
- **Efectos de lente:** escarcha desde el borde (zona fría, noche o «Frío extremo»), viñeta roja que late con el pulso (margen ≤ 30 % y ≤ 15 %, taquicardia) y túnel con velo al quedarse sin O₂. En la laptop se suman aberración cromática, desaturación y desenfoque.
- **Controles de la laptop (Traje):** tiempo ×1 / ×10 / ×30, fatiga VO₂ ×1,3, fuga de O₂, frío extremo y O₂ lleno.

## Orientación tipo brújula

El celular usa su orientación absoluta cuando la tiene (`deviceorientationabsolute` en Android, `webkitCompassHeading` en iPhone): mirar al norte real es mirar al norte en Marte. Si el teléfono no tiene brújula, usa el giroscopio relativo. El texto arriba de cada ojo muestra el rumbo y la fuente (`brújula` o `giroscopio`). Doble toque toma la dirección actual como «adelante».

Si esos eventos no llegan en 1,5 s, el casco prueba la **Generic Sensor API** de Chrome (`AbsoluteOrientationSensor`, o `RelativeOrientationSensor` sin magnetómetro). Si eso también falla, muestra el motivo exacto (permiso denegado, sin sensor, etc.).

### ¿El celular dice «no envió datos del giroscopio»?

Abrí `https://IP-DE-LA-LAPTOP:5173/?role=sensor-test` en el celular y tocá **Iniciar prueba**. La página muestra si cuenta como segura, el estado de los permisos (acelerómetro, giroscopio, magnetómetro), qué eventos llegan en vivo y qué error da la Generic Sensor API.

- **Permiso `denied`:** tocá el candado junto a la dirección › Permisos › Sensores de movimiento › Permitir, y recargá. También en Chrome › Configuración › Configuración de sitios › Sensores de movimiento.
- **Eventos «recibidos» pero 0 «con valores reales»:** Chrome manda el evento vacío porque el celular no le da giroscopio ni brújula. El casco usa el acelerómetro para mirar arriba/abajo, y para los costados:
  - **con magnetómetro:** en el celular activá `chrome://flags/#enable-generic-sensor-extra-classes` y reiniciá Chrome; girar el cuerpo gira la vista, como una brújula.
  - **sin magnetómetro:** inclinar la cabeza hacia un costado gira hacia ese lado (más inclinación, más rápido); con la cabeza derecha deja de girar.
- **Todo permitido pero sin eventos:** el certificado autofirmado puede estar bloqueando los sensores. Arrancá con `VITE_HTTP=1 npm run dev:vr`. En el celular, en `chrome://flags/#unsafely-treat-insecure-origin-as-secure`, agregá `http://IP-DE-LA-LAPTOP:5173`, reiniciá Chrome y abrí esa dirección.

## Roles y datos

| Rol | Dispositivo | Envía | Recibe |
| --- | --- | --- | --- |
| `vr-client` | Celular | rotación de la cabeza (cuaternión, ~60 Hz) | posición, giro del cuerpo, dron, ruta, hora solar y polvo |
| `spectator-host` | Laptop | posición `(x, y, z)`, giro del cuerpo, dron, hora solar y polvo (60 Hz); ruta y escaneos (`world`) | rotación de la cabeza |

`sync-core.js` reenvía al instante, como mensajes volátiles (uno atrasado se descarta, no se encola):

- `rotation`: del celular a la laptop, el cuaternión de la cabeza.
- `pose`: de la laptop al celular, `x`, `z`, el giro y la **velocidad** del cuerpo. El celular la extrapola por la edad del mensaje más medio ping (hasta 150 ms), así muestra dónde está la laptop *ahora* y no hace falta esperar el tick del servidor. En la red local de prueba, el relevo tarda ~1 ms; esperar el tick de 60 Hz costaba ~27 ms.

Además mantiene un estado unificado `{ position, rotation, heading, drone }` que emite a todos a 60 Hz (para quien se conecta tarde, el dron y el cielo). La ruta viaja como evento `world` y queda guardada para quien se conecte después; al replanificar, la cinta vieja se desvanece en 2 s.

## Controles (laptop)

- **WASD / flechas:** caminar hacia donde mira el casco. **Shift:** más rápido.
- **Mirar abajo para avanzar (G):** con el casco puesto, bajar la vista más de 25° camina hacia adelante, sin manos. El panel de la laptop ajusta la velocidad (0,5 a 10 m/s; teclas `[` `]` o `−` `+`) y el ángulo. Las pendientes y la arena la frenan, como mucho a la mitad.
- **F:** el dron despega de la mochila, escanea el cañón, actualiza el mapa de costos y vuelve a acoplarse.
- **V:** primera / tercera persona. **R:** recalcular. **N:** siguiente objetivo. **L:** mostrar u ocultar etiquetas.
- **Hora solar** y **Polvo en el aire:** deslizadores del panel; cambian el Sol, las sombras, el cielo y la bruma en la laptop y en el celular.
- Sin casco conectado: arrastrá el mouse o usá Q/E para girar.

En el celular, **doble toque** recentra la vista hacia el frente del astronauta.

## Archivos clave

| Archivo | Qué hace |
| --- | --- |
| `server.js` | Servidor Express + Socket.io, roles y estado a 60 Hz |
| `src/vr/VRCanvas.tsx` | Casco: pantalla dividida (StereoEffect) + giroscopio (DeviceOrientationControls) |
| `src/vr/SpectatorView.tsx` | Laptop: rotación remota, teclado, envío de posición, panel |
| `src/vr/useDynamicRoute.ts` | Reactividad de la ruta: si te desviás más de 3,5 m, A* se recalcula desde tu posición |
| `src/vr/vrEngine.ts` | Movimiento manual con colisiones, objetivos del tour, dron en la mochila |
| `src/vr/SuitModel.tsx`, `src/vr/suit/` | Traje: geometría (`build.ts`), materiales, animación con pasos reales (`rig.ts`), huellas y polvo (`SuitFx.tsx`) |
| `src/net/socket.ts` | Cliente Socket.io compartido |
| `src/render/marsSky.ts`, `src/components/canvas/Environment.tsx` | Modelo del cielo, Sol, luz ambiente, bruma y exposición |
| `src/render/groundMaterial.ts`, `src/components/canvas/Terrain.tsx` | Material del suelo y sitio de 240 m |
| `src/render/galeData.ts`, `src/components/canvas/FarTerrain.tsx` | Relieve real del cráter Gale hasta el borde |
| `src/components/canvas/Rocks.tsx` | Rocas y piedras sueltas |
| `src/components/canvas/ScoutDrone.tsx` | Dron plegable sobre la mochila |
| `src/render/quality.ts`, `src/render/Governor.tsx` | Niveles de calidad y regulador de resolución |

**Tu modelo del traje:** si copiás un glTF a `public/models/traje-ligero.glb` (metros, pies en y = 0, mirando hacia +Z), reemplaza al traje incorporado en la vista en tercera persona. Sigue al cuerpo, pero no se anima (no tiene el esqueleto del traje incorporado). Ver `public/models/LEEME.txt`.

`explicacion.html` y la documentación PDF quedaron como en el proyecto original.
