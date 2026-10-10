ARG BUILD_FROM=ghcr.io/home-assistant/amd64-base:3.22
FROM ${BUILD_FROM}

RUN apk add --no-cache nodejs npm

WORKDIR /app

# Install dependencies first to make use of the Docker layer cache
COPY app/package.json app/package-lock.json ./
RUN npm ci --no-audit --no-fund

COPY app/tsconfig.json ./
COPY app/scripts ./scripts
COPY app/src ./src
RUN npm run build \
    && npm prune --omit=dev --no-audit --no-fund \
    && rm -rf src scripts tsconfig.json /root/.npm

COPY run.sh /run.sh
RUN chmod a+x /run.sh

ARG BUILD_VERSION
ENV BRIDGE_VERSION=${BUILD_VERSION} \
    NODE_ENV=production

CMD ["/run.sh"]
