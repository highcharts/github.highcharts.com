FROM --platform=$TARGETPLATFORM node:lts-alpine as deps

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts

FROM --platform=$TARGETPLATFORM node:lts-alpine as builder

WORKDIR /app

# Install only production dependencies
COPY --from=deps /app/node_modules ./node_modules
COPY . .

FROM --platform=$TARGETPLATFORM node:lts-alpine as runner

RUN apk add --no-cache tini git

WORKDIR /app

ENV NODE_ENV=production

COPY --from=builder /app .

EXPOSE 8080

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "server.js"]
