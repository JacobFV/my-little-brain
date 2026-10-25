FROM node:22-slim AS build
WORKDIR /srv/app
COPY package.json package-lock.json ./
COPY apps/web/package.json ./apps/web/package.json
COPY apps/server/package.json ./apps/server/package.json
COPY apps/desktop/package.json ./apps/desktop/package.json
COPY apps/worker/package.json ./apps/worker/package.json
COPY apps/mobile/package.json ./apps/mobile/package.json
COPY packages/core/package.json ./packages/core/package.json
COPY packages/brain/package.json ./packages/brain/package.json
RUN npm ci
COPY . .
ARG VITE_CORTEX_API
ARG VITE_GOOGLE_CLIENT_ID
ENV VITE_CORTEX_API=$VITE_CORTEX_API
ENV VITE_GOOGLE_CLIENT_ID=$VITE_GOOGLE_CLIENT_ID
RUN npm run build
FROM node:22-slim
WORKDIR /srv/app
ENV NODE_ENV=production
COPY --from=build /srv/app /srv/app
ENV HOST=0.0.0.0
ENV PORT=8080
EXPOSE 8080
CMD ["npm","start"]
