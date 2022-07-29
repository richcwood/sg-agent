#!/bin/bash

set -e

SG_ACCESS_KEY_ID=$1
SG_ACCESS_KEY_SECRET=$2

cd deploy/kubernetes/helm
helm upgrade --install saasglue-agent --set accessKeyId=$SG_ACCESS_KEY_ID --set accessKeySecret=$SG_ACCESS_KEY_SECRET --debug --wait .