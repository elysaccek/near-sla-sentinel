FROM node:22.23.5-trixie-slim@sha256:68c76cfad89921b927eae28ba21407475e29d0ce450afcdbe70c1532db042b64 AS runtime
ENV NODE_ENV=production
COPY packages/shared/ /app/packages/shared/

FROM runtime AS master
WORKDIR /app/packages/master
COPY packages/master/package.json packages/master/package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund --cache /tmp/npm-cache && rm -rf /tmp/npm-cache
COPY packages/master/src/ ./src/
COPY packages/master/migrations/ ./migrations/
COPY deployment/master/provision-db.mjs ./provision-db.mjs
USER node
CMD ["node", "src/server.ts"]

FROM runtime AS oracle
WORKDIR /app/packages/operator
COPY packages/operator/package.json packages/operator/package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund --cache /tmp/npm-cache && rm -rf /tmp/npm-cache
COPY packages/operator/src/ ./src/
COPY deployment/oracle/worker.sh ./worker.sh
USER node
ENTRYPOINT ["/bin/sh", "./worker.sh"]
CMD ["run"]

FROM runtime AS console-build
WORKDIR /app/packages/web
COPY packages/web/package.json packages/web/package-lock.json ./
RUN npm ci --include=dev --no-audit --no-fund --cache /tmp/npm-cache
COPY packages/web/public/wallet.js ./public/
RUN npm run build && npm prune --omit=dev --no-audit --no-fund --cache /tmp/npm-cache

FROM runtime AS console
WORKDIR /app/packages/web
COPY --from=console-build /app/packages/web/node_modules ./node_modules/
COPY packages/web/src/ ./src/
COPY packages/web/public/ ./public/
COPY packages/operator/src/settlement/settlement.ts /app/packages/operator/src/settlement/
COPY packages/operator/src/monitoring/evidence.ts /app/packages/operator/src/monitoring/
COPY --from=console-build /app/packages/web/public/wallet-bundle.js ./public/
USER node
CMD ["node", "src/server.mjs"]

FROM runtime AS product
WORKDIR /app/packages/web
COPY packages/web/src/product*.mjs packages/web/src/testnet-feed.mjs ./src/
COPY packages/web/public/product* packages/web/public/how-it-works.* packages/web/public/testnet.* packages/web/public/sentinel-hero.webp ./public/
USER node
CMD ["node", "src/product-server.mjs"]

FROM rust:1.95.0-trixie@sha256:f49565f188ee00bc2a18dd418183f2c5f23ef7d6e691890517ed341a598f67c3 AS escrow-wasm
WORKDIR /build/contracts
RUN rustup target add wasm32-unknown-unknown
COPY contracts/sla-quorum/ ./sla-quorum/
COPY contracts/sla-escrow-v2/ ./sla-escrow-v2/
RUN RUSTFLAGS='--cfg near' cargo build --locked --release --target wasm32-unknown-unknown \
    --manifest-path sla-escrow-v2/Cargo.toml

FROM runtime AS sandbox-binary
ARG TARGETARCH
RUN set -eu; \
    case "$TARGETARCH" in \
      arm64) platform=Linux-aarch64; sha=d6b1ff773895972cd2fa098193c5d6cbc046912ff40bfe860e6c7abe807deedb ;; \
      amd64) platform=Linux-x86_64; sha=a0ba004218b218bd74351795e7ce2eda4a2b6af5cd3e252bd5e8bfe3c8f2e691 ;; \
      *) exit 1 ;; \
    esac; \
    node -e 'fetch(process.argv[1], {signal: AbortSignal.timeout(120_000)}).then(async r => { if (!r.ok) throw new Error("Sandbox download failed: " + r.status); require("node:fs").writeFileSync("/tmp/sandbox.tar.gz", Buffer.from(await r.arrayBuffer())); })' \
      "https://s3-us-west-1.amazonaws.com/build.nearprotocol.com/nearcore/$platform/2.14.0/near-sandbox.tar.gz"; \
    printf '%s  %s\n' "$sha" /tmp/sandbox.tar.gz | sha256sum -c -; \
    tar -xzf /tmp/sandbox.tar.gz -C /tmp "$platform/near-sandbox"; \
    mv "/tmp/$platform/near-sandbox" /usr/local/bin/; \
    rm -f /tmp/sandbox.tar.gz

FROM oracle AS local
COPY --from=sandbox-binary /usr/local/bin/near-sandbox /usr/local/bin/
COPY --from=escrow-wasm /build/contracts/sla-escrow-v2/target/wasm32-unknown-unknown/release/sla_escrow_v2.wasm /app/sla_escrow_v2.wasm
COPY deployment/local/*.mjs deployment/local/*.sh ./local/
ENTRYPOINT []

FROM oracle AS testnet-demo
COPY deployment/testnet/*.mjs deployment/testnet/*.sh ./live/
COPY deployment/local/files.mjs ./live/files.mjs
ENTRYPOINT []
