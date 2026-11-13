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

`server.js` mantiene un estado unificado `{ position, rotation, heading, drone }` y lo emite a todos a 60 Hz con mensajes volátiles (un cuadro atrasado se descarta, no se encola). La ruta y el estado del cañón viajan como eventos `world` y quedan guardados para quien se conecte después.

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
