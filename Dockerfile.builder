FROM --platform=$TARGETPLATFORM node:lts-alpine AS deps

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts

FROM --platform=$TARGETPLATFORM node:lts-alpine AS runner

RUN apk add --no-cache tini tar gzip && \
    mkdir -p /app/tmp && \
    printf '{}\n' > /app/config.json && \
    chown node:node /app/config.json /app/tmp

WORKDIR /app
ENV NODE_ENV=production BUILDER_PORT=8080 BUILDER_CACHE_ROOT=/app/tmp

COPY --from=deps --chown=node:node /app/node_modules ./node_modules
COPY --chown=node:node package.json builder-server.js ./
COPY --chown=node:node app ./app

USER node
EXPOSE 8080
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["npm", "run", "start:builder"]
