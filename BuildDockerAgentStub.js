const pkg_1 = require("pkg");

const pkg_path = "./dist/pkg_agent_stub";

const out_path = process.argv[2];

pkg_1.exec([
  `./dist/LaunchAgentStub.js`,
  "--config",
  `${pkg_path}/package.json`,
  "--targets",
  "node16-linux",
  "--out-path",
  `./${out_path}`,
]);
