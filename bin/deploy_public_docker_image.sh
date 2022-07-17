#!/bin/bash

set -e

GIT_TAG=`git describe --tags --abbrev=0`

# docker tag sg-agent saasglue/sg-agent:$GIT_TAG
docker push saasglue/sg-agent:$GIT_TAG
docker push saasglue/sg-agent:latest