export SG_AGENT_CONFIG_PATH=${1:-./configs/dev_test}

node ./scripts/LaunchAgent.js $SG_AGENT_CONFIG_PATH
