#!/bin/bash

set -e

export DOCKER_BUILDKIT=1

GIT_TAG=$1

npm run build
node ./BuildDockerAgentStub.js deploy/docker/agent/test/
node ./BuildDockerAgent.js deploy/docker/agent/test/

docker buildx build -t sg-agent:$GIT_TAG --target sg-agent --load -f deploy/docker/agent/test/Dockerfile .
docker tag sg-agent:$GIT_TAG saasglue/sg-agent:$GIT_TAG
docker tag sg-agent:$GIT_TAG saasglue/sg-agent:latest