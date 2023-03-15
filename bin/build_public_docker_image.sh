#!/bin/bash

set -e

export DOCKER_BUILDKIT=1

GIT_TAG=$1
BUILD_CONFIG_PATH=$2
PLATFORM=$3

BUILD_OUT_PATH="deploy/docker/agent/prod"
BUILD_TARGET_PLATFORMS="node16-$PLATFORM"

npm run build
cp $BUILD_CONFIG_PATH/package.json ./dist/pkg_agent_stub/
cp $BUILD_CONFIG_PATH/default.json ./dist/pkg_agent_stub/
node ./scripts/BuildAgentStub.js $BUILD_OUT_PATH $BUILD_TARGET_PLATFORMS

docker buildx build -t sg-agent:$GIT_TAG --target sg-agent --load -f deploy/docker/agent/prod/Dockerfile .
docker tag sg-agent:$GIT_TAG saasglue/sg-agent:$GIT_TAG
docker tag sg-agent:$GIT_TAG saasglue/sg-agent:latest
