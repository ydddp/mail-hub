FROM node:20-alpine AS build
RUN apk add --no-cache python3 make g++
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci || npm install
COPY tsconfig.json ./
COPY src ./src
RUN npm run build
RUN npm prune --omit=dev

FROM node:20-alpine
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
