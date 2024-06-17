#!/usr/bin/env bash

set -e

VERSION=$(npx npm pkg get version | tr -d '"')
IMAGE_NAME=docker.solidatus.com/infrastructure-dev/mongo-k8s-sidecar:$VERSION
echo $IMAGE_NAME

docker build . --platform linux/amd64 -t $IMAGE_NAME --progress=plain

docker push $IMAGE_NAME
