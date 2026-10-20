FROM node:22-alpine

WORKDIR /app

# Install dependencies first so this layer is cached until package files change.
# Dev dependencies are kept on purpose: tsx runs the TypeScript sources directly.
COPY package*.json ./
RUN if [ -f package-lock.json ]; then npm ci; else npm install; fi

COPY tsconfig.json ./
COPY src ./src
COPY scripts ./scripts
COPY migrations ./migrations

ENV NODE_ENV=production
EXPOSE 3000

#  wait for PostgreSQL, apply migrations, seed predefined plans
# start the service
CMD ["sh", "-c", "node_modules/.bin/tsx scripts/db-setup.ts && exec node_modules/.bin/tsx src/server.ts"]