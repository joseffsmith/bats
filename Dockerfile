FROM node:22-alpine AS build
WORKDIR /app
ENV PUPPETEER_SKIP_DOWNLOAD=1
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.build.json vite.config.ts index.html ./
COPY public ./public
COPY src ./src
# Stamped into replay-log headers (see vite.config.ts define).
ARG BUILD_SHA=dev
ENV BUILD_SHA=$BUILD_SHA
RUN npm run build

FROM node:22-alpine
WORKDIR /app
ARG BUILD_SHA=dev
ENV BUILD_SHA=$BUILD_SHA
COPY server ./server
COPY --from=build /app/dist ./dist
EXPOSE 8000
CMD ["node", "server/index.mjs"]
