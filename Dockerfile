FROM node:24-alpine AS builder
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
# Optional: serve under a subpath like /webmail. Baked into emitted asset URLs
# at build time, so it cannot be changed without rebuilding.
ARG NEXT_PUBLIC_BASE_PATH=
ENV NEXT_PUBLIC_BASE_PATH=$NEXT_PUBLIC_BASE_PATH
# Optional: fallback UI locale (e.g. tr, de, fr) used when the visitor's
# Accept-Language header does not match any supported locale. Baked in at
# build time because next-intl wires it into client-side routing too.
ARG NEXT_PUBLIC_DEFAULT_LOCALE=
ENV NEXT_PUBLIC_DEFAULT_LOCALE=$NEXT_PUBLIC_DEFAULT_LOCALE
# Commit SHA shown in the About screen. .dockerignore excludes .git, so
# `git rev-parse` inside the build can't find it - CI must pass it in.
ARG GIT_COMMIT=unknown
ENV GIT_COMMIT=$GIT_COMMIT
# Per-deployment default XPR network (baked into the client bundle). The testnet
# stack passes "testnet" so its site defaults to testnet; mainnet leaves it empty
# and defaults to mainnet. See lib/xpr-network.ts.
ARG NEXT_PUBLIC_DEFAULT_NETWORK=
ENV NEXT_PUBLIC_DEFAULT_NETWORK=$NEXT_PUBLIC_DEFAULT_NETWORK
# Per-network XPR auth-service base URLs (baked into the client bundle).
# lib/xpr-network.ts already has correct hardcoded per-network fallbacks
# (auth.mailsigil.pro / testnet-auth.mailsigil.pro) used when these are left
# unset, so omitting them preserves today's behavior exactly on both builds;
# set explicitly here so ops can repoint an auth backend without a code change.
ARG NEXT_PUBLIC_XPR_AUTH_URL_MAINNET=
ENV NEXT_PUBLIC_XPR_AUTH_URL_MAINNET=$NEXT_PUBLIC_XPR_AUTH_URL_MAINNET
ARG NEXT_PUBLIC_XPR_AUTH_URL_TESTNET=
ENV NEXT_PUBLIC_XPR_AUTH_URL_TESTNET=$NEXT_PUBLIC_XPR_AUTH_URL_TESTNET
# Comma-separated networks whose sign-in is paused (e.g. "mainnet"). The toggle
# still offers and switches to them; only login/account creation is blocked.
# Must match LOGIN_MAINTENANCE on that network's auth service — this arg is the
# UI half, the auth service is what actually enforces it.
ARG NEXT_PUBLIC_MAINTENANCE_NETWORKS=
ENV NEXT_PUBLIC_MAINTENANCE_NETWORKS=$NEXT_PUBLIC_MAINTENANCE_NETWORKS
RUN npx next build --webpack

FROM node:24-alpine AS runner

LABEL org.opencontainers.image.title="Bulwark Webmail"
LABEL org.opencontainers.image.description="Modern webmail client built with Next.js and the JMAP protocol"
LABEL org.opencontainers.image.source="https://github.com/bulwarkmail/webmail"
LABEL org.opencontainers.image.url="https://github.com/bulwarkmail/webmail"
LABEL org.opencontainers.image.licenses="AGPL-3.0-only"
LABEL org.opencontainers.image.vendor="rbm.systems"

WORKDIR /app
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
RUN apk upgrade --no-cache && \
    npm uninstall -g npm && \
    rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npx && \
    addgroup --system --gid 1001 nodejs && \
    adduser --system --uid 1001 nextjs
COPY --from=builder /app/public ./public
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static
RUN mkdir -p /app/data/settings /app/data/admin /app/data/admin-state /app/data/telemetry && chown -R nextjs:nodejs /app/data
USER nextjs
EXPOSE 3000
ENV PORT=3000
ENV HOSTNAME="0.0.0.0"
CMD ["node", "server.js"]
