# Built from the monorepo root: docker build -f apps/server/Dockerfile ../../
FROM node:20-alpine AS build
WORKDIR /repo
COPY package.json ./
COPY packages/core/package.json packages/core/package.json
COPY packages/sync/package.json packages/sync/package.json
COPY apps/server/package.json apps/server/package.json
RUN npm install --workspace @pw/server --workspace @pw/core --workspace @pw/sync
COPY packages/core packages/core
COPY packages/sync packages/sync
COPY apps/server apps/server
RUN npm install -g typescript && tsc -p apps/server --outDir apps/server/dist

FROM node:20-alpine
WORKDIR /repo
COPY --from=build /repo/node_modules node_modules
COPY --from=build /repo/apps/server/dist apps/server/dist
COPY apps/server/migrations apps/server/migrations
COPY apps/server/package.json apps/server/package.json
ENV NODE_ENV=production
EXPOSE 8787
CMD ["node", "apps/server/dist/index.js"]
