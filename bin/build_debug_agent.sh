#!/bin/bash

set -e

export DOCKER_BUILDKIT=1

BUILD_CONFIG_PATH=$1
PLATFORM=$2
BUILD_OUT_PATH=$3
ARCH=$4

# Valid platform: macos, linux, win-x64
# Valid arch: blank except 'arm64' for 'macos' (M1/M2)
BUILD_TARGET_PLATFORMS="node16-$PLATFORM"

if [ $# -gt 3 ];
then
    BUILD_TARGET_PLATFORMS=( "$BUILD_TARGET_PLATFORMS-$ARCH" )
fi

npm run build
cp configs/package-agent.json ./dist/pkg_agent/package.json
cp $BUILD_CONFIG_PATH/default.json ./dist/pkg_agent/
node ./scripts/BuildDebugAgent.js $BUILD_OUT_PATH $BUILD_TARGET_PLATFORMS

cp $BUILD_CONFIG_PATH/sg.cfg $BUILD_OUT_PATH