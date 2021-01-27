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
import * as _ from 'lodash';

const waitForAgentCreateInterval = 15000;
const waitForAgentCreateMaxRetries = 20;

const userConfigPath: string = process.cwd() + '/sg.cfg';

export default class AgentStub {
    public logLevel: any = LogLevel.WARNING;
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
        if (params.hasOwnProperty('logLevel'))
            this.logLevel = parseInt(params['logLevel']);

        const userConfig: any = this.getUserConfigValues();
        if (process.env.SG_ACCESS_KEY_ID)
            params.accessKeyId = process.env.SG_ACCESS_KEY_ID;
        if (userConfig.SG_ACCESS_KEY_ID)
            params.accessKeyId = userConfig.SG_ACCESS_KEY_ID;

        if (!params.accessKeyId) {
            console.log(`Error starting the saas glue agent - authorization credentials missing. Install authorization credentials in the sg.cfg file or as an environment variable. See saasglue.com for details.`);
            process.exit(1);
        }
    
        if (process.env.SG_ACCESS_KEY_SECRET)
            params.accessKeySecret = process.env.SG_ACCESS_KEY_SECRET;
        if (userConfig.SG_ACCESS_KEY_SECRET)
            params.accessKeySecret = userConfig.SG_ACCESS_KEY_SECRET;

        if (!params.accessKeySecret) {
            console.log(`Error starting the saas glue agent - authorization credentials missing. Install authorization credentials in the sg.cfg file or as an environment variable. See saasglue.com for details.`);
            process.exit(1);
        }

