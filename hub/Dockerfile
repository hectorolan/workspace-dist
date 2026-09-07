# Multi-stage build sized for the 1-GB production VM (deploy.sh builds this
# image ON the VM). Stage 1 runs the Vite build with a capped Node heap so a
# runaway build OOM-kills itself long before it starves the host; stage 2 is the
# runtime image with production deps only (express/session/marked/sanitize-html
# — react/vite never ship, they are compiled into dist/).

FROM node:22-alpine AS build
WORKDIR /app

COPY package.json package-lock.json ./
# Frontend toolchain lives in devDependencies; PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD
# keeps @playwright/test from fetching a browser it will never use here.
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
RUN npm ci --no-audit --no-fund

COPY vite.config.mjs ./
COPY client ./client
ENV NODE_OPTIONS=--max-old-space-size=384
RUN npm run build

FROM node:22-alpine

ENV NODE_ENV=production
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

COPY src ./src
COPY --from=build /app/dist ./dist

EXPOSE 8080
USER node

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD wget -q -O /dev/null http://127.0.0.1:8080/healthz || exit 1

CMD ["node", "src/server.js"]
