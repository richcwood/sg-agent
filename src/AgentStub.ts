import * as os from 'os';
import * as fs from 'fs';
import axios from 'axios';
import { spawn } from 'child_process';
import { AgentLogger } from './shared/SGAgentLogger';
import { SGUtils } from './shared/SGUtils';
import { LogLevel } from './shared/Enums';
import * as util from 'util';
import * as ipc from 'node-ipc';
import * as path from 'path';

const waitForAgentCreateInterval = 15000;
const waitForAgentCreateMaxRetries = 20;

const userConfigPath: string = process.cwd() + '/sg.cfg';

export default class AgentStub {
    public logLevel: any = LogLevel.DEBUG;
    private logger: AgentLogger;
    private agentPath: string;
    private ipcPath: string;
    private logDest: string;
    private machineId: string = undefined;
    private apiUrl: string = undefined;

    constructor(private params: any) {
        this.apiUrl = params.apiUrl;

        this.logDest = 'file';
        if (params.hasOwnProperty('logDest'))
            this.logDest = params['logDest'];

        if (params.env == 'debug') {
            const userConfig: any = this.getUserConfigValues();
            if (userConfig.debug) {
                if (userConfig.debug.machineId)
                    this.machineId = userConfig.debug.machineId;
                if (userConfig.debug.apiUrl)
                    this.apiUrl = userConfig.debug.apiUrl;
                if (userConfig.debug._teamId)
                    params._teamId = userConfig.debug._teamId;
                if (userConfig.debug.token)
                    params.token = userConfig.debug.token;
            }
        }

        this.logger = new AgentLogger(params.appName, params._teamId, this.logLevel, process.cwd() + '/installer_logs', this.apiUrl, params.apiPort, params.agentLogsAPIVersion, params.token, params.env, this.logDest, this.machineId);
        this.logger.Start();

        this.agentPath = path.dirname(process.argv[0]) + '/sg-agent';
        this.agentPath = this.agentPath.replace('//', '/');
        if (process.platform.startsWith('win'))
            this.agentPath += '.exe';

        ipc.config.id = `SGAgentLauncherProc`;
        this.ipcPath = `/tmp/app.${SGUtils.makeid(10)}.${ipc.config.id}`;
        ipc.config.retry = 1500;
        ipc.config.silent = true;
        ipc.serve(this.ipcPath, () => ipc.server.on(`sg-agent-msg-${params._teamId}`, (message, socket) => {
            const logMsg = 'Message from Agent: ' + util.inspect(message, false, null);
            this.logger.LogWarning(logMsg, {});
            if (message.propertyOverrides) {
                if (message.propertyOverrides.logLevel) {
                    this.logger.logLevel = message.propertyOverrides.logLevel;
                }
                if (message.propertyOverrides.instanceId) {
                    this.logger.instanceId = message.propertyOverrides.instanceId;
                }
                if (message.propertyOverrides.apiUrl) {
                    this.apiUrl = message.propertyOverrides.apiUrl;
                    this.logger.uploadURL = this.apiUrl;
                }
                if (message.propertyOverrides.apiPort) {
                    params.apiPort = message.propertyOverrides.apiPort;
                    this.logger.uploadPort = this.params.apiPort;
                }
                if (message.propertyOverrides.agentLogsAPIVersion) {
                    params.agentLogsAPIVersion = message.propertyOverrides.agentLogsAPIVersion;
                    this.logger.uploadAPIVersion = this.params.agentLogsAPIVersion;
                }
            }
        }));
        ipc.server.start();
    }


    MachineId() { return (this.machineId ? this.machineId : os.hostname()); }


    getUserConfigValues = () => {
        let userConfig = {};
        try {
            if (fs.existsSync(userConfigPath)) {
                userConfig = JSON.parse(fs.readFileSync(userConfigPath).toString());
            }
        } catch (e) {
            console.log(`Error getting user config values: ${e}`);
        }

        return userConfig;
    };


    async RestAPICall(url: string, method: string, headers: any = {}, data: any = {}) {
        return new Promise(async (resolve, reject) => {
            try {
                let apiUrl = this.apiUrl;
                let apiVersion = this.params.agentLogsAPIVersion;

                const apiPort = this.params.apiPort;

                if (apiPort != '')
                    apiUrl += `:${apiPort}`
                url = `${apiUrl}/api/${apiVersion}/${url}`;

                const combinedHeaders: any = Object.assign({
                    Cookie: `Auth=${this.params.token};`,
                    _teamId: this.params._teamId
                }, headers);

                // console.log('RestAPICall -> url ', url, ', method -> ', method, ', headers -> ', JSON.stringify(combinedHeaders, null, 4), ', data -> ', JSON.stringify(data, null, 4), ', token -> ', this.params.token);

                const response = await axios({
                    url,
                    method: method,
                    responseType: 'text',
                    headers: combinedHeaders,
                    data: data
                });
                resolve(response.data.data);
            } catch (error) {
                let newError: any = { config: error.config };
                if (error.response) {
                    newError = Object.assign(newError, { data: error.response.data, status: error.response.status, headers: error.response.headers });
                    this.logger.LogError(error.message, '', newError);
                } else {
                    this.logger.LogError(error.message, '', newError);
                }
                reject(Object.assign(newError, { Error: error.message }));
            }
        });
    }


