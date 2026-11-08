FROM node:24-alpine AS build

WORKDIR /app

COPY . .

RUN npm install && \
    npm i -D @sveltejs/adapter-node@5

RUN sed -i -E \
      -e "s|import adapter from '@sveltejs/adapter-[a-z]+';|import adapter from '@sveltejs/adapter-node';|" \
      -e "s|adapter\(\{[^}]*\}\)|adapter()|" \
      svelte.config.js && \
    grep -q "@sveltejs/adapter-node" svelte.config.js

RUN npm run build

FROM gcr.io/distroless/nodejs24-debian12:nonroot

COPY --from=build /app/build /app/build
COPY --from=build /app/node_modules /app/node_modules

WORKDIR /app

EXPOSE 3000

CMD ["build"]
