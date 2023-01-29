const os = require('os');
const path = require('path');
const util = require('util');
const SGUtils_1 = require('./shared/SGUtils');
const configDir = path.join(__dirname, 'pkg_agent_stub');
process.env['NODE_CONFIG_DIR'] = configDir;
const config = require('../node_modules/config');
const lockfile = require('proper-lockfile');

// console.log(`__filename => ${__filename}`);
// console.log(`__dirname => ${__dirname}`);
// console.log(`process.execPath => ${process.execPath}`);
// console.log(`process.cwd => ${process.cwd()}`);
// console.log(`process.argv[0] => ${process.argv[0]}`);
// console.log(`process.argv[1] => ${process.argv[1]}`);
// console.log(`require.main.filename => ${require.main.filename}`);

process.on('unhandledRejection', (reason, p) => {
    console.log(
        `AgentLauncher Unhandled Rejection - Promise: "${util.inspect(p, false, null)}", Reason: "${util.inspect(
            reason,
            false,
            null
        )}"`
    );
});

(async () => {
    try {
        await new Promise((resolve, reject) => {
            lockfile
                .lock(process.argv[0])
                .then((release) => {
                    resolve();
                })
                .catch((err) => {
                    reject(`Error starting sg-agent-launcher: ${err.message}`);
                });
        });

        machineId = os.hostname();
        ipAddress = SGUtils_1.SGUtils.getIpAddress();

        // console.log("config ----------> ", config);

        // const fs = require('fs');
        // fs.readdirSync('./').forEach(file => {
        //     console.log(file);
        // });

        let apiUrl = config.get('apiUrl');
        let apiPort = config.get('apiPort');
        let agentLogsAPIVersion = config.get('agentLogsAPIVersion');
        let agentPlatform = config.get('agentPlatform');
        let agentArch = config.get('agentArch');
        let env = config.get('env');

        let logDest = 'file';
        if (config.has('logDest')) logDest = config.get('logDest');

        const params = {
            appName: 'AgentStub',
            machineId: machineId,
            ipAddress: ipAddress,
            apiUrl: apiUrl,
            apiPort: apiPort,
            agentLogsAPIVersion: agentLogsAPIVersion,
            agentPlatform: agentPlatform,
            agentArch: agentArch,
            logDest: logDest,
            env: env,
        };

        for (let i = 0; i < process.argv.length; i++) {
            if (process.argv[i] == '--LogDest') {
                if (process.argv.length > i) params.logDest = process.argv[i + 1];
            } else if (process.argv[i] == '--LogLevel') {
                if (process.argv.length > i) params.logLevel = process.argv[i + 1];
            }
        }

        const AgentStub_1 = require('./AgentStub');
        let agentStubInstance = new AgentStub_1.default(params);
        await agentStubInstance.Init();
        await agentStubInstance.Start();
    } catch (e) {
        console.log(`Error in AgentLauncher: "${e}"`);
    }
})();
