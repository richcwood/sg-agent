import * as os from 'os';
import * as fs from 'fs';
import axios from 'axios';
import { spawn } from 'child_process';
import { AgentLogger } from './shared/SGAgentLogger';
import { SGUtils } from './shared/SGUtils';
import { LogLevel } from './shared/Enums';
import * as ipc from 'node-ipc';
import { IPCClient, IPCServer } from './shared/Comm';
import * as util from 'util';
import * as path from 'path';
import * as _ from 'lodash';

const waitForAgentCreateInterval = 15000;
const waitForAgentCreateMaxRetries = 20;

const userConfigPath: string = SGUtils.getConfigFilePath();

export default class AgentStub {
    private appName: string;
    public logLevel: any = LogLevel.WARNING;
    private logger: AgentLogger;
    private rootPath: string;
    private agentPath: string;
    private ipcClient: any = undefined;
    private ipcServer: any = undefined;
    private logDest: string;
    private env: string;
    private machineId: string = undefined;
    private apiUrl: string = undefined;
    private _teamId: string;
    private agentProc: any = undefined;

    constructor(private params: any) {
        this.appName = 'AgentStub';
        this.apiUrl = params.apiUrl;
        this.env = params.env;

        if (Object.prototype.hasOwnProperty.call(params, 'logLevel')) this.logLevel = parseInt(params['logLevel']);

        this.logDest = 'file';
        if (Object.prototype.hasOwnProperty.call(params, 'logDest')) this.logDest = params['logDest'];

        const userConfig: any = this.getUserConfigValues();
        if (process.env.SG_ACCESS_KEY_ID) params.accessKeyId = process.env.SG_ACCESS_KEY_ID;
        if (userConfig.SG_ACCESS_KEY_ID) params.accessKeyId = userConfig.SG_ACCESS_KEY_ID;

        if (!params.accessKeyId) {
            console.log(
                `Error starting the SaasGlue agent launcher - authorization id credentials missing. Install authorization credentials in the sg.cfg file or as an environment variable. See saasglue.com for details.`
            );
            process.exit(1);
        }

        if (process.env.SG_ACCESS_KEY_SECRET) params.accessKeySecret = process.env.SG_ACCESS_KEY_SECRET;
        if (userConfig.SG_ACCESS_KEY_SECRET) params.accessKeySecret = userConfig.SG_ACCESS_KEY_SECRET;

        if (!params.accessKeySecret) {
            console.log(
                `Error starting the SaasGlue agent launcher - authorization secret credentials missing. Install authorization credentials in the sg.cfg file or as an environment variable. See saasglue.com for details.`
            );
            process.exit(1);
        }

        if (this.env == 'debug') {
            if (userConfig.debug) {
                if (userConfig.debug.machineId) this.machineId = userConfig.debug.machineId;
                if (userConfig.debug.apiUrl) this.apiUrl = userConfig.debug.apiUrl;
            }
        }
    }

    async Init() {
        await this.RestAPILogin();

        this.logger = new AgentLogger(
            this,
            this.logLevel,
            process.cwd() + '/installer_logs',
            this.apiUrl,
            this.params.apiPort,
            this.params.agentLogsAPIVersion
        );
        this.logger.Start();

        process.on('SIGINT', this.SignalHandler.bind(this));
        process.on('SIGTERM', this.SignalHandler.bind(this));

        this.rootPath = path.dirname(process.argv[0]) + path.sep;
        this.rootPath = this.rootPath.replace('//', '/');
        this.rootPath = this.rootPath.replace('\\\\', '\\');

        this.agentPath = this.rootPath + '_sg-sub-proc';
        if (process.platform.startsWith('win')) this.agentPath += '.exe';

        this.ipcServer = new IPCServer(
            'SGAgentLauncherProc',
            SGUtils.makeid(10),
            `sg-agent-msg-${this._teamId}`,
            async (message) => {
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
                if (message.agentIPCServerPath) {
                    const agentIPCServerPath: string = message.agentIPCServerPath;
                    this.ipcClient = new IPCClient(
                        'SGAgentProc',
                        `sg-agent-launcher-proc-${this._teamId}`,
                        agentIPCServerPath,
                        () => {
                            this.logger.LogError('Error connecting to agent', '', {});
                        },
                        () => {
                            this.logger.LogError(`Failed to connect to agent`, '', {});
                        },
                        async () => {
                            this.logger.LogWarning(`Disconnected from agent`, {});
                        }
                    );
                    await this.ipcClient.ConnectIPC();
                }
            }
        );
    }

