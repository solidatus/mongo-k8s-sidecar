FROM node:22-alpine AS build
WORKDIR /app

COPY . .
RUN npm install
RUN npm run build

FROM node:22-alpine AS production
WORKDIR /app

COPY --from=build /app/dist ./dist
COPY --from=build /app/package.json /app/package-lock.json ./

RUN npm install --omit=dev
CMD ["npm", "run", "start"]
