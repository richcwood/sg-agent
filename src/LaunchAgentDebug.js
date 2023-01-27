const os = require("os");
const fs = require("fs");
const path = require("path");
const util = require("util");
const configDir = path.join(__dirname, "pkg_agent");
process.env["NODE_CONFIG_DIR"] = configDir;
const config = require("../node_modules/config");

// console.log(`agent => __filename => ${__filename}`);
// console.log(`agent => __dirname => ${__dirname}`);
// console.log(`agent => process.execPath => ${process.execPath}`);
// console.log(`process.cwd => ${process.cwd()}`);
// console.log(`agent => process.argv[0] => ${process.argv[0]}`);
// console.log(`agent => process.argv[1] => ${process.argv[1]}`);
// console.log(`agent => require.main.filename => ${require.main.filename}`);

process.on("unhandledRejection", (reason, p) => {
  console.log(
    `Agent Launcher Unhandled Rejection - Reason: "${util.inspect(
      reason,
      false,
      null
    )}"`
  );
});

(async () => {
  try {
    let env = config.get("env");
    let apiUrl = config.get("apiUrl");
    let apiPort = config.get("apiPort");
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
      runStandAlone: true,
    };

    for (let i = 0; i < process.argv.length; i++) {
      if (process.argv[i] == "--LogDest") {
        if (process.argv.length > i) params.logDest = process.argv[i + 1];
      } else if (process.argv[i] == "--LogLevel") {
        if (process.argv.length > i) params.logLevel = process.argv[i + 1];
      } else if (process.argv[i] == "--TeamId") {
        if (process.argv.length > i) params._teamId = process.argv[i + 1];
      }
    }

    const Agent_1 = require("./Agent");
    let agentInstance = new Agent_1.default(params);
    await agentInstance.Init();
  } catch (e) {
    console.log(`Error in LaunchAgentDebug: "${e}"`);
  }
})();
