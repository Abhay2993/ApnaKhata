# ApnaKhata API gateway + worker + migrate/seed CLIs.
# Build context is the REPOSITORY ROOT (the image needs ../database at runtime
# for the migration runner). See docker-compose.yml.

FROM node:20-alpine AS build
WORKDIR /app/backend
COPY backend/package*.json ./
RUN npm ci
COPY backend/tsconfig.json ./
COPY backend/src ./src
RUN npm run build

FROM node:20-alpine
WORKDIR /app/backend
ENV NODE_ENV=production
COPY backend/package*.json ./
RUN npm ci --omit=dev
COPY --from=build /app/backend/dist ./dist
# migrate.js resolves ../../../database from dist/db → /app/database
COPY database /app/database
EXPOSE 8080
CMD ["node", "dist/server.js"]
