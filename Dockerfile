FROM node:22-alpine AS build
WORKDIR /app
ENV PUPPETEER_SKIP_DOWNLOAD=1
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json vite.config.ts index.html ./
COPY src ./src
COPY tests ./tests
RUN npm run build

FROM nginx:alpine
COPY deploy/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 80