    async Start() {
        while (true) {
            try {
                // let cron: any;
                // if ((process.platform.indexOf('darwin') >= 0) || (process.platform.indexOf('linux') >= 0))
                //     cron = await this.RunCommand('crontab -l', []);

                if (!fs.existsSync(this.agentPath)) {
                    await this.DownloadAgent();
                    this.logger.LogInfo('Agent downloaded', {});
                }

                await this.RunAgent();
                break;
            } catch (e) {
                if (e.status && e.status == 403) {
                    this.logger.LogError(`Error starting Agent: reached max agents for free tier - upgrade to professional tier to run additional agents`, '', {});
                } else {
                    let errProperties = {};
                    if (e.code)
                        errProperties['errno'] = e.code;
                    if (e.config && e.config.headers)
                        errProperties['headers'] = e.config.headers;
                    this.logger.LogError(`Error in AgentLauncher.Start: ${e.Error}`, '', errProperties);
                }
                await SGUtils.sleep(30000);
            }
        }
    }


    async RunCommand(commandString: any, args: string[]) {
        return new Promise((resolve, reject) => {
            try {
                this.logger.LogDebug('AgentLauncher running command: ' + commandString + ' ' + args, {});
                let cmd: any = spawn(commandString, args, { stdio: 'inherit', shell: true });

                // cmd.stdout.on('data', (data) => {
                //     try {
                //         this.logger.LogError('AgentStub command stdout: ' + data, null, {});
                //         console.log(`agent msg: ${data.toString()}`);
                //     } catch (e) {
                //         this.logger.LogError('Error handling stdout: ' + e.message, e.stack, {});
                //     }
                // });

                cmd.stderr.on('data', (data) => {
                    try {
                        this.logger.LogError('Error running command in AgentLauncher: ' + data, null, {});
                        // console.log(`agent err: ${data.toString()}`);
                    } catch (e) {
                        this.logger.LogError('Error handling stderr: ' + e.message, e.stack, {});
                    }
                });

                cmd.on('exit', (code) => {
                    try {
                        resolve({ 'code': code });
                    } catch (e) {
                        this.logger.LogError('Error handling script exit: ' + e.message, e.stack, {});
                    }
                });
            } catch (e) {
                this.logger.LogError(`Error running command '${commandString}': ${e.message}`, e.stack, {});
            }
        })
    };


    async DownloadAgent_GetUrl(numTries: number = 0) {
        return new Promise(async (resolve, reject) => {
            while (true) {
                try {
                    let url = `agentDownload/agent/${this.MachineId()}/${this.params.agentPlatform}`;
                    if (this.params.agentArch != '')
                        url += `/${this.params.agentArch}`

                    let agentDownloadUrl = await this.RestAPICall(url, 'GET', {_teamId: this.params._teamId}, null);
                    this.logger.LogDebug(`Agent download url from '${url}': ${agentDownloadUrl}`, {});
                    resolve(agentDownloadUrl);
                    break;
                } catch (err) {
                    if (err && err.status) {
                        if (err.status == 303) {
                            if (++numTries > waitForAgentCreateMaxRetries) {
                                reject(`Exceeded max tries to get agent download url - restarting: ${err}`);
                                break;
                            } else {
                                await SGUtils.sleep(waitForAgentCreateInterval);
                            }
                        } else {
                            reject(err);
                            break;
                        }
                    } else {
                        reject(err);
                        break;
                    }
                }
            }
        });
    };


    async DownloadAgent() {
        const agentS3URL: string = <string>await this.DownloadAgent_GetUrl();

        const agentPathCompressed = this.agentPath + '.gz';
        const writer = fs.createWriteStream(agentPathCompressed);

        const response = await axios({
            url: agentS3URL,
            method: 'GET',
            responseType: 'stream'
        });

        response.data.pipe(writer);

        return new Promise((resolve, reject) => {
            writer.on('finish', async () => {
                await SGUtils.GunzipFile(agentPathCompressed);
                await new Promise(async (resolve, reject) => {
                    fs.chmod(this.agentPath, 0o0755, ((err) => {
                        if (err) {
                            reject(err);
                            return;
                        }
                        resolve();
                        return;
                    }));
                });

                resolve();
                return;
            });
            writer.on('error', reject);
        });
    }


    async RunAgent() {
        let res;
        try {
            let cmdString = this.agentPath;
            if (fs.existsSync(this.agentPath)) {
                res = await this.RunCommand(cmdString, [this.ipcPath]);
                let logMsg: string;
                if (res.code == 96) {
                    logMsg = 'Updating and restarting agent';
                    this.logger.LogWarning(logMsg, {});
                    if (fs.existsSync(this.agentPath))
                        fs.unlinkSync(this.agentPath);
                } else {
                    logMsg = `Agent stopped (${util.inspect(res, false, null)}) - restarting`;
                    if (res.code != 0) {
                        this.logger.LogError(logMsg, '', { 'ExitCode': res.code, 'Result': util.inspect(res, false, null) });
                        if (fs.existsSync(this.agentPath))
                            fs.unlinkSync(this.agentPath);
                    } else {
                        this.logger.LogInfo(logMsg, { 'ExitCode': res.code, 'Result': util.inspect(res, false, null) });
                    }
                }
            }

            setTimeout(() => {
                this.Start();
            }, 5000);
        } catch (e) {
            this.logger.LogError(`Error in AgentLauncher RunAgent: '${e}'`, e.stack, {});
            throw e;
        }
    }
}
