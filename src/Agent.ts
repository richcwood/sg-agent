const moment = require('moment');
const mtz = require('moment-timezone');
const readline = require('readline');
const spawn = require('child_process').spawn;
const Tail = require('tail').Tail;

import * as es from 'event-stream';
import * as fs from 'fs';
import * as fse from 'fs-extra';
import * as ipc from 'node-ipc';
import * as mongodb from 'mongodb';
import * as os from 'os';
import * as path from 'path';
import * as sysinfo from 'systeminformation';
import * as truncate from 'truncate-utf8-bytes';
import * as util from 'util';
import * as _ from 'lodash';
import * as AsyncLock from 'async-lock';

import axios from 'axios';

import { StepSchema } from './domain/Step';
import { StepOutcomeSchema } from './domain/StepOutcome';
import { TaskSchema } from './domain/Task';
import { TaskOutcomeSchema } from './domain/TaskOutcome';
import { IPCClient, IPCServer } from './shared/Comm';
import {
    LogLevel,
    ScriptType,
    ScriptTypeDetails,
    StepStatus,
    TaskDefTarget,
    TaskFailureCode,
    TaskStatus,
} from './shared/Enums';
import { AgentLogger } from './shared/SGAgentLogger';
import { LambdaUtils } from './shared/LambdaUtils';
import { SGStrings } from './shared/SGStrings';
import { SGUtils } from './shared/SGUtils';
import { StompConnector } from './shared/StompLib';
import { ECONNREFUSED, ECONNRESET } from 'constants';

interface RunStepOutcome {
    status: StepStatus;
    exitCode: number;
    stderr: string;
    failureCode?: TaskFailureCode;
    route?: string;
    signal?: string;
    runtimeVars?;
    stdout?: string;
    lastUpdatedId?: number;
    _teamId?: mongodb.ObjectId;
}

interface SpawnScriptOutcome {
    code: number;
    signal: string;
}

const version = 'v0.0.84';
const SG_AGENT_CONFIG_FILE_NAME = 'sg.cfg';

const regexStdoutRedirectFiles = RegExp('(?<=\\>)(?<!2\\>)(?:\\>| )*([\\w\\.]+)', 'g');

const runningProcesses = {};

const lock = new AsyncLock({ timeout: 5000 });
const lockConnectStomp = 'lock_connect_stomp_key';
const lockApiLogin = 'lock_api_login_key';
const lockRefreshToken = 'lock_refresh_token_key';

export default class Agent {
    private appName: string;
    private userConfigPath: string;
    private machineId: string = undefined;
    private runStandAlone: boolean = undefined;
    private logger: AgentLogger;
    private apiUrl: string;
    private apiPort: string;
    private agentLogsAPIVersion: string;
    private stompUrl: string;
    private rmqAdminUrl: string;
    private rmqUsername: string;
    private rmqPassword: string;
    private rmqVhost: string;
    private stompConsumer: StompConnector;
    private inactiveAgentQueueTTL: number;
    private tags = {};
    private instanceId: mongodb.ObjectId;
    private ipAddress = '';
    private timezone = '';
    private stopped = false;
    private stopping = false;
    private updating = false;
    private numActiveTasks = 0;
    private maxActiveTasks = 10;
    private env: string;
    private logDest: string;
    private trackSysInfo = false;
    private logLevel: LogLevel = LogLevel.WARNING;
    private heartbeatInterval = 30000;
    private token: string;
    private tokenRefreshTime = 0;
    private refreshToken: string;
    private accessKeyId: string;
    private accessKeySecret: string;
    private userConfig: any = {};
    private timeLastActive: number = Date.now();
    private inactivePeriodWaitTime = 0;
    private inactiveAgentJob: any;
    private agentLauncherIPCPath: string;
    private ipcClient = undefined;
    private ipcServer = undefined;
    private handleGeneralTasks = true;
    private maxStdoutSize = 307200; // bytes
    private maxStderrSize = 51200; // bytes
    private numLinesInTail = 5;
    private maxSizeLineInTail = 10240; //bytes
    private sendUpdatesInterval = 10000;
    private queueAPICall: any[] = [];
    private offline = false;
    private mainProcessInterrupted = false;
    private lastStompConnectAttemptTime = 0;
    private stompReconnectMinWaitTime = 10000;
    public _teamId: string;

    private userConfigurableProperties: string[] = [
        'maxActiveTasks',
        'inactivePeriodWaitTime',
        'inactiveAgentJob',
        'handleGeneralTasks',
        'trackSysInfo',
    ];

    InstanceId() {
        return this.instanceId;
    }

    MachineId() {
        return this.machineId ? this.machineId : os.hostname();
    }

    constructor(params: any) {
        this.appName = 'Agent';

        if (process.env.SG_AGENT_CONFIG_PATH)
            this.userConfigPath = path.join(process.env.SG_AGENT_CONFIG_PATH, SG_AGENT_CONFIG_FILE_NAME);
        else this.userConfigPath = SGUtils.getConfigFilePath();

        if (Object.prototype.hasOwnProperty.call(params, 'logLevel')) this.logLevel = parseInt(params['logLevel']);

        this.logDest = 'file';
        if (Object.prototype.hasOwnProperty.call(params, 'logDest')) this.logDest = params['logDest'];

        this._teamId = params._teamId;
        this.env = params.env;
        this.accessKeyId = params.accessKeyId;
        this.accessKeySecret = params.accessKeySecret;
        this.apiUrl = params.apiUrl;
        this.apiPort = params.apiPort;
        this.agentLogsAPIVersion = params.agentLogsAPIVersion;

        if ('machineId' in params) this.machineId = params.machineId;

        if ('runStandAlone' in params) this.runStandAlone = params.runStandAlone;

        if ('maxActiveTasks' in params) this.maxActiveTasks = params.maxActiveTasks;

        if ('inactivePeriodWaitTime' in params) this.inactivePeriodWaitTime = params.inactivePeriodWaitTime;

        if ('inactiveAgentJob' in params) this.inactiveAgentJob = params.inactiveAgentJob;

        if ('handleGeneralTasks' in params) this.handleGeneralTasks = params.handleGeneralTasks;

        if ('trackSysInfo' in params) this.trackSysInfo = params.trackSysInfo;

        if ('tags' in params) this.tags = params.tags;

        this.ipAddress = SGUtils.getIpAddress();
        this.timezone = moment.tz.guess();

        this.userConfig = this.getUserConfigValues();

        if (!this.accessKeyId) {
            if (process.env.SG_ACCESS_KEY_ID) this.accessKeyId = process.env.SG_ACCESS_KEY_ID;
            if (this.userConfig.SG_ACCESS_KEY_ID) this.accessKeyId = this.userConfig.SG_ACCESS_KEY_ID;
        }

        if (!this.accessKeyId) {
            console.log(
                `Error starting the SaasGlue agent - authorization credentials missing. Install authorization credentials in the sg.cfg file or as an environment variable. See saasglue.com for details.`
            );
            process.exit(1);
        }

        if (!this.accessKeySecret) {
            if (process.env.SG_ACCESS_KEY_SECRET) this.accessKeySecret = process.env.SG_ACCESS_KEY_SECRET;
            if (this.userConfig.SG_ACCESS_KEY_SECRET) this.accessKeySecret = this.userConfig.SG_ACCESS_KEY_SECRET;
        }

        if (!this.accessKeySecret) {
            console.log(
                `Error starting the SaasGlue agent - authorization credentials missing. Install authorization credentials in the sg.cfg file or as an environment variable. See saasglue.com for details.`
            );
            process.exit(1);
        }

        if (this.tags && Object.keys(this.tags).length < 1) {
            if (process.env.SG_TAGS) this.tags = SGUtils.TagsStringToMap(process.env.SG_TAGS);
        }

        if (this.env != 'unittest') {
            if ('tags' in this.userConfig) this.tags = this.userConfig['tags'];
            if ('propertyOverrides' in this.userConfig)
                this.UpdatePropertyOverrides(this.userConfig['propertyOverrides'], 'local');
            if (this.env == 'debug') {
                if ('debug' in this.userConfig) this.UpdatePropertyOverrides(this.userConfig['debug'], 'debug');
            }
        }

        this.agentLauncherIPCPath = process.argv[2];
    }

    async CreateAgentInAPI() {
        let agentProperties: any = {};
        const agent_info = {
            id: this.InstanceId(),
            _teamId: this._teamId,
            machineId: this.MachineId(),
            ipAddress: SGUtils.getIpAddress(),
            name: this.MachineId(),
            reportedVersion: version,
            targetVersion: version,
            tags: this.tags,
            numActiveTasks: 0,
            offline: this.offline,
            lastHeartbeatTime: new Date().getTime(),
            propertyOverrides: {
                trackSysInfo: false,
                maxActiveTasks: this.maxActiveTasks,
                handleGeneralTasks: this.handleGeneralTasks,
            },
            sysInfo: await this.GetSysInfo(),
        };

        agentProperties = await this.RestAPICall(`agent`, 'POST', {
            data: agent_info,
            retryWithBackoff: true,
        });

        this.instanceId = new mongodb.ObjectId(agentProperties.id);

        return agentProperties;
    }

    async Init() {
        if (!this._teamId) await this.RestAPILogin();

        this.logger = new AgentLogger(
            this,
            this.logLevel,
            process.cwd() + '/logs',
            this.apiUrl,
            this.apiPort,
            this.agentLogsAPIVersion
        );
        this.logger.Start();

        this.ipcServer = new IPCServer(
            'SGAgentProc',
            SGUtils.makeid(10),
            `sg-agent-launcher-msg-${this._teamId}`,
            async (message) => {
                const logMsg = 'Message from AgentLauncher';
                this.logger.LogDebug(logMsg, message);
                if (message.signal) {
                    await this.SignalHandler();
                }
            }
        );

        this.logger.LogDebug(`Starting Agent`, {
            tags: this.tags,
            propertyOverrides: this.UpdatePropertyOverrides,
            userConfigPath: this.userConfigPath,
            env: this.env,
        });

        await this.SetAgentProperties();
        process.on('SIGINT', this.SignalHandler.bind(this));
        process.on('SIGTERM', this.SignalHandler.bind(this));
        await this.SendHeartbeat(true, false);
        await this.ConnectStomp();
        if (!this.runStandAlone) this.ConnectToAgentLauncher();
        this.timeLastActive = Date.now();
        this.CheckInactiveTime();
        this.SendMessageToAPIAsync();
    }

