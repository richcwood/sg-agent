const os = require('os');
const fs = require('fs');
const path = require('path');
const util = require('util');
const configDir = path.join(__dirname, 'pkg_agent');
process.env["NODE_CONFIG_DIR"] = configDir;
const config = require('../node_modules/config');

// console.log(`agent => __filename => ${__filename}`);
// console.log(`agent => __dirname => ${__dirname}`);
// console.log(`agent => process.execPath => ${process.execPath}`);
// console.log(`process.cwd => ${process.cwd()}`);
// console.log(`agent => process.argv[0] => ${process.argv[0]}`);
// console.log(`agent => process.argv[1] => ${process.argv[1]}`);
// console.log(`agent => require.main.filename => ${require.main.filename}`);

process.on('unhandledRejection', (reason, p) => {
    console.log(`Agent Unhandled Rejection - Promise: "${util.inspect(p, false, null)}", Reason: "${util.inspect(reason, false, null)}"`);
});

( async () => {
    try {

        let _teamId = config.get('_teamId');
        let env = config.get('env');
        let token = config.get('token');
        let apiUrl = config.get('apiUrl');
        let apiPort = config.get('apiPort');
        let agentLogsAPIVersion = config.get('agentLogsAPIVersion');

        let logDest = 'console';
        if (config.has('logDest')) {
            logDest = config.get('logDest');
        }

        const params = {
            _teamId: _teamId,
            env: env,
            token: token,
            apiUrl: apiUrl,
            apiPort: apiPort,
            agentLogsAPIVersion: agentLogsAPIVersion,
            logDest: logDest,
            runStandAlone: true
        }

        const Agent_1 = require('./Agent');
        let agentInstance = new Agent_1.default(params);
        await agentInstance.Init();
    } catch(e) {
        console.log(`Error in Agent: "${e}"`);
    }
})();
