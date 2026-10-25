# cortex² — one image for the public API+web service and the private worker.
# Build context: repository root.  docker build -f research/Dockerfile .
FROM node:22-slim AS web
WORKDIR /src
COPY package.json package-lock.json ./
COPY apps/web/package.json apps/web/package.json
COPY apps/server/package.json apps/server/package.json
COPY apps/desktop/package.json apps/desktop/package.json
COPY apps/worker/package.json apps/worker/package.json
COPY apps/mobile/package.json apps/mobile/package.json
COPY packages/core/package.json packages/core/package.json
COPY packages/brain/package.json packages/brain/package.json
RUN npm ci --ignore-scripts --no-audit --no-fund --workspace=@little-brain/web --include-workspace-root
COPY tsconfig.base.json ./
COPY packages packages
COPY apps/web apps/web
ARG VITE_GOOGLE_CLIENT_ID=""
ENV VITE_CORTEX_ONLY=1 VITE_CORTEX_API="" VITE_GOOGLE_CLIENT_ID=$VITE_GOOGLE_CLIENT_ID
RUN npm run build --workspace=@little-brain/web

FROM python:3.12-slim
ENV PYTHONUNBUFFERED=1 PYTHONDONTWRITEBYTECODE=1 PIP_NO_CACHE_DIR=1 \
    MPLCONFIGDIR=/tmp/mpl WEB_DIST=/app/web CORTEX_DATASETS=/app/data
WORKDIR /app/backend
COPY research/backend/requirements.txt .
RUN pip install -r requirements.txt
COPY research/backend/cortex2 cortex2
COPY research/backend/api.py .
COPY research/data /app/data
COPY --from=web /src/apps/web/dist /app/web
ARG CORTEX_VERSION=dev
ENV CORTEX_VERSION=$CORTEX_VERSION
RUN useradd -r -u 10001 app && mkdir -p /tmp/mpl && chown app /tmp/mpl
USER app
EXPOSE 8080
CMD ["sh", "-c", "exec uvicorn api:app --host 0.0.0.0 --port ${PORT:-8080} --workers ${WEB_CONCURRENCY:-1} --timeout-keep-alive 75"]
