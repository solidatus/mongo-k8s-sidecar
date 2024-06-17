FROM node:11-alpine

WORKDIR /opt/cvallance/mongo-k8s-sidecar

COPY package.json /opt/cvallance/mongo-k8s-sidecar/package.json

RUN npm install --only=prod

COPY .foreverignore /opt/cvallance/.foreverignore
COPY ./src /opt/cvallance/mongo-k8s-sidecar/src

CMD ["npm", "start"]
