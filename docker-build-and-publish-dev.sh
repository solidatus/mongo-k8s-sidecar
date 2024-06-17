#!/usr/bin/env bash

VERSION=$(npx npm pkg get version | tr -d '"')
IMAGE_NAME=docker.solidatus.com/infrastructure-dev/mongo-k8s-sidecar:$VERSION
echo $IMAGE_NAME

docker build . --platform linux/amd64 -t $IMAGE_NAME

docker push $IMAGE_NAME
