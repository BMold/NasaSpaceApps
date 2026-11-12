# ARES-TWIN — Mount Sharp · Gale (NASA Space Apps)

Repositorio original con `optimizador/` y `terreno/` de Ignacio, más **backend de Albert** integrado en `backend/` (FastAPI HTTP + WebSocket, contratos JSON v1.0).

## Inicio rápido

```bash
cp .env.example .env
docker compose up --build -d
curl http://localhost:8000/health
```

Documentación interactiva: http://localhost:8000/docs · [Guía del backend](backend/README.md) · [Contrato HTTP/WS de Albert](backend/CONTRATO_BACKEND_V1.md) · [Autoridad funcional](CLAUDE.md).

**Nota:** el mapa actual de 96×96 es **sintético** y usa ENU (x este, y norte), 2,5 m/celda. No es Jezero ni datos HiRISE observados. No se han alterado los archivos originales del optimizador, los datos de terreno ni los dos ejemplos de entrada.
