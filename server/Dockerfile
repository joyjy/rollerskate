FROM node:24-bookworm-slim AS build

ARG TARGETARCH
WORKDIR /app

COPY package.json package-lock.json ./
COPY local/package.json ./local/package.json
COPY packages/protocol/package.json ./packages/protocol/package.json
COPY server/package.json ./server/package.json
RUN npm ci \
  && case "$TARGETARCH" in \
    amd64) typescript_arch=x64 ;; \
    arm64) typescript_arch=arm64 ;; \
    *) echo "unsupported Docker architecture: $TARGETARCH" >&2; exit 1 ;; \
  esac \
  && npm install --no-save --package-lock=false "@typescript/typescript-linux-${typescript_arch}@7.0.2"

COPY packages/protocol ./packages/protocol
COPY server ./server
RUN npm run build -w @rollerskate/server \
  && npm prune --omit=dev

FROM node:24-bookworm-slim AS runtime

ENV NODE_ENV=production
WORKDIR /app

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/packages/protocol/package.json ./packages/protocol/package.json
COPY --from=build /app/packages/protocol/dist ./packages/protocol/dist
COPY --from=build /app/server/package.json ./server/package.json
COPY --from=build /app/server/dist ./server/dist
COPY --from=build /app/server/migrations ./server/migrations

USER node
EXPOSE 4100

CMD ["npm", "--prefix", "server", "start"]
