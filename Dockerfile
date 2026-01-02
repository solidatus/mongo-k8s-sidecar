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

RUN npm install --omit=dev \
    && chown -R 3737:0 /app/node_modules/ \
    && chmod -R 770 /app/node_modules/

COPY --from=build --chown=3737:0 --chmod=770 /app/dist/ /app/dist/

USER 3737:0

ENTRYPOINT ["node", "/app/dist/index.js"]
