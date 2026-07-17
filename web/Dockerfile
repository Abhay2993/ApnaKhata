# ApnaKhata web preview — built with the live API URL baked in, served by nginx.
FROM node:20-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . ./
# The browser reaches the API via the host-published port, so this is a
# host-perspective URL (default matches docker-compose's api port mapping).
ARG VITE_API_URL=http://localhost:8080
ARG VITE_API_KEY=demo-key
ARG VITE_DEMO_USER_ID=22222222-2222-2222-2222-222222222222
ENV VITE_API_URL=$VITE_API_URL
ENV VITE_API_KEY=$VITE_API_KEY
ENV VITE_DEMO_USER_ID=$VITE_DEMO_USER_ID
RUN npm run build

FROM nginx:alpine
COPY --from=build /app/dist /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
