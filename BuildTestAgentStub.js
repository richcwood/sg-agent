const pkg_1 = require("pkg");

const pkg_path = './dist/pkg_agent_stub'

pkg_1.exec([`./dist/LaunchAgentStub.js`, '--config', `${pkg_path}/package.json`, '--targets', 'node10-linux', '--out-path', `./${pkg_path}`]);
