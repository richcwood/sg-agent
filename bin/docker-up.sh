#!/bin/bash

set -e

DOCKER_PATH=$1
DOCKER_COMPOSE_PATH=$DOCKER_PATH/docker-compose.yml

docker-compose -f $DOCKER_COMPOSE_PATH up
