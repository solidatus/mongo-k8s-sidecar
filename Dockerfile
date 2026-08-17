# This Dockerfile adheres to our best practises: https://www.notion.so/solidatus/Dockerfile-Best-Practises-197d1b030a5b80b18a09ef23b5348a7c

# Dockerfiles of the base image are here: https://github.com/nodejs/docker-node/tree/main/24
FROM node:24-alpine AS build

WORKDIR /app

# Copy package.json and package-lock.json and install first, allowing these to be cached
COPY package.json package-lock.json ./
RUN npm clean-install

COPY . .
# This will create the dist folder with the compiled code
RUN npm run build

FROM node:24-alpine

WORKDIR /app
RUN adduser -S -u 3737 -G root -g "solidatus" solidatus \
    && chown 3737:0 /app/ \
    && chmod 770 /app/ \
    && mkdir -p /app/dist/ \
    && chown 3737:0 /app/dist/ \
    && chmod 770 /app/dist/

COPY --chown=3737:0 --chmod=770 package.json package-lock.json /app/

# npm is only needed to install the runtime dependencies; the entrypoint is plain node. Remove it afterwards so
# vulnerability scanners don't flag the packages npm bundles in its own node_modules (brace-expansion, tar, undici).
# The npm shipped with the base image is sufficient for this, so there is no need to install a newer one.
RUN npm clean-install --omit=dev \
    && chown -R 3737:0 /app/node_modules/ \
    && chmod -R 770 /app/node_modules/ \
    && rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx /root/.npm

COPY --from=build --chown=3737:0 --chmod=770 /app/dist/ /app/dist/

USER 3737:0

ENTRYPOINT ["node", "/app/dist/index.js"]
