FROM node:22-alpine AS build
WORKDIR /app

# Copy package.json and package-lock.json and install first, allowing these to be cached
COPY package.json package-lock.json ./
RUN npm clean-install

COPY . .
RUN npm run build

FROM node:22-alpine AS production
WORKDIR /app

# Copy package.json and package-lock.json and install first, allowing these to be cached
COPY --from=build /app/package.json /app/package-lock.json ./
RUN npm install --omit=dev

COPY --from=build /app/dist ./dist

CMD ["node", "./dist/index.js"]
