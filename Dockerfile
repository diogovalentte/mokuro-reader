FROM node:22-alpine AS build

WORKDIR /app

COPY . .

RUN npm install && \
    npm i -D @sveltejs/adapter-node@1.3.1

RUN sed -i "s|import adapter from '@sveltejs/adapter-auto';|import adapter from '@sveltejs/adapter-node';|" svelte.config.js

RUN npm run build

FROM gcr.io/distroless/nodejs22-debian12:nonroot

COPY --from=build /app/build /app/build
COPY --from=build /app/node_modules /app/node_modules

WORKDIR /app

EXPOSE 3000

CMD ["build"]
