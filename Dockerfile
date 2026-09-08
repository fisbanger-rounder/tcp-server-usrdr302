# Multi-Protocol Telemetry Hub for PUSR USR-DR302
FROM node:20-alpine AS base

# Install dumb-init for proper signal forwarding and graceful shutdown
RUN apk add --no-cache dumb-init

WORKDIR /app

# Set production environment
ENV NODE_ENV=production

# Install dependencies first (leverages Docker layer cache)
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

# Copy application source code
COPY --chown=node:node . .

# Run as unprivileged non-root user
USER node

# Expose required network ports:
# - 3000: Web Dashboard & HTTPD Client Ingest
# - 5000: TCP Ingest for USR-DR302 (TCP Client Mode)
# - 5001: UDP Ingest for USR-DR302 (UDP Client Mode)
EXPOSE 3000/tcp
EXPOSE 5000/tcp
EXPOSE 5001/udp

# Healthcheck to verify HTTP service responsiveness
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:3000/api/system/network || exit 1

ENTRYPOINT ["/usr/bin/dumb-init", "--"]
CMD ["node", "server.js"]
