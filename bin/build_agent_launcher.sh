#!/bin/bash

set -e

export DOCKER_BUILDKIT=1

BUILD_CONFIG_PATH=$1
PLATFORM=$2
BUILD_OUT_PATH=$3

# Valid platforms: macos, linux, win-x64
BUILD_TARGET_PLATFORMS="node16-$PLATFORM"

npm run build
cp configs/package-agent-stub.json ./dist/pkg_agent_stub/packge.json
cp $BUILD_CONFIG_PATH/default.json ./dist/pkg_agent_stub/
node ./scripts/BuildAgentStub.js $BUILD_OUT_PATH $BUILD_TARGET_PLATFORMS

cp $BUILD_CONFIG_PATH/sg.cfg $BUILD_OUT_PATH