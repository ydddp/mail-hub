FROM node:24.22.2-alpine@sha256:a34ab6d7f6f4813f4d0c5469d74685604b962fbdbf5793a7bc7b4998ecb867c8 AS build
RUN apk add --no-cache python3 make g++
WORKDIR /app
COPY package.json package-lock.json ./
# --omit=optional keeps keytar out. It arrives as an optional dependency of
# icloudjs with an install script, so every build would compile a native module
# through node-gyp — for a keychain this code goes out of its way never to
# touch (icloud-auth always passes username and password explicitly so the
# library never reaches for it). The only other production optional package is
# node-addon-api, which is keytar's own build dependency.
RUN npm ci --omit=optional
COPY tsconfig.json ./
COPY src ./src
RUN npm run build
RUN npm prune --omit=dev

FROM node:24.22.2-alpine@sha256:a34ab6d7f6f4813f4d0c5469d74685604b962fbdbf5793a7bc7b4998ecb867c8
RUN apk add --no-cache libstdc++
WORKDIR /app
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
RUN mkdir -p /app/data
ENV PORT=3100 HOST=0.0.0.0 DB_PATH=/app/data/mail.db
EXPOSE 3100
VOLUME /app/data
CMD ["node", "dist/index.js"]
