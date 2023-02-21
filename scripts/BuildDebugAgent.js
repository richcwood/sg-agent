const pkg_1 = require('pkg');

const pkg_path = './dist/pkg_agent';
const out_path = process.argv[2];
const targets = process.argv[3];

pkg_1.exec([
    `./dist/LaunchAgentDebug.js`,
    '--config',
    `${pkg_path}/package.json`,
    '--targets',
    targets,
    '--out-path',
    `./${out_path}`,
]);