        if (params.env == 'debug') {
            if (userConfig.debug) {
                if (userConfig.debug.machineId)
                    this.machineId = userConfig.debug.machineId;
                if (userConfig.debug.apiUrl)
                    this.apiUrl = userConfig.debug.apiUrl;
            }
        }
    }


    async Init() {
        await this.RestAPILogin();

        this.logger = new AgentLogger(this.params.appName, this.params._teamId, this.logLevel, process.cwd() + '/installer_logs', this.apiUrl, this.params.apiPort, this.params.agentLogsAPIVersion, this.RestAPICall, this.params.env, this.logDest, this.machineId);
        this.logger.Start();

        this.agentPath = path.dirname(process.argv[0]) + path.sep + 'sg-agent';
        this.agentPath = this.agentPath.replace('//', '/');
        this.agentPath = this.agentPath.replace('\\\\', '\\');
        if (process.platform.startsWith('win'))
            this.agentPath += '.exe';

        ipc.config.id = `SGAgentLauncherProc`;
        this.ipcPath = `/tmp/app.${SGUtils.makeid(10)}.${ipc.config.id}`;
        ipc.config.retry = 1500;
        ipc.config.silent = true;
        ipc.serve(this.ipcPath, () => ipc.server.on(`sg-agent-msg-${this.params._teamId}`, (message, socket) => {
            const logMsg = 'Message from Agent';
            this.logger.LogDebug(logMsg, message);
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
                    this.params.apiPort = message.propertyOverrides.apiPort;
                    this.logger.uploadPort = this.params.apiPort;
                }
                if (message.propertyOverrides.agentLogsAPIVersion) {
                    this.params.agentLogsAPIVersion = message.propertyOverrides.agentLogsAPIVersion;
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




    async RestAPILogin() {
        let apiUrl = this.apiUrl;

        const apiPort = this.params.apiPort;

        if (apiPort != '')
            apiUrl += `:${apiPort}`
        const url = `${apiUrl}/login/apiLogin`;

        const response = await axios({
            url,
            method: 'POST',
            responseType: 'text',
            headers: {
                'Content-Type': 'application/json'
            },
            data: {
                'accessKeyId': this.params.accessKeyId,
                'accessKeySecret': this.params.accessKeySecret
            }
        });

        let tmp = response.headers['set-cookie'][0].split(';');
        let auth: string = tmp[0];
        auth = auth.substring(5) + ';';
        this.params.token = auth;

        this.params.refreshToken = response.data.config2;
        this.params._teamId = response.data.config3;
    }


    async RefreshAPIToken() {
        let apiUrl = this.apiUrl;

        const apiPort = this.params.apiPort;

        if (apiPort != '')
            apiUrl += `:${apiPort}`
        const url = `${apiUrl}/login/refreshtoken`;

        const response = await axios({
            url,
            method: 'POST',
            responseType: 'text',
            headers: {
                'Content-Type': 'application/json',
                Cookie: `Auth=${this.params.refreshToken};`
            },
            data: {
                'accessKeyId': this.params.accessKeyId,
                'accessKeySecret': this.params.accessKeySecret
            }
        });

        let tmp = response.headers['set-cookie'][0].split(';');
        let auth: string = tmp[0];
        auth = auth.substring(5) + ';';
        this.params.token = auth;

        this.params.refreshToken = response.data.config2;
        this.params._teamId = response.data.config3;
    }


    async RestAPICall(url: string, method: string, headers: any = {}, data: any = {}) {
        return new Promise(async (resolve, reject) => {
            try {
                if (!this.params.token)
                    await this.RestAPILogin();
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
                this.logger.LogDebug(`RestAPICall`, {url, method, combinedHeaders, data, token: this.params.token});

                const response = await axios({
                    url,
                    method: method,
                    responseType: 'text',
                    headers: combinedHeaders,
                    data: data
                });

                if (_.isArray(response.headers['set-cookie']) && response.headers['set-cookie'].length > 0) {
                    let tmp = response.headers['set-cookie'][0].split(';');
                    let auth: string = tmp[0];
                    auth = auth.substring(5) + ';';
                    this.params.token = auth;
                }

                resolve(response.data.data);
            } catch (error) {
                if (error.response && error.response.data && error.response.data.errors && _.isArray(error.response.data.errors) && error.response.data.errors.length > 0 && error.response.data.errors[0].description == 'The access token expired') {
                    await this.RefreshAPIToken();
                    resolve(this.RestAPICall(url, method, headers, data));
                } else {
                    let newError: any = { config: error.config };
                    if (error.response) {
                        newError = Object.assign(newError, { data: error.response.data, status: error.response.status, headers: error.response.headers });
                        this.logger.LogError(`RestAPICall error:`, '', newError);
                    } else {
                        this.logger.LogError(`RestAPICall error`, '', newError);
                    }
                    reject(Object.assign(newError, { Error: error.message }));
                }
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
                    this.logger.LogError(`Error in AgentLauncher.Start`, '', { errProperties, error: e.toString() });
                }
                await SGUtils.sleep(30000);
            }
        }
    }


    async RunCommand(commandString: any, args: string[]) {
        return new Promise((resolve, reject) => {
            try {
                this.logger.LogDebug('AgentLauncher running command', { commandString, args });
                let cmd: any = spawn(commandString, args, { stdio: 'inherit', shell: true });

                // cmd.stdout.on('data', (data) => {
                //     try {
                //         this.logger.LogError('AgentStub command stdout: ' + data, null, {});
                //         console.log(`agent msg: ${data.toString()}`);
                //     } catch (e) {
                //         this.logger.LogError('Error handling stdout: ' + e.message, e.stack, {});
                //     }
                // });

                // cmd.stderr.on('data', (data) => {
                //     try {
                //         this.logger.LogError('Error running command in AgentLauncher: ' + data, null, {});
                //         // console.log(`agent err: ${data.toString()}`);
                //     } catch (e) {
                //         this.logger.LogError('Error handling stderr: ' + e.message, e.stack, {});
                //     }
                // });

                cmd.on('exit', (code) => {
                    try {
                        resolve({ 'code': code });
                    } catch (e) {
                        this.logger.LogError('Error handling script exit', e.stack, { error: e.toString() });
                    }
                });
            } catch (e) {
                this.logger.LogError(`Error running command`, e.stack, { error: e.toString() });
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
                    this.logger.LogDebug(`Agent download url`, { url, agentDownloadUrl});
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

                if (fs.existsSync(agentPathCompressed))
                    fs.unlinkSync(agentPathCompressed);

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
                res = await this.RunCommand(cmdString, [this.ipcPath, '--LogDest', this.logDest, '--LogLevel', this.logLevel, '--TeamId', this.params._teamId]);
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
            this.logger.LogError(`Error in AgentLauncher RunAgent'`, e.stack, { error: e.toString() });
            throw e;
        }
    }
}
