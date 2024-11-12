FROM node:20-alpine

WORKDIR /app

COPY . .

RUN npm install && \
    npm i -D @sveltejs/adapter-node@1.3.1

RUN sed -i "s|import adapter from '@sveltejs/adapter-auto';|import adapter from '@sveltejs/adapter-node';|" svelte.config.js

RUN npm run build

EXPOSE 3000

CMD ["node", "build"]
