const os = require("os");
const fs = require("fs");
const path = require("path");
const util = require("util");

process.env["NODE_CONFIG_DIR"] = process.argv[2];
const config = require("../node_modules/config");
process.on("unhandledRejection", (reason, p) => {
  console.log(`Agent Launcher Unhandled Rejection - Reason: "${util.inspect(reason, false, null)}"`);
});

(async () => {
  try {
    let env = config.get("env");
    let apiUrl = config.get("apiUrl");
    let apiPort = config.get("apiPort");
    let logLevel = config.get("logLevel");
    let teamId = config.get("teamId");
    let agentLogsAPIVersion = config.get("agentLogsAPIVersion");

    let logDest = "console";
    if (config.has("logDest")) {
      logDest = config.get("logDest");
    }

    const params = {
      env: env,
      apiUrl: apiUrl,
      apiPort: apiPort,
      agentLogsAPIVersion: agentLogsAPIVersion,
      logDest: logDest,
      logLevel: logLevel,
      _teamId: teamId,
      runStandAlone: true,
    };

    const Agent_1 = require("../dist/Agent");
    let agentInstance = new Agent_1.default(params);
    await agentInstance.Init();
  } catch (e) {
    console.log(`Error in LaunchAgent: "${e}"`);
  }
})();
