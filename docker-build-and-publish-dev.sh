#!/usr/bin/env bash

set -e

# For dev just run like './docker-build-and-publish-dev.sh'
# For prod run like './docker-build-and-publish-dev.sh infrastructure'

PROJECT_NAME=${1:-infrastructure-dev}

VERSION=$(npx npm pkg get version | tr -d '"')
IMAGE_NAME=docker.solidatus.com/$PROJECT_NAME/mongo-k8s-sidecar:$VERSION
echo $IMAGE_NAME

docker build . --platform linux/amd64 -t $IMAGE_NAME --progress=plain

docker push $IMAGE_NAME
