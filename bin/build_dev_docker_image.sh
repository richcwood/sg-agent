#!/bin/bash

set -e

export DOCKER_BUILDKIT=1

GIT_TAG=$1
SUFFIX=$2
BUILD_CONFIG_PATH=$3
PLATFORM=$4

# Valid platforms: macos, linux, win-x64

BUILD_OUT_PATH="deploy/docker/agent/dev/Agent_$SUFFIX"
BUILD_TARGET_PLATFORMS="node16-$PLATFORM"

npm run build
cp ./configs/package-agent-stub.json ./dist/pkg_agent_stub/packge.json
cp $BUILD_CONFIG_PATH/default.json ./dist/pkg_agent_stub/
cp ./configs/package-agent.json ./dist/pkg_agent/package.json
cp $BUILD_CONFIG_PATH/default.json ./dist/pkg_agent/
node ./scripts/BuildAgentStub.js $BUILD_OUT_PATH $BUILD_TARGET_PLATFORMS
node ./scripts/BuildAgent.js $BUILD_OUT_PATH $BUILD_TARGET_PLATFORMS

docker buildx build -t sg-agent-$SUFFIX:$GIT_TAG --target sg-agent-$SUFFIX --load -f deploy/docker/agent/dev/Dockerfile.$SUFFIX .
docker tag sg-agent-$SUFFIX:$GIT_TAG saasglue/sg-agent-$SUFFIX:$GIT_TAG
docker tag sg-agent-$SUFFIX:$GIT_TAG saasglue/sg-agent-$SUFFIX:latest