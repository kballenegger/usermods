# usermods site. Build context is the repo root; only site/ is copied
# (site/Dockerfile.dockerignore). The generator and server have no npm deps.
FROM node:24-alpine
WORKDIR /app
ARG GIT_REVISION=dev
ENV GIT_REVISION=$GIT_REVISION
COPY site/ site/
RUN node site/bin/build.ts
ENV NODE_ENV=production \
    DATA_DIR=/data \
    PORT=8080
EXPOSE 8080
CMD ["node", "site/src/server.ts"]
