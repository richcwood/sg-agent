export SG_AGENT_CONFIG_PATH=${1:-./run/dev_test}

node ./run/LaunchAgent.js $1
