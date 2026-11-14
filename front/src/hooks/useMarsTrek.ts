// Loads a real Martian region from NASA Mars Trek and rebuilds the digital twin.
import { useEffect, useRef } from 'react';
import { REGIONS, loadMarsTrekRegion } from '../lib/marsTrek';
import { BASE_A, TARGET_B, buildHeightfield, regenRocks } from '../lib/terrain';
import { REAL, demSampler, enuToScene, fitPlane, loadRealPackage } from '../lib/realTerrain';
import { SITES, setRealSites } from '../lib/sites';
import { useSimStore } from '../store/useSimStore';
import { initSimulation, log, setSiteLocation } from '../store/simEngine';
import { regionName } from '../i18n';

const bumpTerrain = () => useSimStore.setState((s) => ({ terrainVersion: s.terrainVersion + 1 }));
const GALE = REGIONS[0];

export function useMarsTrek() {
  const regionId = useSimStore((s) => s.dataRegion);
  const startLtst = useSimStore((s) => s.startLtst);

  useEffect(() => {
    let cancelled = false;
    const region = REGIONS.find((r) => r.id === regionId) ?? REGIONS[0];

    const offline = (status: 'procedural' | 'error', message: string) => {
      setSiteLocation(GALE.lat, GALE.lon);
      buildHeightfield(null, null, 'procedural');
      bumpTerrain();
      initSimulation();
      useSimStore.setState({ trekStatus: status, trekMessage: message, trekPreview: null, siteInfo: null, sol: GALE.sol ?? 0 });
    };

    if (REAL) {
      useSimStore.setState({ trekStatus: 'loading', trekMessage: 'Cargando el paquete de terreno real (DEM USGS, HiRISE, sitios CRISM)…' });
      loadRealPackage()
        .then((pkg) => {
          if (cancelled) return;
          const g = pkg.manifest.georreferencia;
          if (g) setSiteLocation((g.esquina_sw.lat_deg + g.esquina_ne.lat_deg) / 2, (g.esquina_sw.lon_este_deg + g.esquina_ne.lon_este_deg) / 2);
          else setSiteLocation(GALE.lat, GALE.lon);
          // Habitat and sites from the package, in scene coordinates.
          const h = enuToScene(pkg.manifest.habitat.x, pkg.manifest.habitat.y);
          Object.assign(BASE_A, h);
          Object.assign(TARGET_B, h);
          setRealSites(pkg.sitios, pkg.fuenteSitios);
          // Heights relative to the plane's mean, so the regional tilt (tiltAt) lines up with the land beyond.
          const plane = fitPlane(pkg);
          const dem = demSampler(pkg);
          buildHeightfield(null, pkg.orto, 'Paquete terreno/ · DEM USGS 1 m', {
            hiRes: !!pkg.orto,
            tilt: { east: plane.east, north: plane.north },
            real: (x, z) => dem(x, z) - plane.mean,
          });
          regenRocks([BASE_A, ...SITES], 7);
          bumpTerrain();
          initSimulation();
          const slope = (Math.atan(Math.hypot(plane.east, plane.north)) * 180) / Math.PI;
          useSimStore.setState({
            trekStatus: 'online',
            siteInfo: null,
            trekPreview: null,
            trekMessage: `${pkg.manifest.sitio} · ${SITES.length} sitios CRISM desde ${pkg.fuenteSitios === 'backend' ? 'el backend' : 'terreno/sitios.json'} · pendiente regional ${slope.toFixed(1)}°`,
          });
          log('ok', `Terreno real cargado: ventana de 480 m, DEM ${pkg.fuenteCapas === 'backend' ? 'del backend' : 'del paquete'}, ${SITES.length} sitios.`);
        })
        .catch((err: unknown) => {
          if (cancelled) return;
          offline('error', `No se pudo leer el paquete terreno/ (${err instanceof Error ? err.message : 'error'}). Se usa el terreno procedural.`);
        });
      return () => {
        cancelled = true;
      };
    }

    if (region.mode === 'procedural') {
      offline('procedural', 'Terreno análogo procedural (sin conexión). Sol y estación calculados para Gale.');
      return;
    }

    useSimStore.setState({
      trekStatus: 'loading',
      trekMessage: region.mode === 'hires' ? 'Descargando posición de Curiosity, mosaico HiRISE y DEM de Gale…' : `Descargando DEM MOLA y mosaico Viking de ${regionName(region.id, region.name)}…`,
    });
    loadMarsTrekRegion(region)
      .then((data) => {
        if (cancelled) return;
        setSiteLocation(data.site.lat, data.site.lon);
        buildHeightfield(data.dem, data.albedo, `NASA Mars Trek · ${region.name}`, { hiRes: data.hiRes, tilt: data.tilt });
        bumpTerrain();
        initSimulation();
        const s = data.site;
        useSimStore.setState({
          trekStatus: 'online',
          siteInfo: s,
          sol: s.sol ?? 0,
          trekMessage: data.hiRes
            ? `Posición ${s.live ? 'en vivo' : 'publicada'} de Curiosity${s.sol ? ` (sol ${s.sol})` : ''}: ${s.lat.toFixed(4)}°, ${s.lon.toFixed(4)}°${
                s.elevation !== null ? ` · ${s.elevation.toFixed(0)} m` : ''
              } · pendiente regional ${s.slopeDeg.toFixed(1)}° subiendo hacia ${s.uphillAzimuth.toFixed(0)}°`
            : `${regionName(region.id, region.name)} (${region.lat.toFixed(2)}°, ${region.lon.toFixed(2)}°) · relieve análogo, rango del DEM ${data.demRange.toFixed(0)} DN`,
          trekPreview: data.albedoPreview,
        });
        log('ok', data.hiRes ? 'Gemelo digital sincronizado: superficie HiRISE a 0,64 m/px alrededor de Curiosity y pendiente regional de Mount Sharp del DEM HiRISE.' : `Gemelo digital sincronizado con NASA Mars Trek: ${regionName(region.id, region.name)}.`);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        offline('error', `Mars Trek no responde (${err instanceof Error ? err.message : 'error de red'}). Se usa el terreno procedural.`);
      });

    return () => {
      cancelled = true;
    };
  }, [regionId]);

  // A new EVA start time only re-runs the mission on the same terrain.
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    initSimulation();
  }, [startLtst]);
}