    async SignalHandler(signal) {
        try {
            const params: any = { signal: signal };
            this.logger.LogDebug(`Sending message to agent`, params);
            await ipc.of.SGAgentProc.emit(`sg-agent-launcher-msg-${this._teamId}`, params);
        } catch (e) {
            this.logger.LogError(`Error sending message to agent`, e.stack, {
                error: e.toString(),
            });
        }
    }

    MachineId() {
        return this.machineId ? this.machineId : os.hostname();
    }

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

        if (apiPort != '') apiUrl += `:${apiPort}`;
        const url = `${apiUrl}/login/apiLogin`;

        const response = await axios({
            url,
            method: 'POST',
            responseType: 'text',
            headers: {
                'Content-Type': 'application/json',
            },
            data: {
                accessKeyId: this.params.accessKeyId,
                accessKeySecret: this.params.accessKeySecret,
            },
        });

        this.params.token = response.data.config1;
        this.params.refreshToken = response.data.config2;
        this._teamId = response.data.config3;
    }

    async RefreshAPIToken() {
        let apiUrl = this.apiUrl;

        const apiPort = this.params.apiPort;

        if (apiPort != '') apiUrl += `:${apiPort}`;
        const url = `${apiUrl}/login/refreshtoken`;

        const response = await axios({
            url,
            method: 'POST',
            responseType: 'text',
            headers: {
                'Content-Type': 'application/json',
                Cookie: `Auth=${this.params.refreshToken};`,
            },
            data: {
                accessKeyId: this.params.accessKeyId,
                accessKeySecret: this.params.accessKeySecret,
            },
        });

        this.params.token = response.data.config1;
        this.params.refreshToken = response.data.config2;
        this._teamId = response.data.config3;
    }

    async RestAPICall(url: string, method: string, options = {}) {
        const mergedOptions = {
            ...{ headers: {}, data: {}, retryWithBackoff: false },
            ...options,
        };
        let fullurl = '';
        try {
            if (!this.params.token) await this.RestAPILogin();
            let apiUrl = this.apiUrl;
            const apiVersion = this.params.agentLogsAPIVersion;

            const apiPort = this.params.apiPort;

            if (apiPort != '') apiUrl += `:${apiPort}`;
            fullurl = `${apiUrl}/api/${apiVersion}/${url}`;

            const combinedHeaders: any = Object.assign(
                {
                    Cookie: `Auth=${this.params.token};`,
                    _teamId: this._teamId,
                },
                mergedOptions.headers
            );

            // console.log('RestAPICall -> url ', url, ', method -> ', method, ', headers -> ', JSON.stringify(combinedHeaders, null, 4), ', data -> ', JSON.stringify(data, null, 4), ', token -> ', this.params.token);
            this.logger.LogDebug(`RestAPICall`, {
                url: fullurl,
                method,
                headers: combinedHeaders,
                data: mergedOptions.data,
            });

            const response = await axios({
                url: fullurl,
                method: method,
                responseType: 'text',
                headers: combinedHeaders,
                data: mergedOptions.data,
            });

            if (_.isArray(response.headers['set-cookie']) && response.headers['set-cookie'].length > 0) {
                const tmp = response.headers['set-cookie'][0].split(';');
                let auth: string = tmp[0];
                auth = auth.substring(5) + ';';
                this.params.token = auth;
            }

            return response.data.data;
        } catch (error) {
            if (
                error.response &&
                error.response.data &&
                error.response.data.errors &&
                _.isArray(error.response.data.errors) &&
                error.response.data.errors.length > 0 &&
                error.response.data.errors[0].description == 'The access token expired'
            ) {
                await this.RefreshAPIToken();
                return this.RestAPICall(url, method, { headers: mergedOptions.headers, data: mergedOptions.data });
            } else {
                let newError: any = { config: error.config };
                if (error.response) {
                    newError = Object.assign(newError, {
                        data: error.response.data,
                        status: error.response.status,
                        headers: error.response.headers,
                    });
                    this.logger.LogError(`RestAPICall error:`, '', newError);
                } else {
                    this.logger.LogError(`RestAPICall error`, '', newError);
                }
                throw new Error(Object.assign(newError, { Error: error.message }));
            }
        }
    }

    async Start() {
        while (true) {
            try {
                console.log('Starting AgentStub');

                if (!fs.existsSync(this.agentPath)) {
                    await this.DownloadAgent();
                    this.logger.LogInfo('Agent downloaded', {});
                }

                await this.RunAgent();
                break;
            } catch (e) {
                if (e.status && e.status == 403) {
                    this.logger.LogError(
                        `Error starting Agent: reached max agents for free tier - upgrade to professional tier to run additional agents`,
                        '',
                        {}
                    );
                } else {
                    const errProperties = {};
                    if (e.code) errProperties['errno'] = e.code;
                    if (e.config && e.config.headers) errProperties['headers'] = e.config.headers;
                    this.logger.LogError(`Error in AgentLauncher.Start`, '', {
                        errProperties,
                        error: e.toString(),
                    });
                }
                await SGUtils.sleep(30000);
            }
        }
    }

    async SpawnAgentProcess(commandString: any, args: string[]) {
        return new Promise((resolve) => {
            try {
                this.logger.LogDebug('AgentLauncher running command', {
                    commandString,
                    args,
                });
                this.agentProc = spawn(commandString, args, {
                    stdio: 'inherit',
                    shell: true,
                });

                // this.agentProc.stdout.on('data', (data) => {
                //     try {
                //         // this.logger.LogError('AgentStub command stdout: ' + data, null, {});
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

                this.agentProc.on('exit', (code) => {
                    try {
                        resolve({ code: code });
                    } catch (e) {
                        this.logger.LogError('Error handling script exit', e.stack, {
                            error: e.toString(),
                        });
                    }
                });
            } catch (e) {
                this.logger.LogError(`Error running command`, e.stack, {
                    error: e.toString(),
                });
            }
        });
    }

    async DownloadAgent_GetUrl(numTries = 0) {
        while (true) {
            try {
                let url = `agentDownload/agent/${this.MachineId()}/${this.params.agentPlatform}`;
                if (this.params.agentArch != '') url += `/${this.params.agentArch}`;

                const agentDownloadUrl = await this.RestAPICall(url, 'GET', { headers: { _teamId: this._teamId } });
                this.logger.LogDebug(`Agent download url`, { url, agentDownloadUrl });
                return agentDownloadUrl;
                break;
            } catch (err) {
                if (err && err.status) {
                    if (err.status == 303) {
                        if (++numTries > waitForAgentCreateMaxRetries) {
                            throw new Error(`Exceeded max tries to get agent download url - restarting: ${err}`);
                        } else {
                            await SGUtils.sleep(waitForAgentCreateInterval);
                        }
                    } else {
                        throw new Error(err);
                    }
                } else {
                    throw new Error(err);
                }
            }
        }
    }

    async DownloadAgent() {
        const agentS3URL: string = <string>await this.DownloadAgent_GetUrl();

        const agentPathUncompressed = this.rootPath + 'sg-agent';
        const agentPathCompressed = agentPathUncompressed + '.gz';
        const writer = fs.createWriteStream(agentPathCompressed);

        const response = await axios({
            url: agentS3URL,
            method: 'GET',
            responseType: 'stream',
        });

        response.data.pipe(writer);

        return new Promise<void>((resolve, reject) => {
            writer.on('finish', async () => {
                await SGUtils.GunzipFile(agentPathCompressed);
                await new Promise<void>((resolve, reject) => {
                    fs.chmod(agentPathUncompressed, 0o0755, (err) => {
                        if (err) {
                            reject(err);
                            return;
                        }
                        resolve();
                        return;
                    });
                });

                if (fs.existsSync(agentPathCompressed)) fs.unlinkSync(agentPathCompressed);

                fs.renameSync(agentPathUncompressed, this.agentPath);

                resolve();
                return;
            });
            writer.on('error', reject);
        });
    }

    async RunAgent() {
        let res;
        try {
            const cmdString = `"${this.agentPath}"`;
            if (fs.existsSync(this.agentPath)) {
                res = await this.SpawnAgentProcess(cmdString, [
                    this.ipcServer.ipcPath,
                    '--LogDest',
                    'console',
                    '--LogLevel',
                    '10',
                    '--TeamId',
                    this._teamId,
                ]);
                let logMsg: string;
                if (res.code == 96) {
                    logMsg = 'Updating and restarting agent';
                    this.logger.LogWarning(logMsg, {});
                    if (fs.existsSync(this.agentPath)) fs.unlinkSync(this.agentPath);
                } else if (res.code == 97) {
                    process.exit();
                } else {
                    logMsg = `Agent stopped (${util.inspect(res, false, null)}) - restarting`;
                    if (res.code != 0) {
                        this.logger.LogError(logMsg, '', {
                            ExitCode: res.code,
                            Result: util.inspect(res, false, null),
                        });
                        if (fs.existsSync(this.agentPath)) fs.unlinkSync(this.agentPath);
                    } else {
                        this.logger.LogInfo(logMsg, {
                            ExitCode: res.code,
                            Result: util.inspect(res, false, null),
                        });
                    }
                }
            }

            setTimeout(() => {
                this.Start();
            }, 5000);
        } catch (e) {
            this.logger.LogError(`Error in AgentLauncher RunAgent'`, e.stack, {
                error: e.toString(),
            });
            throw e;
        }
    }
}