    async SetAgentProperties() {
        let agentProperties: any = {};
        try {
            agentProperties = await this.RestAPICall(`agent/machineid/${this.MachineId()}`, 'GET', {
                headers: { _teamId: this._teamId },
            });
            this.instanceId = new mongodb.ObjectId(agentProperties.id);
        } catch (e) {
            if (e.response && e.response.status == 404) {
                agentProperties = await this.CreateAgentInAPI();
            } else {
                this.logger.LogError(`Error getting agent properties`, e.stack, SGUtils.errorToObj(e));
                throw e;
            }
        }
        this.logger.instanceId = this.instanceId.toHexString();
        this.inactiveAgentQueueTTL = agentProperties.inactiveAgentQueueTTL;
        this.stompUrl = agentProperties.stompUrl;
        this.rmqAdminUrl = agentProperties.rmqAdminUrl;
        this.rmqUsername = agentProperties.rmqUsername;
        this.rmqPassword = agentProperties.rmqPassword;
        this.rmqVhost = agentProperties.rmqVhost;

        if (!this.areObjectsEqual(this.tags, agentProperties.tags)) {
            if (this.tags) {
                try {
                    await this.RestAPICall(`agent/tags/${this.instanceId.toHexString()}`, 'PUT', {
                        data: { tags: this.tags },
                    });
                } catch (e) {
                    this.logger.LogError(`Error updating agent tags`, e.stack, SGUtils.errorToObj(e));
                }
            } else {
                this.tags = agentProperties.tags;
            }
        }

        if (agentProperties.propertyOverrides && this.userConfig.propertyOverrides) {
            if (!this.areObjectsEqual(this.userConfig.propertyOverrides, agentProperties.propertyOverrides)) {
                for (let i = 0; i < Object.keys(agentProperties.propertyOverrides).length; i++) {
                    const key = Object.keys(agentProperties.propertyOverrides)[i];
                    if (!(key in this.userConfig.propertyOverrides))
                        this.userConfig.propertyOverrides[key] = agentProperties.propertyOverrides[key];
                }
                this.queueAPICall.push({
                    url: `agent/properties/${this.instanceId.toHexString()}`,
                    method: 'PUT',
                    headers: null,
                    data: this.userConfig.propertyOverrides,
                });

                // await this.UpdatePropertyOverridesAPI(this.userConfig.propertyOverrides)
            }
        }

        if (this.env == 'debug') {
            if ('debug' in this.userConfig) {
                if ('stompUrl' in this.userConfig.debug) this.stompUrl = this.userConfig.debug.stompUrl;
                if ('rmqAdminUrl' in this.userConfig.debug) this.rmqAdminUrl = this.userConfig.debug.rmqAdminUrl;
            }
        }
    }

    async ConnectToAgentLauncher() {
        try {
            this.ipcClient = new IPCClient(
                'SGAgentLauncherProc',
                `sg-agent-proc-${this._teamId}`,
                this.agentLauncherIPCPath,
                () => {
                    this.LogError('Error connecting to agent launcher - retrying', '', {});
                },
                () => {
                    if (!this.stopped) this.LogError(`Failed to connect to agent launcher`, '', {});
                },
                async () => {
                    if (this.stopped) return;
                    this.LogError(`Disconnected from agent launcher - attempting to reconnect in 10 seconds`, '', {});
                    for (let i = 0; i < 10; i++) {
                        if (this.stopped) break;
                        await SGUtils.sleep(1000);
                    }
                    setTimeout(async () => {
                        try {
                            if (!this.stopped) await this.ipcClient.ConnectIPC();
                        } catch (e) {
                            this.LogError(`Error connecting to agent launcher - restarting`, '', e);
                            try {
                                this.RunAgentStub();
                            } catch (e) {
                                this.LogError('Error starting agent launcher', '', SGUtils.errorToObj(e));
                            }
                        }
                    }, 1000);
                }
            );
            await this.ipcClient.ConnectIPC();
            await this.SendMessageToAgentStub({
                propertyOverrides: {
                    instanceId: this.instanceId,
                    apiUrl: this.apiUrl,
                    apiPort: this.apiPort,
                    agentLogsAPIVersion: this.agentLogsAPIVersion,
                },
                agentIPCServerPath: this.ipcServer.ipcPath,
            });
        } catch (e) {
            this.LogError(`Error connecting to agent launcher - restarting`, '', e);
            try {
                this.RunAgentStub();
            } catch (e) {
                // Ignore error and continue
            }
        }
    }

    async SignalHandler() {
        this.mainProcessInterrupted = true;

        await this.Stop();

        this.offline = true;
        await this.SendDisconnectMessage();

        for (let i = 0; i < Object.keys(runningProcesses).length; i++) {
            const proc = runningProcesses[Object.keys(runningProcesses)[i]];
            if (proc && typeof proc == 'object' && proc.pid) {
                proc.kill();
                // delete runningProcesses[Object.keys(runningProcesses)[i]];
            }
        }

        const maxSleepCount = 10;
        let sleepCount = 0;
        while (Object.keys(runningProcesses).length > 0) {
            await SGUtils.sleep(500);
            sleepCount += 1;
            if (sleepCount >= maxSleepCount) break;
        }

        while (this.queueAPICall && this.queueAPICall.length > 0) {
            await SGUtils.sleep(500);
            sleepCount += 1;
            if (sleepCount >= maxSleepCount) break;
        }

        await SGUtils.sleep(1000);

        process.exit(97);
    }

    async GetArtifact(artifactId: string, destPath: string) {
        const artifactPrefix = '';
        const artifactName = '';
        try {
            const artifact = await this.RestAPICall(`artifact/${artifactId}`, 'GET');
            const artifactPath = `${destPath}/${artifact.name}`;
            const writer = fs.createWriteStream(artifactPath);

            // console.log('GetArtifact -> url ', url, ', headers -> ', this._teamId, ', token -> ', this.token);

            const response = await axios({
                url: artifact.url,
                method: 'GET',
                responseType: 'stream',
            });

            const artifactSize = await new Promise((resolve) => {
                response.data.pipe(writer).on('finish', () => {
                    const artifactSize: number = fs.statSync(artifactPath).size;
                    resolve(artifactSize);
                });
            });

            if (SGUtils.GetFileExt(artifact.name) == '.gz') {
                await SGUtils.GunzipFile(artifactPath);
            }
            return { success: true, artifactSize };
        } catch (e) {
            return {
                success: false,
                error: SGUtils.errorToObj(e),
                artifactPrefix,
                artifactName,
            };
        }
    }

