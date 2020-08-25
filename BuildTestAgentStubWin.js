const pkg_1 = require("pkg");

const pkg_path = './dist/pkg_agent_stub'

pkg_1.exec([`./dist/LaunchAgentStub.js`, '--config', `${pkg_path}/package.json`, '--targets', 'node10-win-x64', '--out-path', `./${pkg_path}`]);
