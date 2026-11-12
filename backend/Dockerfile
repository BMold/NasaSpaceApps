FROM python:3.11-slim-bookworm
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
WORKDIR /app
COPY backend/requirements.txt /tmp/requirements.txt
RUN pip install --no-cache-dir -r /tmp/requirements.txt
COPY optimizador/ /app/optimizador/
COPY terreno/ /app/terreno/
COPY contratos/ /app/contratos/
COPY backend/ /app/backend/
RUN mkdir -p /app/logs && useradd -r -m -u 10001 ares && chown ares:ares /app/logs
USER ares
EXPOSE 8000
CMD ["uvicorn", "backend.app.main:app", "--host", "0.0.0.0", "--port", "8000", "--workers", "1"]
