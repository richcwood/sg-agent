#!/bin/bash

set -e

GIT_TAG=$1

# docker tag sg-agent saasglue/sg-agent:$GIT_TAG
docker push saasglue/sg-agent:$GIT_TAG
docker push saasglue/sg-agent:latest