    async RestAPILogin(retryCount = 0) {
        return new Promise<void>((resolve, reject) => {
            // console.log('Waiting to aquire lockRefreshToken');
            lock.acquire(
                lockApiLogin,
                async () => {
                    try {
                        if (new Date().getTime() - this.tokenRefreshTime < 30000 && this.token) return;
                        this.token = '';
                        let apiUrl = this.apiUrl;
                        const apiPort = this.apiPort;
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
                                accessKeyId: this.accessKeyId,
                                accessKeySecret: this.accessKeySecret,
                            },
                        });
                        this.tokenRefreshTime = new Date().getTime();
                        this.token = response.data.config1;
                        this.refreshToken = response.data.config2;
                        this._teamId = response.data.config3;
                    } catch (e) {
                        if (e.response && e.response.status && e.response.status == 401) {
                            console.log(`Invalid authorization credentials - exiting.`);
                            process.exit(1);
                        }
                    }
                },
                (err) => {
                    if (err) {
                        retryCount += 1;
                        if (retryCount > 5) {
                            this.LogError('Error acquiring api login lock in RestAPILogin', err.stack, {
                                error: err.toString(),
                            });
                            reject();
                        } else {
                            setTimeout(() => {
                                this.RestAPILogin(retryCount);
                            }, 1000);
                        }
                    } else {
                        resolve();
                    }
                },
                {}
            );
        });
    }

    async RefreshAPIToken(retryCount = 0) {
        return new Promise<void>((resolve, reject) => {
            // console.log('Waiting to aquire lockRefreshToken');
            lock.acquire(
                lockRefreshToken,
                async () => {
                    try {
                        if (new Date().getTime() - this.tokenRefreshTime < 30000 && this.token) return;
                        this.token = '';
                        let apiUrl = this.apiUrl;
                        const apiPort = this.apiPort;
                        if (apiPort != '') apiUrl += `:${apiPort}`;
                        const url = `${apiUrl}/login/refreshtoken`;
                        const response = await axios({
                            url,
                            method: 'POST',
                            responseType: 'text',
                            headers: {
                                'Content-Type': 'application/json',
                                Cookie: `Auth=${this.refreshToken};`,
                            },
                        });
                        this.tokenRefreshTime = new Date().getTime();
                        this.token = response.data.config1;
                        this.refreshToken = response.data.config2;
                    } catch (err) {
                        if (err.response && err.response.status && err.response.status == 401) {
                            setImmediate(() => {
                                this.RestAPILogin(retryCount);
                            });
                        }
                    }
                },
                (err) => {
                    if (err) {
                        retryCount += 1;
                        if (retryCount > 5) {
                            this.LogError('Error acquiring api login lock in RefreshAPIToken', err.stack, {
                                error: err.toString(),
                            });
                            reject();
                        } else {
                            setTimeout(() => {
                                this.RefreshAPIToken(retryCount);
                            }, 1000);
                        }
                    } else {
                        resolve();
                    }
                },
                {}
            );
        });
    }

    async RestAPICall(url: string, method: string, options = {}) {
        const mergedOptions = {
            ...{ headers: {}, data: {}, retryWithBackoff: false },
            ...options,
        };
        const waitTimesBackoff = [1000, 5000, 10000, 20000, 30000, 60000];
        while (true) {
            let fullurl = '';
            try {
                if (!this.token) await this.RestAPILogin();
                let apiUrl = this.apiUrl;
                const apiVersion = this.agentLogsAPIVersion;
                const apiPort = this.apiPort;
                if (apiPort != '') apiUrl += `:${apiPort}`;
                fullurl = `${apiUrl}/api/${apiVersion}/${url}`;
                const combinedHeaders = Object.assign(
                    {
                        Cookie: `Auth=${this.token};`,
                        _teamId: this._teamId,
                    },
                    mergedOptions.headers
                );

                // this.logger.LogDebug(`RestAPICall`, {
                //     fullurl,
                //     method,
                //     combinedHeaders,
                //     data: mergedOptions.data,
                //     token: this.token,
                // });
                // console.log(
                //     'Agent RestAPICall -> url ',
                //     fullurl,
                //     ', method -> ',
                //     method,
                //     ', headers -> ',
                //     JSON.stringify(combinedHeaders, null, 4),
                //     ', data -> ',
                //     JSON.stringify(mergedOptions.data, null, 4),
                //     ', token -> ',
                //     this.token
                // );

                const response = await axios({
                    url: fullurl,
                    method: method,
                    responseType: 'text',
                    headers: combinedHeaders,
                    data: mergedOptions.data,
                });
                return response.data.data;
            } catch (e) {
                if (e.response && e.response.status == 404) {
                    await this.CreateAgentInAPI();
                } else if (
                    e.response &&
                    e.response.data &&
                    e.response.data.errors &&
                    _.isArray(e.response.data.errors) &&
                    e.response.data.errors.length > 0 &&
                    e.response.data.errors[0].description == 'The access token expired'
                ) {
                    await this.RefreshAPIToken();
                    return this.RestAPICall(url, method, {
                        headers: mergedOptions.headers,
                        data: mergedOptions.data,
                        retryWithBackoff: mergedOptions.retryWithBackoff,
                    });
                } else {
                    const errno = e.errno || null;
                    const code = e.code || null;
                    const errorContext = Object.assign(
                        {
                            http_method: method,
                            url: fullurl,
                            data: mergedOptions.data,
                            errno: errno,
                            code: code,
                        },
                        e.cause
                    );
                    const status = e.response && e.response.status;
                    if (code == 'ECONNREFUSED' || code == 'ECONNRESET' || (mergedOptions.retryWithBackoff && !status)) {
                        const waitTime = waitTimesBackoff.shift() || 60000;
                        this.LogError(
                            `Error sending message to API - retrying`,
                            e.stack,
                            Object.assign({ retry_wait_time: waitTime }, errorContext)
                        );
                        await SGUtils.sleep(waitTime);
                    } else {
                        // this.logger.LogError(`Error sending message to API`, e.stack, errorContext);
                        throw errorContext;
                    }
                }
            }
        }
    }

    getUserConfigValues = () => {
        let userConfig = {};
        try {
            if (this.env != 'unittest' && fs.existsSync(this.userConfigPath)) {
                userConfig = JSON.parse(fs.readFileSync(this.userConfigPath).toString());
            }
        } catch (e) {
            console.log(`Error getting user config values: ${e}`);
        }

        return userConfig;
    };

    updateUserConfigValues = (values: any) => {
        const userConfig: any = this.getUserConfigValues();
        if (values.propertyOverrides) {
            if (!userConfig.propertyOverrides) userConfig.propertyOverrides = {};
            for (let i = 0; i < Object.keys(values.propertyOverrides).length; i++) {
                const key = Object.keys(values.propertyOverrides)[i];
                if (values.propertyOverrides[key] == null) {
                    delete userConfig.propertyOverrides[key];
                } else {
                    userConfig.propertyOverrides[key] = values.propertyOverrides[key];
                    if (key == 'inactiveAgentJob') this.inactiveAgentJob = userConfig.propertyOverrides[key];
                }
            }
        }
        if (values.tags) {
            userConfig.tags = values.tags;
        }
        if (this.env != 'unittest') fs.writeFileSync(this.userConfigPath, JSON.stringify(userConfig, null, 4));
    };

    areTagArraysEqual = (first: any[], second: any[]) => {
        let areEqual = true;
        if (first || second) {
            if (first && !second) {
                areEqual = false;
            } else if (second && !first) {
                areEqual = false;
            } else if (second.length != first.length) {
                areEqual = false;
            } else {
                for (let i = 0; i < first.length; i++) {
                    let foundTagMatch = false;
                    const key = Object.keys(first[i])[0];
                    for (let j = 0; j < second.length; j++) {
                        if (key in second[j] && first[i][key] == second[j][key]) {
                            foundTagMatch = true;
                            break;
                        }
                    }
                    if (!foundTagMatch) {
                        areEqual = false;
                        break;
                    }
                }
            }
        }
        return areEqual;
    };

    areObjectsEqual = (first: any, second: any) => {
        let areEqual = true;

        if (first || second) {
            if (first && !second) {
                areEqual = false;
            } else if (second && !first) {
                areEqual = false;
            } else if (Object.keys(second).length != Object.keys(first).length) {
                areEqual = false;
            } else {
                for (let i = 0; i < Object.keys(first).length; i++) {
                    const key = Object.keys(first)[i];
                    if (!(key in second)) {
                        areEqual = false;
                        break;
                    } else if (first[key] != second[key]) {
                        areEqual = false;
                        break;
                    }
                }
            }
        }

        return areEqual;
    };

    async StopConsuming() {
        this.stopped = true;
        // for (let i = 0; i < this.tags.length; i++)
        //     await this.DisconnectTagQueues(this.tags[0]);
        await this.stompConsumer.StopConsuming();
    }

    async Stop() {
        this.logger.Stop();
        await this.StopConsuming();
        await this.stompConsumer.Stop();
        ipc.disconnect('SGAgentLauncherProc');
    }

    LogError = async (msg: string, stack: string, values: any) => {
        if (this.logger) await this.logger.LogError(msg, stack, values);
        else console.log(msg, stack, util.inspect(values, false, null));
    };

    LogWarning = async (msg: string, values: any) => {
        if (this.logger) await this.logger.LogWarning(msg, values);
        else console.log(msg, util.inspect(values, false, null));
    };

    LogInfo = async (msg: string, values: any) => {
        if (this.logger) await this.logger.LogInfo(msg, values);
        else console.log(msg, util.inspect(values, false, null));
    };

    LogDebug = async (msg: string, values: any) => {
        if (this.logger) await this.logger.LogDebug(msg, values);
        else console.log(msg, util.inspect(values, false, null));
    };

    async SendMessageToAgentStub(params) {
        if (!this.runStandAlone) {
            this.LogDebug(`Sending message to agent launcher`, params);
            await ipc.of.SGAgentLauncherProc.emit(`sg-agent-msg-${this._teamId}`, params);
        }
    }

    async SendDisconnectMessage() {
        try {
            const heartbeat_info = {
                machineId: this.MachineId(),
                ipAddress: SGUtils.getIpAddress(),
                offline: this.offline,
            };

            await this.RestAPICall(`agent/heartbeat/${this.instanceId}`, 'PUT', {
                data: heartbeat_info,
            });
        } catch (e) {
            this.LogError(`Error sending disconnect message`, e.stack, SGUtils.errorToObj(e));
        }
    }

    async RemoveFolder(path: string, retryCount: number) {
        try {
            if (fs.existsSync(path)) {
                fse.removeSync(path);
            }
        } catch (err) {
            retryCount += 1;
            if (retryCount > 10) {
                this.LogWarning(`Error removing folder`, {
                    path,
                    error: err.toString(),
                });
            } else {
                setTimeout(() => {
                    this.RemoveFolder(path, retryCount);
                }, 1000);
            }
        }
    }

    async SendHeartbeat(forceGetSysInfo = false, once = false) {
        try {
            if (this.stopped) return;

            const heartbeat_info: any = {
                machineId: this.MachineId(),
                ipAddress: SGUtils.getIpAddress(),
                reportedVersion: version,
                lastHeartbeatTime: new Date().getTime(),
                numActiveTasks: this.numActiveTasks,
                timezone: this.timezone,
                offline: this.offline,
            };
            // console.log(`SendHeartbeat -> ${JSON.stringify(heartbeat_info)}`);
            if (this.trackSysInfo || forceGetSysInfo) {
                const sysInfo = await this.GetSysInfo();
                heartbeat_info['sysInfo'] = sysInfo;
            }

            let cron: any;
            if (process.platform.indexOf('darwin') >= 0 || process.platform.indexOf('linux') >= 0) {
                cron = await this.GetCronTab();
                if (cron && cron.stdout) {
                    heartbeat_info.cron = cron.stdout;
                }
            }

            try {
                const ret = await this.RestAPICall(`agent/heartbeat/${this.instanceId}`, 'PUT', {
                    data: heartbeat_info,
                });

                if (ret.tasksToCancel) {
                    this.LogDebug('Received tasks to cancel from heartbeat', {
                        tasksToCancel: JSON.stringify(ret.tasksToCancel, null, 4),
                    });
                    for (let i = 0; i < ret.tasksToCancel.length; i++) {
                        const taskToCancel = ret.tasksToCancel[i];
                        const procToCancel = runningProcesses[taskToCancel];
                        if (procToCancel && typeof procToCancel == 'object' && procToCancel.pid) {
                            procToCancel.kill();
                        }
                    }
                }
            } catch (err) {
                if (err.response && err.response.status == 404) {
                    await this.CreateAgentInAPI();
                } else {
                    throw err;
                }
            }

            if (!this.stopped && !once)
                setTimeout(() => {
                    this.SendHeartbeat();
                }, this.heartbeatInterval);
        } catch (e) {
            if (!this.stopped) {
                delete e.request;
                this.LogError(`Error sending heartbeat`, '', SGUtils.errorToObj(e));
                if (!once)
                    setTimeout(() => {
                        this.SendHeartbeat();
                    }, this.heartbeatInterval);
            }
        }
    }

    async CheckInactiveTime() {
        try {
            if (this.numActiveTasks > 0) {
                this.timeLastActive = Date.now();
            } else if (Date.now() - this.timeLastActive > this.inactivePeriodWaitTime) {
                this.timeLastActive = Date.now();

                if (this.inactiveAgentJob && this.inactiveAgentJob.id) {
                    try {
                        this.LogDebug('Running inactive agent job', {
                            inactiveAgentJob: this.inactiveAgentJob,
                        });
                        const runtimeVars: any = {};
                        if (this.inactiveAgentJob.runtimeVars)
                            Object.assign(runtimeVars, this.inactiveAgentJob.runtimeVars);
                        runtimeVars._agentId = {};
                        runtimeVars._agentId['value'] = this.InstanceId();
                        const data = {
                            name: `Inactive agent job - ${this.MachineId()}`,
                            runtimeVars,
                            createdBy: this.MachineId(),
                        };
                        this.queueAPICall.push({
                            url: `job`,
                            method: 'POST',
                            headers: { _jobDefId: this.inactiveAgentJob.id },
                            data,
                        });
                    } catch (e) {
                        this.LogError('Error running inactive agent job', e.stack, {
                            inactiveAgentJob: this.inactiveAgentJob,
                            error: e.toString(),
                        });
                    }
                }
            }
            if (!this.stopped) {
                setTimeout(() => {
                    this.CheckInactiveTime();
                }, 1000);
            }
        } catch (e) {
            if (!this.stopped) throw e;
        }
    }

    async SendMessageToAPIAsync() {
        // this.LogDebug('Checking message queue', {});
        let waitTimesBackoff = [1000, 5000, 10000, 20000, 30000, 60000];
        while (this.queueAPICall.length > 0) {
            const msg = this.queueAPICall.shift();
            try {
                // this.LogDebug('Sending queued message', { 'request': msg });
                await this.RestAPICall(msg.url, msg.method, {
                    headers: msg.headers,
                    data: msg.data,
                });
                waitTimesBackoff = [1000, 5000, 10000, 20000, 30000, 60000];
                // this.queueAPICall.shift();
                // this.LogDebug('Sent queued message', { 'request': msg });
            } catch (e) {
                if (!this.stopped) {
                    if (e.response && e.response.data && e.response.data.statusCode) {
                        this.LogError(
                            `Error sending message to API`,
                            e.stack,
                            Object.assign(
                                {
                                    method: 'SendMessageToAPIAsync',
                                    request: msg,
                                },
                                SGUtils.errorToObj(e)
                            )
                        );
                        // this.queueAPICall.shift();
                    } else {
                        const waitTime = waitTimesBackoff.shift() || 60000;
                        this.LogError(
                            `Error sending message to API - retrying`,
                            e.stack,
                            Object.assign(
                                {
                                    method: 'SendMessageToAPIAsync',
                                    request: msg,
                                    retry_wait_time: waitTime,
                                },
                                SGUtils.errorToObj(e)
                            )
                        );
                        this.queueAPICall.unshift(msg);
                        await SGUtils.sleep(waitTime);
                    }
                } else {
                    break;
                }
            }
        }
        setTimeout(() => {
            this.SendMessageToAPIAsync();
        }, 1000);
    }

    ExtractRuntimeVarsFromString(line: string) {
        function fnRtVar(k, v) {
            const rtVar = {};
            if (k.startsWith('<<') && k.endsWith('>>')) {
                k = k.substring(2, k.length - 2);
                rtVar[k] = { sensitive: true };
            } else if (k != 'route') {
                rtVar[k] = { sensitive: false };
            } else {
                rtVar[k] = {};
            }
            rtVar[k]['value'] = v;

            return rtVar;
        }

        let runtimeVars = {};
        const arrParams: string[] = line.match(/@sgo(\{[^}]*\})/gi);
        if (arrParams) {
            for (let i = 0; i < arrParams.length; i++) {
                let rtVar;
                let rawValue;
                try {
                    const newValJson = arrParams[i].substring(4);
                    const newVal = JSON.parse(newValJson);
                    const [key, value] = Object.entries(newVal)[0];
                    rawValue = value;
                    rtVar = fnRtVar(key, value);
                    runtimeVars = Object.assign(runtimeVars, rtVar);
                } catch (e) {
                    try {
                        if (e.message.indexOf('Unexpected token \\') >= 0) {
                            const newValJson = arrParams[i].substring(4).replace(/\\+"/g, '"');
                            const newVal = JSON.parse(newValJson);
                            const [key, value] = Object.entries(newVal)[0];
                            rawValue = value;
                            rtVar = fnRtVar(key, value);
                            runtimeVars = Object.assign(runtimeVars, rtVar);
                        } else {
                            const re = /{['"]?([\w-]+)['"]?:[ '"]+([^,'"]+)['"]}/g;
                            const s = arrParams[i].substring(4);
                            let m;
                            while ((m = re.exec(s)) != null) {
                                const key = m[1].trim();
                                const val = m[2].trim();
                                rawValue = val;
                                rtVar = fnRtVar(key, val);
                                runtimeVars = Object.assign(runtimeVars, rtVar);
                            }
                        }
                    } catch (se) {
                        // Ignore error and continue
                    }
                }

                const [key, value] = Object.entries(rtVar)[0];
                if (value['sensitive']) {
                    const newVal = arrParams[i].replace(rawValue, `**${key}**`);
                    line = line.replace(arrParams[i], newVal);
                }
            }
        }

        return { runtimeVars, line };
    }

    ReplaceSensitiveRuntimeVarValuesInString(line: string, rtVars: any) {
        let newLine: string = line;
        const keys = Object.keys(rtVars);
        for (let i = 0; i < keys.length; ++i) {
            const k = keys[i];
            const v = rtVars[k];
            if (v['sensitive']) {
                newLine = newLine.replace(RegExp(v['value'], 'g'), `**${k}**`);
            }
        }

        return newLine;
    }

    ParseScriptStdout = async (
        filePath: string,
        task: any,
        saveOutput: boolean,
        stdoutBytesAlreadyProcessed = 0,
        stdoutTruncated = false
    ) => {
        let lineCount = 0;
        let bytesRead = 0;
        let output = '';
        const runtimeVars = {};
        const lastNLines: string[] = [];
        try {
            const fileStream = fs.createReadStream(filePath);
            const rl = readline.createInterface({ input: fileStream, crlfDelay: Infinity });
            for await (const line of rl) {
                lineCount += 1;
                const extractRes = this.ExtractRuntimeVarsFromString(line);
                const rtv = extractRes.runtimeVars;
                let newLine: string = extractRes.line;
                Object.assign(runtimeVars, rtv);
                if (saveOutput && newLine) {
                    newLine = this.ReplaceSensitiveRuntimeVarValuesInString(newLine, task.runtimeVars);
                    const strLenBytes = Buffer.byteLength(newLine, 'utf8');
                    bytesRead += strLenBytes;
                    if (bytesRead > stdoutBytesAlreadyProcessed) {
                        if (!stdoutTruncated) {
                            if (strLenBytes + stdoutBytesAlreadyProcessed < this.maxStdoutSize) {
                                output += `${newLine}\n`;
                                stdoutBytesAlreadyProcessed += strLenBytes;
                            } else {
                                output = truncate(output, this.maxStdoutSize) + '\n(truncated)\n';
                                stdoutTruncated = true;
                            }
                        }
                        let lineForTail = newLine;
                        if (strLenBytes > this.maxSizeLineInTail)
                            lineForTail = truncate(newLine, this.maxSizeLineInTail) + ' (truncated)';
                        lastNLines.push(lineForTail);
                        if (lastNLines.length > this.numLinesInTail) lastNLines.shift();
                    }
                }
            }
            if (stdoutTruncated) output += '\n' + lastNLines.join('\n');
            return {
                output: output,
                runtimeVars: runtimeVars,
                lastNLines: lastNLines,
            };
        } catch (err) {
            throw new Error(`Error reading stdout file '${filePath}' on line ${lineCount}: ${err}`);
        }
    };

    ParseScriptStderr = async (filePath: string, task: any) => {
        let lineCount = 0;
        let output = '';
        try {
            const fileStream = fs.createReadStream(filePath);
            const rl = readline.createInterface({ input: fileStream, crlfDelay: Infinity });
            for await (let line of rl) {
                lineCount += 1;
                if (line) {
                    line = this.ReplaceSensitiveRuntimeVarValuesInString(line, task.runtimeVars);
                    if (Buffer.byteLength(output, 'utf8') < this.maxStderrSize) {
                        output += `${line}\n`;
                        if (Buffer.byteLength(output, 'utf8') > this.maxStderrSize) {
                            output = truncate(output, this.maxStderrSize) + ' (truncated)';
                            break;
                        }
                    }
                }
            }
            return { output: output };
        } catch (err) {
            throw new Error(`Error reading stderr file '${filePath}' on line ${lineCount}: ${err}`);
        }
    };

    GetSysInfo = async () => {
        const sysInfo = {};
        const procs = await sysinfo.processes();
        procs.list = procs.list
            .sort((a, b) => {
                return b.pcpu - a.pcpu;
            })
            .slice(0, 10);
        const osInfo = await sysinfo.osInfo();
        const cpuCurrentspeed = await sysinfo.cpuCurrentspeed();
        const cpuTemperature = await sysinfo.cpuTemperature();
        const currentLoad = await sysinfo.currentLoad();
        const fsSize = await sysinfo.fsSize();
        // let networkConnections = await sysinfo.networkConnections();
        // let users = await sysinfo.users();
        const mem = await sysinfo.mem();
        // let battery = await sysinfo.battery();
        const inetLatency = await sysinfo.inetLatency();
        const networkStats = await sysinfo.networkStats();

        let fsStats = null;
        let disksIO = null;
        if (process.platform.indexOf('darwin') >= 0 || process.platform.indexOf('linux') >= 0) {
            fsStats = await sysinfo.fsStats();
            disksIO = await sysinfo.disksIO();
        }

        Object.assign(
            sysInfo,
            { osInfo: osInfo },
            { time: sysinfo.time() },
            { cpuCurrentspeed: cpuCurrentspeed },
            { cpuTemperature: cpuTemperature },
            { currentLoad: currentLoad },
            { mem: mem },
            { fsSize: fsSize },
            { inetLatency: inetLatency },
            { networkStats: networkStats },
            { processes: procs }
            // { networkConnections: networkConnections },
            // { users: users },
            // { battery: battery }
        );

        if (fsStats) Object.assign(sysInfo, { fsStats: fsStats });
        if (disksIO) Object.assign(sysInfo, { disksIO: disksIO });

        return sysInfo;
    };

    CreateAWSLambdaArtifact = async (
        step: StepSchema,
        task: TaskSchema,
        stepOutcomeId: mongodb.ObjectId,
        lastNLines: string[],
        stateVars: any,
        workingDirectory: string
    ): Promise<any> => {
        let handler = '';
        let lambdaCode: any = {};
        if (!step.lambdaZipfile) {
            const msg = `${new Date().toISOString()} Creating AWS Lambda function\n`;
            lastNLines.push(msg);
            const updates = {
                _teamId: step._teamId,
                tail: lastNLines,
                stdout: msg,
                status: StepStatus.RUNNING,
                lastUpdateId: stateVars.updateId,
            };
            await this.RestAPICall(`stepOutcome/${stepOutcomeId}`, 'PUT', { data: updates });
            stateVars.updateId += 1;

            const createAWSLambdaZipFileResult = await LambdaUtils.CreateAWSLambdaZipFile(
                step,
                task,
                stateVars,
                workingDirectory,
                this.LogError
            );
            lambdaCode = createAWSLambdaZipFileResult.lambdaCode;
            handler = createAWSLambdaZipFileResult.handler;
            createAWSLambdaZipFileResult.lambdaFileLoadedToSGAWS;
        } else {
            const artifact = await this.RestAPICall(`artifact/${step.lambdaZipfile}`, 'GET', {
                data: { _teamId: step._teamId },
            });
            lambdaCode.S3Bucket = step.s3Bucket;

            let s3Path = '';
            if (this.env != 'production') {
                if (this.env == 'unittest') s3Path += `debug/`;
                else s3Path += `${this.env}/`;
            }
            s3Path += `${step._teamId}/`;

            if (artifact.prefix) s3Path += `${artifact.prefix}`;
            s3Path += artifact.name;

            lambdaCode.S3Key = s3Path;
            handler = step.lambdaFunctionHandler;
        }
        return { handler, lambdaCode };
    };

    RunStepAsync_Lambda = async (
        step: StepSchema,
        task: TaskSchema,
        stepOutcomeId: mongodb.ObjectId,
        lastUpdatedId: number,
        taskOutcomeId: mongodb.ObjectId,
        workingDirectory: string
    ) => {
        let error = '';
        try {
            const stdoutFilePath = workingDirectory + path.sep + SGUtils.makeid(10) + '.out';
            const fileOut = fs.openSync(stdoutFilePath, 'w');
            const stateVars = {
                updateId: lastUpdatedId + 1,
                procFinished: false,
                stdoutAnalysisFinished: false,
                stdoutBytesProcessed: 0,
                stdoutTruncated: false,
                zipFilePath: '',
                runLambdaFinished: false,
            };
            const lastNLines: string[] = [];
            const rtvCumulative = {};
            const queueTail: any[] = [];
            const _teamId: string = step._teamId;
            let handler = '';
            let lambdaCode: any = {};
            let lambdaDuration: string = undefined;
            let lambdaBilledDuration: string = undefined;
            let lambdaMemSize: string = undefined;
            let lambdaMaxMemUsed: string = undefined;
            let lambdaInitDuration: string = undefined;
            const createLambdaRes = await this.CreateAWSLambdaArtifact(
                step,
                task,
                stepOutcomeId,
                lastNLines,
                stateVars,
                workingDirectory
            );
            handler = createLambdaRes.handler;
            lambdaCode = createLambdaRes.lambdaCode;
            await LambdaUtils.CreateAWSLambda(
                task._teamId,
                task._jobId,
                task.id,
                step.id,
                step.lambdaRole,
                task.id,
                lambdaCode,
                step.lambdaRuntime,
                step.lambdaMemorySize,
                step.lambdaTimeout,
                step.lambdaAWSRegion,
                handler
            );
            if (stateVars.zipFilePath) {
                try {
                    if (fs.existsSync(stateVars.zipFilePath)) fs.unlinkSync(stateVars.zipFilePath);
                } catch (e) {
                    // continue regardless of error
                }
            }
            const msg = `${new Date().toISOString()} Running AWS Lambda function\n`;
            lastNLines.push(msg);
            const updates = {
                _teamId: _teamId,
                tail: lastNLines,
                stdout: msg,
                status: StepStatus.RUNNING,
                lastUpdateId: stateVars.updateId,
            };
            await this.RestAPICall(`stepOutcome/${stepOutcomeId}`, 'PUT', { data: updates });
            stateVars.updateId += 1;
            let payload = {};
            if (step.variables) payload = Object.assign(payload, step.variables);
            runningProcesses[taskOutcomeId] = 'no requestId yet';
            let runLambdaError: any;
            let runLambdaResult: any;
            LambdaUtils.RunAWSLambda(task.id, step.lambdaAWSRegion, payload, (err, data) => {
                if (err) {
                    runLambdaError = err;
                    stateVars.runLambdaFinished = true;
                }
                if (data) {
                    runLambdaResult = data;
                }
            });
            this.ProcessTailQueue(
                queueTail,
                step,
                task,
                taskOutcomeId,
                stepOutcomeId,
                rtvCumulative,
                lastNLines,
                stateVars,
                (data) => {
                    const usageData = LambdaUtils.ExtractUsageDataFromLambdaLog(data);
                    lambdaDuration = usageData.lambdaDuration;
                    lambdaBilledDuration = usageData.lambdaBilledDuration;
                    lambdaMemSize = usageData.lambdaMemSize;
                    lambdaMaxMemUsed = usageData.lambdaMaxMemUsed;
                    lambdaInitDuration = usageData.lambdaInitDuration;
                }
            );
            await LambdaUtils.GetCloudWatchLogsEvents(task.id, stateVars, this.logger, (messages) => {
                for (let i = 0; i < messages.length; i++) {
                    const message = messages[i].message;
                    if (message.startsWith('START')) {
                        const requestId = message.split(' ')[2];
                        runningProcesses[taskOutcomeId] = `lambda ${requestId}`;
                    } else if (message.indexOf('[ERROR] ') >= 0) {
                        error = message;
                        console.log(error);
                    }
                    queueTail.push(message);
                }

                fs.writeSync(fileOut, messages.map((m) => m.message).join('\n'));
            });
            fs.closeSync(fileOut);
            stateVars.procFinished = true;
            while (!stateVars.stdoutAnalysisFinished) await SGUtils.sleep(100);
            if (runLambdaError) {
                this.LogError(runLambdaError.message, runLambdaError.stack, runLambdaError);
                error = 'Unknown error occurred running lambda function!';
            }
            if (runLambdaResult) {
                if (runLambdaResult.FunctionError && runLambdaResult.Payload) {
                    const payload = JSON.parse(runLambdaResult.Payload);
                    error = `errorType: ${payload.errorType} - errorMessage: ${payload.errorMessage} - stackTrace: ${payload.stackTrace}\n${error}`;
                }
            }
            let code = 0;
            if (error != '') {
                code = 1;
            }
            let outParams = await this.PostRunScriptProcessing(
                step,
                task,
                stdoutFilePath,
                stateVars,
                lastNLines,
                code,
                workingDirectory
            );
            outParams = {
                ...outParams,
                ...{
                    lambdaDuration: lambdaDuration,
                    lambdaBilledDuration: lambdaBilledDuration,
                    lambdaMemSize: lambdaMemSize,
                    lambdaMaxMemUsed: lambdaMaxMemUsed,
                    lambdaInitDuration: lambdaInitDuration,
                },
            };
            if (error == '') {
                outParams[SGStrings.status] = StepStatus.SUCCEEDED;
            } else {
                outParams['runtimeVars']['route'] = { value: 'fail' };
                outParams[SGStrings.status] = StepStatus.FAILED;
                outParams['failureCode'] = TaskFailureCode.TASK_EXEC_ERROR;
            }
            outParams['stderr'] = error;
            outParams['_teamId'] = _teamId;
            await LambdaUtils.DeleteAWSLambda(task.id, step.lambdaAWSRegion);
            await LambdaUtils.DeleteCloudWatchLogsEvents(task.id);
            return outParams;
        } catch (e) {
            const errMsg: string = e.message || e.toString();
            this.LogError('Error in RunStepAsync_Lambda', e.stack, SGUtils.errorToObj(e));
            await SGUtils.sleep(1000);
            error += errMsg + '\n';
            throw {
                status: StepStatus.FAILED,
                code: 1,
                route: 'fail',
                stderr: error,
                failureCode: TaskFailureCode.AGENT_EXEC_ERROR,
            };
        }
    };

    /**
     * Executes an script
     * @param commandString
     * @param fileOut
     * @param fileErr
     * @param env
     * @param workingDirectory
     * @param taskOutcomeId
     * @param fnOnProcessStarted
     * @returns
     */
    SpawnScriptProcess(
        commandString: string,
        fileOut: number,
        fileErr: number,
        env: any,
        workingDirectory: string,
        taskOutcomeId: mongodb.ObjectId,
        fnOnProcessStarted: any
    ): Promise<SpawnScriptOutcome> {
        return new Promise((resolve, reject) => {
            const cmd = spawn(commandString, [], {
                stdio: ['ignore', fileOut, fileErr],
                shell: true,
                detached: false,
                env: env,
                cwd: workingDirectory,
            });
            runningProcesses[taskOutcomeId] = cmd;
            fnOnProcessStarted();
            /// called if there is an error running the script
            cmd.on('error', (err) => {
                reject(err);
            });
            /// called when external process completes
            cmd.on('exit', async (code, signal) => {
                resolve({ code, signal });
            });
        });
    }

    /**
     * Processes script execution data piped to stdout
     * @param queueTail
     * @param task
     * @param taskOutcomeId
     * @param stepOutcomeId
     * @param rtvCumulative
     * @param lastNLines
     * @param stateVars
     */
    ProcessTailQueue = async (
        queueTail: any[],
        step: StepSchema,
        task: TaskSchema,
        taskOutcomeId: mongodb.ObjectId,
        stepOutcomeId: mongodb.ObjectId,
        rtvCumulative: any,
        lastNLines: any[],
        stateVars: any,
        fnOnMessagesDequeued = undefined
    ) => {
        while (true) {
            if (queueTail.length < 1) {
                if (stateVars.procFinished) {
                    break;
                }
                if (!(taskOutcomeId in runningProcesses)) {
                    break;
                }
                for (let i = 0; i < this.sendUpdatesInterval / 1000; i++) {
                    await SGUtils.sleep(1000);
                    if (stateVars.procFinished) break;
                }
                continue;
            }
            const data: string[] = queueTail.splice(0);
            try {
                const dataAsString = data.join('\n');
                // Extracts runtime variable values and pushes them to the API
                if (!(task.target & (TaskDefTarget.ALL_AGENTS | TaskDefTarget.ALL_AGENTS_WITH_TAGS))) {
                    const extractRes = this.ExtractRuntimeVarsFromString(dataAsString);
                    const rtv = extractRes.runtimeVars;
                    const rtvUpdates = {};
                    for (let indexRTV = 0; indexRTV < Object.keys(rtv).length; indexRTV++) {
                        const key = Object.keys(rtv)[indexRTV];
                        if (!rtvCumulative[key] || rtvCumulative[key] != rtv[key]) {
                            rtvUpdates[key] = rtv[key];
                            rtvCumulative[key] = rtv[key];
                        }
                    }
                    if (Object.keys(rtvUpdates).length > 0) {
                        await this.RestAPICall(`taskOutcome/${taskOutcomeId}`, 'PUT', {
                            data: { runtimeVars: rtvUpdates },
                        });
                    }
                }
                if (fnOnMessagesDequeued) fnOnMessagesDequeued(data);
                // Updates lastNLines with the last "numLinesInTail" lines from stdout
                lastNLines.push(...data);
                if (lastNLines.length > this.numLinesInTail)
                    lastNLines.splice(0, lastNLines.length - this.numLinesInTail);
                for (let i = 0; i < lastNLines.length; i++) {
                    if (Buffer.byteLength(lastNLines[i], 'utf8') > this.maxSizeLineInTail)
                        lastNLines[i] = truncate(lastNLines[i], this.maxSizeLineInTail) + ' (truncated)';
                    lastNLines[i] = this.ReplaceSensitiveRuntimeVarValuesInString(lastNLines[i], task.runtimeVars);
                }
                // Uploads stdout to the API in chunks up to a max size
                while (true) {
                    if (data.length < 1) break;

                    let stdoutToUpload = '';
                    let countLinesToUpload = 0;
                    if (!stateVars.stdoutTruncated) {
                        const maxStdoutUploadSize = 51200;
                        let stdoutBytesProcessedLocal = 0;
                        for (let i = 0; i < data.length; i++) {
                            data[i] = this.ReplaceSensitiveRuntimeVarValuesInString(data[i], task.runtimeVars);
                            const strLenBytes = Buffer.byteLength(data[i], 'utf8');
                            if (stateVars.stdoutBytesProcessed + strLenBytes > this.maxStdoutSize) {
                                stdoutToUpload += '\n(max stdout size exceeded - results truncated)\n';
                                stateVars.stdoutTruncated = true;
                                break;
                            }
                            if (stdoutBytesProcessedLocal + strLenBytes > maxStdoutUploadSize) {
                                break;
                            }
                            stdoutToUpload += `${data[i]}\n`;
                            stateVars.stdoutBytesProcessed += strLenBytes;
                            stdoutBytesProcessedLocal += strLenBytes;
                            countLinesToUpload += 1;
                        }
                    }
                    data.splice(0, countLinesToUpload);
                    const updates = {
                        tail: lastNLines,
                        stdout: stdoutToUpload,
                        status: StepStatus.RUNNING,
                        lastUpdateId: stateVars.updateId,
                    };
                    if (task.target == TaskDefTarget.AWS_LAMBDA) {
                        updates['_teamId'] = step._teamId;
                    }
                    stateVars.updateId += 1;
                    await this.RestAPICall(`stepOutcome/${stepOutcomeId}`, 'PUT', {
                        data: updates,
                    });

                    if (stateVars.stdoutTruncated) break;
                }
            } catch (err) {
                this.LogError(`Error handling stdout tail`, err.stack, SGUtils.errorToObj(err));
                await SGUtils.sleep(1000);
            }
        }
        stateVars.stdoutAnalysisFinished = true;
    };

    /**
     * Creates the script file with the code to execute
     * @param script - object with script properties
     * @param workingDirectory - the directory where the script will be created
     * @returns scriptFilePath - the path of the created file
     */
    CreateScriptFile(script: any, workingDirectory: string): string {
        let scriptFilePath = workingDirectory + path.sep + SGUtils.makeid(10);

        if (script.scriptType == ScriptType.NODE) {
            scriptFilePath += '.js';
        } else if (script.scriptType == ScriptType.PYTHON) {
            scriptFilePath += '.py';
        } else if (script.scriptType == ScriptType.SH) {
            scriptFilePath += '.sh';
        } else if (script.scriptType == ScriptType.CMD) {
            scriptFilePath += '.bat';
        } else if (script.scriptType == ScriptType.RUBY) {
            scriptFilePath += '.rb';
        } else if (script.scriptType == ScriptType.LUA) {
            scriptFilePath += '.lua';
        } else if (script.scriptType == ScriptType.PERL) {
            scriptFilePath += '.pl';
        } else if (script.scriptType == ScriptType.PHP) {
            scriptFilePath += '.php';
        } else if (script.scriptType == ScriptType.POWERSHELL) {
            scriptFilePath += '.ps1';
        }
        // console.log('script -> ', JSON.stringify(script, null, 4));
        fs.writeFileSync(scriptFilePath, SGUtils.atob(script.code));
        if (script.scriptType == ScriptType.SH) {
            fs.chmod(scriptFilePath, 0o0755, (err) => {
                if (err) throw err;
            });
        }
        return scriptFilePath;
    }

    /**
     * Creates the command line string for running the script
     * @param step
     * @param script
     * @param scriptFilePath
     * @returns
     */
    CreateCommandString(step: StepSchema, script: any, scriptFilePath: string): string {
        let commandString = '';
        if (step.command) {
            commandString = step.command.trim() + ' ';
        } else {
            if (script.scriptType != ScriptType.CMD && script.scriptType != ScriptType.SH) {
                commandString += `${ScriptTypeDetails[ScriptType[script.scriptType.toString()]].cmd} `;
            }
        }
        commandString += scriptFilePath;
        if (step.arguments) commandString += ` ${step.arguments}`;
        return commandString;
    }

    /**
     * Starts tailing the file which stdout is piped to
     * @param queueTail - data captured from the tail is pushed to this queue
     * @param stdoutFilePath - name of the file to which stdout is piped to
     * @param scriptFilePath  - the path of the file containing the executing script
     */
    StartStdOutTail(queueTail: any[], stdoutFilePath: string, scriptFilePath: string): any {
        /// tail the stdout
        const tail = new Tail(stdoutFilePath, {
            useWatchFile: true,
            flushAtEOF: true,
        });
        tail.on('line', async (data) => {
            if (process.platform.indexOf('win') != 0)
                try {
                    if (fs.existsSync(scriptFilePath)) fs.unlinkSync(scriptFilePath);
                } catch (e) {
                    // Ignore error
                }
            queueTail.push(data);
        });
        tail.on('error', function (error) {
            this.LogError('Error tailing stdout file', error.stack, {
                error: error.toString(),
            });
        });
        return tail;
    }

    /**
     * Set environment variables for running script
     * @param step
     * @param task
     * @returns dict with environment variables
     */
    ScriptProcessEnv(step: StepSchema, task: TaskSchema): any {
        let env = Object.assign({}, process.env);
        if (step.variables) env = Object.assign(env, step.variables);
        env.sgAgentId = this.InstanceId();
        env.teamId = task._teamId;
        env.jobId = task._jobId;
        env.taskId = task.id;
        env.stepId = step.id;
        return env;
    }

    /**
     * Captures data from stdout/stderr and other output data after script processing is complete
     * @param step
     * @param task
     * @param stdoutFilePath
     * @param stateVars
     * @param lastNLines
     * @param code
     * @param workingDirectory
     * @returns
     */
    PostRunScriptProcessing = async (
        step: StepSchema,
        task: TaskSchema,
        stdoutFilePath: string,
        stateVars: any,
        lastNLines: string[],
        code: number,
        workingDirectory
    ): Promise<any> => {
        let parseStdoutResult: any = {};
        if (fs.existsSync(stdoutFilePath)) {
            parseStdoutResult = await this.ParseScriptStdout(
                stdoutFilePath,
                task,
                true,
                stateVars.stdoutBytesProcessed,
                stateVars.stdoutTruncated
            );
            lastNLines = lastNLines.concat(parseStdoutResult.lastNLines).slice(-this.numLinesInTail);
        } else {
            parseStdoutResult.output = '';
            parseStdoutResult.runtimeVars = {};
        }
        const runtimeVars = {};
        let match: string[] = [];
        while ((match = regexStdoutRedirectFiles.exec(step.arguments)) !== null) {
            const fileName = match[1];
            let parseResult: any = {};
            parseResult = await this.ParseScriptStdout(workingDirectory + path.sep + fileName, task, false);
            Object.assign(runtimeVars, parseResult.runtimeVars);
        }
        Object.assign(runtimeVars, parseStdoutResult.runtimeVars);
        const outParams = {};
        outParams['runtimeVars'] = runtimeVars;
        outParams['dateCompleted'] = new Date().toISOString();
        outParams['stdout'] = parseStdoutResult.output;
        outParams['tail'] = lastNLines;
        outParams['exitCode'] = code;
        outParams['lastUpdateId'] = stateVars.updateId;
        return outParams;
    };

    /**
     * Runs the given step
     * @param step
     * @param workingDirectory
     * @param task
     * @param stepOutcomeId
     * @param lastUpdatedId
     * @param taskOutcomeId
     * @returns
     */
    RunStepAsync = async (
        step: StepSchema,
        workingDirectory: string,
        task: TaskSchema,
        stepOutcomeId: mongodb.ObjectId,
        lastUpdatedId: number,
        taskOutcomeId: mongodb.ObjectId
    ): Promise<RunStepOutcome> => {
        let scriptFilePath;
        try {
            const script = step.script;
            scriptFilePath = this.CreateScriptFile(script, workingDirectory);
            const commandString = this.CreateCommandString(step, script, scriptFilePath);
            const stdoutFilePath = workingDirectory + path.sep + SGUtils.makeid(10) + '.out';
            const stderrFilePath = workingDirectory + path.sep + SGUtils.makeid(10) + '.err';
            const fileOut: number = fs.openSync(stdoutFilePath, 'w');
            const fileErr: number = fs.openSync(stderrFilePath, 'w');
            const stateVars = {
                updateId: lastUpdatedId + 1,
                procFinished: false,
                stdoutAnalysisFinished: false,
                stdoutBytesProcessed: 0,
                stdoutTruncated: false,
            };
            const lastNLines: string[] = [];
            const rtvCumulative = {};
            const queueTail: any[] = [];
            const tail = this.StartStdOutTail(queueTail, stdoutFilePath, scriptFilePath);
            const spawnScriptProcessRes: SpawnScriptOutcome = await this.SpawnScriptProcess(
                commandString,
                fileOut,
                fileErr,
                this.ScriptProcessEnv(step, task),
                workingDirectory,
                taskOutcomeId,
                () => {
                    this.ProcessTailQueue(
                        queueTail,
                        step,
                        task,
                        taskOutcomeId,
                        stepOutcomeId,
                        rtvCumulative,
                        lastNLines,
                        stateVars
                    );
                }
            );
            const code: number = spawnScriptProcessRes.code;
            const signal: string = spawnScriptProcessRes.signal;
            try {
                if (fs.existsSync(scriptFilePath)) fs.unlinkSync(scriptFilePath);
            } catch (e) {
                // Ignore error
            }
            fs.closeSync(fileOut);
            fs.closeSync(fileErr);
            stateVars.procFinished = true;
            tail.unwatch();
            await SGUtils.sleep(100);
            while (!stateVars.stdoutAnalysisFinished) await SGUtils.sleep(100);
            const outParams = await this.PostRunScriptProcessing(
                step,
                task,
                stdoutFilePath,
                stateVars,
                lastNLines,
                code,
                workingDirectory
            );
            // Parse stderr
            let parseStderrResult: any = {};
            if (fs.existsSync(stderrFilePath)) {
                parseStderrResult = await this.ParseScriptStderr(stderrFilePath, task);
            } else {
                parseStderrResult.output = '';
            }
            outParams['stderr'] = parseStderrResult.output;
            if (code == 0) {
                outParams[SGStrings.status] = StepStatus.SUCCEEDED;
            } else {
                // If the script errored out (non-zero exit code), set the route, status and failure code
                if (signal == 'SIGTERM' || signal == 'SIGINT' || this.mainProcessInterrupted) {
                    outParams['runtimeVars']['route'] = { value: 'interrupt' };
                    outParams[SGStrings.status] = StepStatus.INTERRUPTED;
                } else {
                    outParams['runtimeVars']['route'] = { value: 'fail' };
                    outParams[SGStrings.status] = StepStatus.FAILED;
                    outParams['failureCode'] = TaskFailureCode.TASK_EXEC_ERROR;
                }
            }
            outParams['signal'] = signal;
            return outParams;
        } catch (e) {
            try {
                if (scriptFilePath && fs.existsSync(scriptFilePath)) fs.unlinkSync(scriptFilePath);
            } catch (e) {
                // Ignore error
            }
            this.LogError('Error in RunStepAsync', e.stack, SGUtils.errorToObj(e));
            return {
                status: StepStatus.FAILED,
                exitCode: 1,
                route: 'fail',
                stderr: e.message || (e && e.toString()),
                failureCode: TaskFailureCode.AGENT_EXEC_ERROR,
            };
        }
    };

    /**
     * Runs the given task steps
     * @param steps
     * @param task
     * @param workingDirectory
     * @param taskOutcome
     * @returns
     */
    RunTaskSteps = async (
        steps: StepSchema[],
        task: TaskSchema,
        workingDirectory: string,
        taskOutcome: Partial<TaskOutcomeSchema>
    ): Promise<{ runStepOutcome: RunStepOutcome | undefined; allStepsCompleted: boolean }> => {
        let runStepOutcome: RunStepOutcome | undefined = undefined;
        let allStepsCompleted = true;
        for (const step of steps) {
            // Inject runtime variables in step environment variables matched on variable name
            if (step.variables) {
                const newVariables = _.clone(step.variables);
                for (let e = 0; e < Object.keys(newVariables).length; e++) {
                    const eKey = Object.keys(newVariables)[e];
                    if (eKey in task.runtimeVars) {
                        newVariables[eKey] = task.runtimeVars[eKey]['value'];
                    }
                }
                step.variables = newVariables;
            }
            // Inject scripts referenced with @sgs syntax
            let newScript = SGUtils.InjectScripts(
                this._teamId,
                SGUtils.atob(step.script.code),
                task.scriptsToInject,
                this.LogError
            );
            // Inject runtime vars in @sgg placeholders in script
            newScript = SGUtils.InjectRuntimeVarsInScript(task, newScript, this.LogError);
            step.script.code = SGUtils.btoa_(newScript);
            // Inject runtime vars in script command line arguments
            step.arguments = SGUtils.InjectRuntimeVarsInArg(task, step.arguments, this.LogError);
            let runCode: string = SGUtils.atob(step.script.code);
            runCode = this.ReplaceSensitiveRuntimeVarValuesInString(runCode, task.runtimeVars);
            runCode = SGUtils.btoa_(runCode);
            let stepOutcome: any = {
                _teamId: new mongodb.ObjectId(this._teamId),
                _jobId: task._jobId,
                _stepId: step.id,
                _taskOutcomeId: taskOutcome.id,
                lastUpdateId: 0,
                name: step.name,
                source: task.source,
                machineId: this.MachineId(),
                ipAddress: this.ipAddress,
                runCode: runCode,
                status: TaskStatus.RUNNING,
                dateStarted: new Date().toISOString(),
                agentTags: this.tags,
            };
            if (task.target == TaskDefTarget.AWS_LAMBDA) {
                stepOutcome._teamId = task._teamId;
                stepOutcome.ipAddress = '0.0.0.0';
                stepOutcome.machineId = 'lambda-executor';
            }
            stepOutcome = <StepOutcomeSchema>await this.RestAPICall(`stepOutcome`, 'POST', {
                data: stepOutcome,
                retryWithBackoff: true,
            });
            // console.log('Agent -> RunTask -> RunStepAsync -> step -> ', util.inspect(step, false, null));
            if (task.target == TaskDefTarget.AWS_LAMBDA) {
                runStepOutcome = await this.RunStepAsync_Lambda(
                    step,
                    task,
                    stepOutcome.id,
                    stepOutcome.lastUpdateId,
                    taskOutcome.id,
                    workingDirectory
                );
            } else {
                runStepOutcome = await this.RunStepAsync(
                    step,
                    workingDirectory,
                    task,
                    stepOutcome.id,
                    stepOutcome.lastUpdateId,
                    taskOutcome.id
                );
            }
            if (task.target == TaskDefTarget.AWS_LAMBDA) {
                runStepOutcome._teamId = task._teamId;
            }
            this.queueAPICall.push({
                url: `stepOutcome/${stepOutcome.id}`,
                method: 'PUT',
                headers: null,
                data: runStepOutcome,
            });
            Object.assign(task.runtimeVars, runStepOutcome.runtimeVars);
            Object.assign(taskOutcome.runtimeVars, runStepOutcome.runtimeVars);
            if (runStepOutcome.status === StepStatus.INTERRUPTED || runStepOutcome.status === StepStatus.FAILED) {
                allStepsCompleted = false;
                break;
            }
        }

        return { runStepOutcome, allStepsCompleted };
    };

    RunTask = async (task: TaskSchema) => {
        // this.LogDebug('Running task', { 'id': task.id });
        // console.log('Agent -> RunTask -> task -> ', util.inspect(task, false, null));
        const dateStarted = new Date();
        const workingDirectory = process.cwd() + path.sep + SGUtils.makeid(10);
        if (!fs.existsSync(workingDirectory)) fs.mkdirSync(workingDirectory);
        try {
            let artifactsDownloadedSize = 0;
            if (task.artifacts) {
                for (let i = 0; i < task.artifacts.length; i++) {
                    const getArtifactResult: any = await this.GetArtifact(task.artifacts[i], workingDirectory);
                    if (!getArtifactResult.success) {
                        this.logger.LogError(`Error downloading artifact`, '', {
                            _artifactId: task.artifacts[i],
                            error: getArtifactResult.error.toString(),
                        });
                        let execError;
                        if (getArtifactResult.artifactName) {
                            execError = 'Error downloading artifact ';
                            if (getArtifactResult.artifactPrefix) execError += `${getArtifactResult.artifactPrefix}/`;
                            execError += `${getArtifactResult.artifactName}`;
                        } else {
                            execError = `Error downloading artifact - no artifact exists with id ${task.artifacts[i]}`;
                        }
                        const taskOutcome = {
                            status: TaskStatus.FAILED,
                            failureCode: TaskFailureCode.ARTIFACT_DOWNLOAD_ERROR,
                            execError,
                            ipAddress: this.ipAddress,
                            machineId: this.MachineId(),
                        };
                        await this.RestAPICall(`taskOutcome/${task._taskOutcomeId}`, 'PUT', {
                            data: taskOutcome,
                            retryWithBackoff: true,
                        });
                        throw {
                            name: 'ArtifactDownloadError',
                        };
                    }
                    artifactsDownloadedSize += getArtifactResult.artifactSize;
                }
            }
            let stepsAsc: StepSchema[] = (<any>task).steps;
            // console.log('Agent -> RunTask -> stepsAsc -> beforesort -> ', util.inspect(stepsAsc, false, null));
            stepsAsc = stepsAsc.sort((a: StepSchema, b: StepSchema) =>
                a.order > b.order ? 1 : a.order < b.order ? -1 : 0
            );
            // console.log('Agent -> RunTask -> stepsAsc -> ', util.inspect(stepsAsc, false, null));
            let taskOutcome: Partial<TaskOutcomeSchema> = {
                status: TaskStatus.RUNNING,
                dateStarted: dateStarted,
                ipAddress: this.ipAddress,
                machineId: this.MachineId(),
                artifactsDownloadedSize: artifactsDownloadedSize,
            };
            if (task.target == TaskDefTarget.AWS_LAMBDA) taskOutcome._teamId = task._teamId;
            taskOutcome = await this.RestAPICall(`taskOutcome/${task._taskOutcomeId}`, 'PUT', {
                data: taskOutcome,
                retryWithBackoff: true,
            });
            // console.log('taskOutcome -> POST -> ', util.inspect(taskOutcome, false, null));
            if (taskOutcome.status == TaskStatus.RUNNING) {
                const runTaskStepsResult: { runStepOutcome: RunStepOutcome | undefined; allStepsCompleted: boolean } =
                    await this.RunTaskSteps(stepsAsc, task, workingDirectory, taskOutcome);
                const runStepOutcome: RunStepOutcome | undefined = runTaskStepsResult.runStepOutcome;
                const allStepsCompleted: boolean = runTaskStepsResult.allStepsCompleted;
                const dateCompleted = new Date().toISOString();
                if (allStepsCompleted) {
                    taskOutcome.status = TaskStatus.SUCCEEDED;
                } else {
                    if (runStepOutcome) {
                        taskOutcome.status = runStepOutcome.status;
                        if (runStepOutcome.failureCode) taskOutcome.failureCode = runStepOutcome.failureCode;
                    } else {
                        taskOutcome.status = TaskStatus.FAILED;
                        taskOutcome.failureCode = TaskFailureCode.AGENT_EXEC_ERROR;
                    }
                }
                const taskOutcomeUpdates: any = {};
                taskOutcomeUpdates.status = taskOutcome.status;
                if (taskOutcome.failureCode) taskOutcomeUpdates.failureCode = taskOutcome.failureCode;
                taskOutcomeUpdates.dateCompleted = dateCompleted;
                taskOutcomeUpdates.runtimeVars = taskOutcome.runtimeVars;
                if (task.target == TaskDefTarget.AWS_LAMBDA) taskOutcomeUpdates._teamId = task._teamId;
                // console.log(`???????????????????\n\ntaskOutcomeId -> ${taskOutcome.id}\n\ntaskOutcome -> ${JSON.stringify(taskOutcome)}\n\ntask -> ${JSON.stringify(task)}\n\ntaskOutcomeUpdates -> ${JSON.stringify(taskOutcomeUpdates)}`);
                this.queueAPICall.push({
                    url: `taskOutcome/${taskOutcome.id}`,
                    method: 'PUT',
                    headers: null,
                    data: taskOutcomeUpdates,
                });
                // console.log('taskOutcome -> PUT -> ', util.inspect(taskOutcome, false, null));
                delete runningProcesses[taskOutcome.id];
            }
        } finally {
            this.RemoveFolder(workingDirectory, 0);
        }
    };

    CompleteTaskGeneralErrorHandler = async (params: any) => {
        // todo: get the taskoutcomeid from params
        try {
            const taskOutcomeId = params._taskOutcomeId;

            const taskOutcomeUpdates: any = { runtimeVars: { route: 'fail' } };
            taskOutcomeUpdates.status = TaskStatus.FAILED;
            taskOutcomeUpdates.failureCode = TaskFailureCode.AGENT_EXEC_ERROR;
            taskOutcomeUpdates.dateCompleted = new Date().toISOString();
            this.queueAPICall.push({
                url: `taskOutcome/${taskOutcomeId.id}`,
                method: 'PUT',
                headers: null,
                data: taskOutcomeUpdates,
            });

            delete runningProcesses[taskOutcomeId.id];
        } catch (e) {
            this.LogError('Error in CompleteTaskGeneralErrorHandler', e.stack, {
                error: e.toString(),
            });
        }
    };

    CompleteTask = async (params: any, msgKey: string, cb: any) => {
        this.LogDebug('Task received', { msgKey, params });
        this.numActiveTasks += 1;
        try {
            if (this.numActiveTasks > this.maxActiveTasks) {
                cb(false, msgKey);
            } else {
                cb(true, msgKey);
                await this.RunTask(params);
            }
        } catch (e) {
            if (e.name && e.name == 'ArtifactDownloadError') {
                // Ignore ArtifactDownloadError
            } else {
                this.LogError('Error in CompleteTask', e.stack, {
                    error: e.toString(),
                });
            }
            // await this.CompleteTaskGeneralErrorHandler(params);
            // return cb(true, msgKey);
        } finally {
            this.numActiveTasks -= 1;
        }
    };

    Update = async (params: any, msgKey: string, cb: any) => {
        try {
            await cb(true, msgKey);
            // await this.LogDebug("Update received", { msgKey, params });
            if (this.updating) {
                await this.LogWarning('Version update running - skipping this update', {});
                return;
            }
            if (this.stopping) {
                await this.LogWarning('Agent stopping - skipping this update', {});
                return;
            }
            if (params.targetVersion && params.reportedVersion) {
                if (params.targetVersion == params.reportedVersion || this.runStandAlone) {
                    return;
                }
                this.updating = true;
                await this.LogDebug('Update Agent version message received', {
                    msgKey,
                    params,
                });
                await SGUtils.sleep(2000);
                await this.StopConsuming();
                if (this.numActiveTasks > 0)
                    await this.LogDebug('Updating Agent - waiting for current tasks to complete', {});
                while (this.numActiveTasks > 0) {
                    await SGUtils.sleep(5000);
                }
                await this.LogWarning('Updating Agent - shutting down', {});
                process.exit(96);
            }
            if (params.tags) {
                await this.LogDebug('Update tags message received', { msgKey, params });
                this.tags = params.tags;
                this.updateUserConfigValues({ tags: this.tags });
            }
            if (params.propertyOverrides) {
                await this.LogDebug('Update property overrides message received', {
                    msgKey,
                    params,
                });
                // await cb(true, msgKey);
                await this.UpdatePropertyOverrides(params.propertyOverrides, 'server');
                this.updateUserConfigValues({
                    propertyOverrides: params.propertyOverrides,
                });
                await this.SendHeartbeat(false, true);
                await this.SendMessageToAgentStub(params);
            }
            if (params.interruptTask) {
                await this.LogDebug('Interrupt task message received', {
                    msgKey,
                    params,
                });
                const procToInterrupt = runningProcesses[params.interruptTask.id];
                if (procToInterrupt && typeof procToInterrupt == 'object' && procToInterrupt.pid) {
                    // console.log('Interrupting task');
                    // procToInterrupt.stdin.pause();
                    // console.log('stdin paused');
                    procToInterrupt.kill();
                    // console.log('Task interrupted');
                } else {
                    const runtimeVars = { route: { value: 'interrupt' } };
                    const taskOutcomeUpdate = {
                        status: TaskStatus.INTERRUPTED,
                        runtimeVars: runtimeVars,
                    };
                    this.queueAPICall.push({
                        url: `taskOutcome/${params.interruptTask.id}`,
                        method: 'PUT',
                        headers: null,
                        data: taskOutcomeUpdate,
                    });
                }
            }
            if (params.stopAgent) {
                this.stopping = true;
                await this.LogDebug('Stop Agent message received', { msgKey, params });
                await SGUtils.sleep(2000);
                await this.StopConsuming();
                if (this.numActiveTasks > 0)
                    await this.LogDebug('Stopping Agent - waiting for current tasks to complete', {});
                while (this.numActiveTasks > 0) {
                    await SGUtils.sleep(5000);
                }
                for (let i = 0; i < 6; i++) {
                    if (!this.queueAPICall || this.queueAPICall.length <= 0) break;
                    await SGUtils.sleep(5000);
                }
                this.offline = true;
                await this.SendDisconnectMessage();
            }
            // await cb(true, msgKey);
        } catch (e) {
            this.LogError(`Error in Update`, e.stack, { error: e.toString() });
        } finally {
            // this.lockUpdate.release();
        }
    };

    async UpdatePropertyOverrides(propertyOverrides: any, source: string) {
        if (!propertyOverrides) return;
        for (let i = 0; i < Object.keys(propertyOverrides).length; i++) {
            const key = Object.keys(propertyOverrides)[i];
            if (source == 'debug' || this.userConfigurableProperties.indexOf(key) >= 0) {
                if (key == 'logLevel') {
                    if (propertyOverrides[key] != null) {
                        this.logger.logLevel = propertyOverrides[key];
                        const props = {};
                        props[key] = propertyOverrides[key];
                        await this.SendMessageToAgentStub({ propertyOverrides: props });
                    }
                } else {
                    if (propertyOverrides[key] == null) {
                        this[key] = undefined;
                    } else {
                        if (typeof this[key] === 'number') this[key] = +propertyOverrides[key];
                        else this[key] = propertyOverrides[key];
                    }
                }
            }
        }
    }

    async CheckStompConnection() {
        if (this.stopped) return;
        // this.LogDebug('Starting CheckStompConnection', {});
        if (
            !(await this.stompConsumer.IsConnected(
                SGStrings.GetAgentQueue(this._teamId, this.instanceId.toHexString())
            ))
        ) {
            // this.LogError('IsConnected returned false', '', {});
            await this.OnRabbitMQDisconnect();
        } else {
            setTimeout(() => {
                this.CheckStompConnection();
            }, 10000);
        }
    }

    OnRabbitMQDisconnect = async () => {
        if (this.stopped) return;
        lock.acquire(
            lockConnectStomp,
            async () => {
                if (
                    !(await this.stompConsumer.IsConnected(
                        SGStrings.GetAgentQueue(this._teamId, this.instanceId.toHexString())
                    ))
                ) {
                    this.LogError(`Not connected to RabbitMQ - attempting to connect`, '', {});
                    await this.stompConsumer.Stop();
                    await this.ConnectStomp();
                }
            },
            (err) => {
                if (err) {
                    this.LogError('Error in OnRabbitMQDisconnect', err.stack, {
                        error: err.toString(),
                    });
                    process.exitCode = 1;
                }
            },
            {}
        );
    };

    async ConnectStomp() {
        try {
            const elapsed = Date.now() - this.lastStompConnectAttemptTime;
            if (elapsed < this.stompReconnectMinWaitTime) {
                const ttw = this.stompReconnectMinWaitTime - elapsed;
                await SGUtils.sleep(ttw);
            }
            this.lastStompConnectAttemptTime = Date.now();
            this.LogDebug('Connecting to stomp', {
                url: this.stompUrl,
                user: this.rmqUsername,
                password: this.rmqPassword,
                vhost: this.rmqVhost,
            });
            this.stompConsumer = new StompConnector(
                this.appName,
                this.instanceId.toHexString(),
                this.stompUrl,
                this.rmqUsername,
                this.rmqPassword,
                this.rmqAdminUrl,
                this.rmqVhost,
                1,
                () => this.OnRabbitMQDisconnect(),
                this.logger
            );
            try {
                await this.stompConsumer.Start();
            } catch (e) {
                this.LogError('Error starting stomp - trying again in 30 seconds', e.stack, { error: e.toString() });
                setTimeout(() => {
                    this.ConnectStomp();
                }, 30000);
                return;
            }
            await this.ConnectAgentWorkQueuesStomp();
            setTimeout(async () => {
                await this.CheckStompConnection();
            }, 30000);
        } catch (e) {
            this.LogError('Error in ConnectStomp', e.stack, { error: e.toString() });
            // setTimeout(() => { this.ConnectStomp(); }, 30000);
        }
    }

    async ConnectAgentWorkQueuesStomp() {
        const exchange = SGStrings.GetTeamExchangeName(this._teamId);
        const agentQueue = SGStrings.GetAgentQueue(this._teamId, this.instanceId.toHexString());
        // Queue to receive version update messages
        await this.stompConsumer.ConsumeQueue(
            SGStrings.GetAgentUpdaterQueue(this._teamId, this.instanceId.toHexString()),
            false,
            true,
            false,
            false,
            (msg, msgKey, cb) => this.Update(msg, msgKey, cb),
            SGStrings.GetTeamRoutingPrefix(this._teamId),
            this.inactiveAgentQueueTTL
        );
        // Queue to receive messages sent to this agent
        await this.stompConsumer.ConsumeQueue(
            agentQueue,
            false,
            true,
            false,
            false,
            (msg, msgKey, cb) => this.CompleteTask(msg, msgKey, cb),
            exchange,
            this.inactiveAgentQueueTTL
        );
    }

    async RunAgentStub() {
        const commandString = process.cwd() + '/sg-agent-launcher';
        try {
            spawn(commandString, [], { stdio: 'pipe', shell: true });
            process.exit();
        } catch (e) {
            console.error(`Error starting agent launcher '${commandString}': ${e.message}`, e.stack);
        }
    }

    async GetCronTab() {
        const commandString = 'crontab -l';
        const args = [];
        return new Promise<null | any>((resolve) => {
            try {
                let stdout = '';
                // this.LogDebug('GetCronTab: ' + commandString + ' ' + args, {});
                const cmd = spawn(commandString, args, {
                    stdio: 'pipe',
                    shell: true,
                });
                cmd.stdout.on('data', (data) => {
                    try {
                        // this.LogDebug('GetCronTab on.stdout.data', { data: data.toString() });
                        stdout = data.toString();
                    } catch (e) {
                        this.LogError('Error handling stdout in GetCronTab', e.stack, {
                            error: e.toString(),
                        });
                        resolve(null);
                    }
                });
                cmd.on('exit', (code) => {
                    try {
                        resolve({ code: code, stdout: stdout });
                    } catch (e) {
                        this.LogError('Error handling exit in GetCronTab', e.stack, {
                            error: e.toString(),
                        });
                        resolve(null);
                    }
                });
            } catch (e) {
                this.LogError(`GetCronTab error`, e.stack, {
                    commandString,
                    error: e.toString(),
                });
                resolve(null);
            }
        });
    }
}
