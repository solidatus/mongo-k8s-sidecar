FROM node:14-alpine

WORKDIR /opt/cvallance/mongo-k8s-sidecar

COPY package.json /opt/cvallance/mongo-k8s-sidecar/package.json
COPY package-lock.json /opt/cvallance/mongo-k8s-sidecar/package-lock.json

RUN npm install --production

COPY .foreverignore /opt/cvallance/.foreverignore
COPY ./src /opt/cvallance/mongo-k8s-sidecar/src

CMD ["npm", "start"]
