# syntax=docker/dockerfile:1.7.1@sha256:a57df69d0ea827fb7266491f2813635de6f17269be881f696fbfdf2d83dda33e
# Official multi-platform Node 22.15.0/bookworm index verified from registry-1.docker.io.
FROM node:22.15.0-bookworm@sha256:a1f1274dadd49738bcd4cf552af43354bb781a7e9e3bc984cfeedc55aba2ddd8 AS dependencies
WORKDIR /app/symmio
RUN chown node:node /app/symmio
USER node
COPY --chown=node:node package.json package-lock.json .node-version ./
RUN --mount=type=cache,target=/home/node/.npm,uid=1000,gid=1000 \
    test "$(node -p 'process.versions.node')" = "$(cat .node-version)" \
    && npm ci --ignore-scripts --no-audit --no-fund

FROM dependencies AS operator
ARG COMMIT_ID=unknown
ARG BUILD_DATE=unknown
LABEL org.opencontainers.image.title="SYMMIO Perps Core operator" \
      org.opencontainers.image.vendor="SYMMIO" \
      org.opencontainers.image.base.name="node:22.15.0-bookworm" \
      org.opencontainers.image.base.digest="sha256:a1f1274dadd49738bcd4cf552af43354bb781a7e9e3bc984cfeedc55aba2ddd8" \
      org.opencontainers.image.source="https://old-git.symmio.foundation/symmio/contracts/perps-core" \
      org.opencontainers.image.revision=${COMMIT_ID} \
      org.opencontainers.image.created=${BUILD_DATE} \
      org.opencontainers.image.version="0.8.6"
# Copy the entire config import closure, including schemas and utilities, before
# Hardhat starts. .dockerignore permits only source and reviewed build inputs.
COPY --chown=node:node . .
# Only the reviewed verification patch runs; dependency hooks and husky stay off.
RUN node scripts/patch-hardhat-verify.js \
    && node node_modules/hardhat/dist/src/cli.js compile \
    && node utils/check-contract-sizes.mjs
CMD ["node", "cli/symmio.js"]
