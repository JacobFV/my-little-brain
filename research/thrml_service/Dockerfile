# Extropic THRML sampler service (private Cloud Run). Build context: research/thrml_service.
FROM python:3.12-slim
ENV PYTHONUNBUFFERED=1 PYTHONDONTWRITEBYTECODE=1 PIP_NO_CACHE_DIR=1 JAX_PLATFORMS=cpu
WORKDIR /app
COPY requirements.txt .
RUN pip install -r requirements.txt && python -m compileall -q -j 0 /usr/local/lib/python3.12/site-packages || true
COPY app.py .
RUN useradd -r -u 10001 app
USER app
EXPOSE 8080
CMD ["sh", "-c", "exec uvicorn app:app --host 0.0.0.0 --port ${PORT:-8080} --timeout-keep-alive 75 --no-server-header"]
