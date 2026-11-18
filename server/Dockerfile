FROM node:22-bookworm-slim AS build

WORKDIR /app
COPY package.json package-lock.json .npmrc ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:22-bookworm-slim

WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist

ENV PORT=8787
ENV DB_PATH=/data/cache.sqlite3
EXPOSE 8787

CMD ["node", "dist/index.js"]
