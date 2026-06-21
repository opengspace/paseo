# syntax=docker/dockerfile:1
#
# Multi-stage build for @getpaseo/relay-node.
# Build context = this package directory (packages/relay-node). relay-node is a
# self-contained leaf whose only runtime dependency is `ws`, so the runner image
# stays tiny.
#
#   docker build -t paseo-relay-node packages/relay-node
#   docker run --rm -p 8080:8080 paseo-relay-node
#
# relay-node speaks plain `ws`. Terminate TLS with a reverse proxy in front.

# ---- builder: compile TypeScript ----
FROM node:20-alpine AS builder
WORKDIR /app
COPY package.json tsconfig.json ./
COPY src ./src
RUN npm install --ignore-scripts
RUN npm run build

# ---- runner: prod deps + compiled output ----
FROM node:20-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=8080
COPY package.json ./
RUN npm install --omit=dev --ignore-scripts && npm cache clean --force
COPY --from=builder /app/dist ./dist
USER node
EXPOSE 8080
CMD ["node", "dist/bin/cli.js"]
