declare function require(name: string);
const spawn = require('child_process').spawn;
const Tail = require('tail').Tail;
import * as os from 'os';
import * as fs from 'fs';
import * as fse from 'fs-extra';
import * as path from 'path';
import axios from 'axios';
import { AgentLogger } from './shared/SGAgentLogger';
import { StompConnector } from './shared/StompLib';
import { LogLevel } from './shared/Enums';
import { SGUtils } from './shared/SGUtils';
import { SGStrings } from './shared/SGStrings';
import * as Enums from './shared/Enums';
import { TaskFailureCode } from './shared/Enums';
import { TaskSource } from './shared/Enums';
import { TaskDefTarget } from './shared/Enums';
import { TaskSchema } from './domain/Task';
import { StepSchema } from './domain/Step';
import { TaskOutcomeSchema } from './domain/TaskOutcome';
import { StepOutcomeSchema } from './domain/StepOutcome';
import * as util from 'util';
import * as ipc from 'node-ipc';
import * as sysinfo from 'systeminformation';
import * as es from 'event-stream';
import * as truncate from 'truncate-utf8-bytes';
import * as mongodb from 'mongodb';
const moment = require('moment');
const mtz = require('moment-timezone');
import * as _ from 'lodash';
import * as AsyncLock from 'async-lock';

const version = 'v0.0.0.41';

const userConfigPath: string = process.cwd() + '/sg.cfg';

const regexStdoutRedirectFiles = RegExp('(?<=\\>)(?<!2\\>)(?:\\>| )*([\\w\\.]+)', 'g');

let runningProcesses: any = {};

const lock = new AsyncLock();
const lockConnectStomp: string = 'lock_connect_stomp_key';

export default class Agent {
    private appName: string;
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
    private tags: any = {};
    private instanceId: mongodb.ObjectId;
    private ipAddress: string = '';
    private timezone: string = '';
    private stopped: boolean = false;
    private stopping: boolean = false;
    private updating: boolean = false;
    private numActiveTasks: number = 0;
    private maxActiveTasks: number = 10;
    private env: string;
    private logDest: string;
    private trackSysInfo: boolean = false;
    private logLevel: LogLevel = LogLevel.WARNING;
    private heartbeatInterval: number = 30000;
    private token: string;
    private userConfig: any = {};
    private timeLastActive: number = Date.now();
    private inactivePeriodWaitTime: number = 0;
    private inactiveAgentJob: any;
    private ipcPath: string;
    private handleGeneralTasks: boolean = true;
    private maxStdoutSize: number = 307200; // bytes
    private maxStderrSize: number = 51200; // bytes
    private numLinesInTail: number = 5;
    private maxSizeLineInTail: number = 1024; //bytes
    private sendUpdatesInterval: number = 10000;
    private queueCompleteMessages: any[] = [];
    private offline: boolean = false;
    private mainProcessInterrupted: boolean = false;
    private lastStompConnectAttemptTime: number = 0;
    private stompReconnectMinWaitTime: number = 10000;
    public _teamId: string;


    private userConfigurableProperties: string[] = ['maxActiveTasks', 'inactivePeriodWaitTime', 'inactiveAgentJob', 'handleGeneralTasks', 'trackSysInfo'];

    InstanceId() { return this.instanceId; }

    MachineId() { return (this.machineId ? this.machineId : os.hostname()); }


    constructor(params: any) {
        this.appName = 'Agent';

        // console.log(process.env.NODE_ENV);

        if (params.hasOwnProperty('logLevel'))
            this.logLevel = parseInt(params['logLevel']);

        this.logDest = 'file';
        if (params.hasOwnProperty('logDest'))
            this.logDest = params['logDest'];

        this._teamId = params._teamId;
        this.env = params.env;
        this.token = params.token;
        this.apiUrl = params.apiUrl;
        this.apiPort = params.apiPort;
        this.agentLogsAPIVersion = params.agentLogsAPIVersion;

        if ('machineId' in params)
            this.machineId = params.machineId;

        if ('runStandAlone' in params)
            this.runStandAlone = params.runStandAlone;

        if ('maxActiveTasks' in params)
            this.maxActiveTasks = params.maxActiveTasks;

        if ('inactivePeriodWaitTime' in params)
            this.inactivePeriodWaitTime = params.inactivePeriodWaitTime;

        if ('inactiveAgentJob' in params)
            this.inactiveAgentJob = params.inactiveAgentJob;

        if ('handleGeneralTasks' in params)
            this.handleGeneralTasks = params.handleGeneralTasks;

        if ('trackSysInfo' in params)
            this.trackSysInfo = params.trackSysInfo;

        if ('tags' in params)
            this.tags = params.tags;

        this.ipAddress = SGUtils.getIpAddress();
        this.timezone = moment.tz.guess();

        if (this.env != 'unittest') {
            this.userConfig = this.getUserConfigValues();
            if ('tags' in this.userConfig)
                this.tags = this.userConfig['tags'];
            if ('propertyOverrides' in this.userConfig)
                this.UpdatePropertyOverrides(this.userConfig['propertyOverrides'], 'local')
            if (this.env == 'debug') {
                if ('debug' in this.userConfig)
                    this.UpdatePropertyOverrides(this.userConfig['debug'], 'debug')
            }
        }

        this.ipcPath = process.argv[2];

        this.logger = new AgentLogger(this.appName, this._teamId, this.logLevel, process.cwd() + '/logs', this.apiUrl, this.apiPort, this.agentLogsAPIVersion, params.token, this.env, this.logDest, this.machineId);
        this.logger.Start();

        this.logger.LogDebug(`Starting Agent`, { tags: this.tags, propertyOverrides: this.UpdatePropertyOverrides, userConfigPath, env: this.env });
    }


    async CreateAgentInAPI() {
        let agentProperties: any = {};
        let agent_info: any = {
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
            propertyOverrides: { trackSysInfo: false, maxActiveTasks: this.maxActiveTasks, handleGeneralTasks: this.handleGeneralTasks },
            sysInfo: await this.GetSysInfo()
        };

        agentProperties = await this.RestAPICall(`agent`, 'POST', null, agent_info);

        return agentProperties;
    }


    async Init() {
        let agentProperties: any = {};
        try {
            agentProperties = await this.RestAPICall(`agent/name/${this.MachineId()}`, 'GET', { _teamId: this._teamId }, null);
        } catch (err) {
            if (err.response.status == 404) {
                this.logger.LogDebug(`Error getting agent properties`, { error: err.toString()});
                agentProperties = await this.CreateAgentInAPI();
            } else {
                this.logger.LogError(`Error getting agent properties`, err.stack, { error: err.toString() });
                throw err;
            }
        }

        // console.log('agent -> init -> agentProperties -> ', agentProperties);
        // console.log('agent -> init -> userConfig -> ', this.userConfig);
        // console.log('agent -> init -> userConfigPath -> ', userConfigPath);
        // const agentProperties: any = await this.GetProperties();

        this.instanceId = new mongodb.ObjectId(agentProperties.id);
        this.inactiveAgentQueueTTL = agentProperties.inactiveAgentQueueTTL;
        this.stompUrl = agentProperties.stompUrl;
        this.rmqAdminUrl = agentProperties.rmqAdminUrl;
        this.rmqUsername = agentProperties.rmqUsername;
        this.rmqPassword = agentProperties.rmqPassword;
        this.rmqVhost = agentProperties.rmqVhost;

        if (!this.areObjectsEqual(this.tags, agentProperties.tags)) {
            if (this.tags) {
                await this.RestAPICall(`agent/tags/${this.instanceId.toHexString()}`, 'PUT', null, { tags: this.tags });
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
                await this.RestAPICall(`agent/properties/${this.instanceId.toHexString()}`, 'PUT', null, this.userConfig.propertyOverrides);
                // await this.UpdatePropertyOverridesAPI(this.userConfig.propertyOverrides)
            }
        }

        if (this.env == 'debug') {
            if ('debug' in this.userConfig) {
                if ('stompUrl' in this.userConfig.debug)
                    this.stompUrl = this.userConfig.debug.stompUrl;
                if ('rmqAdminUrl' in this.userConfig.debug)
                    this.rmqAdminUrl = this.userConfig.debug.rmqAdminUrl;
            }
        }

        this.logger.instanceId = this.instanceId.toHexString();

        process.on('SIGINT', this.SignalHandler.bind(this));
        process.on('SIGTERM', this.SignalHandler.bind(this));

        await this.SendHeartbeat(true, false);

        await this.ConnectStomp();

        if (!this.runStandAlone) {
            try {
                await this.ConnectIPC();
                ipc.of.SGAgentLauncherProc.on('disconnect', async () => {
                    if (this.stopped)
                        return;
                    this.LogError(`Disconnected from agent launcher - attempting to reconnect in 10 seconds`, '', {});
                    for (let i = 0; i < 10; i++) {
                        if (this.stopped)
                            break;
                        await SGUtils.sleep(1000);
                    }
                    setTimeout(async () => {
                        try {
                            if (!this.stopped)
                                await this.ConnectIPC();
                        } catch (e) {
                            this.LogError(`Error connecting to agent launcher - restarting`, '', e);
                            try { this.RunAgentStub() } catch (e) { }
                        }
                    }, 1000);
                });
                await this.SendMessageToAgentStub({ propertyOverrides: { 'instanceId': this.instanceId, 'apiUrl': this.apiUrl, 'apiPort': this.apiPort, 'agentLogsAPIVersion': this.agentLogsAPIVersion } });
            } catch (e) {
                this.LogError(`Error connecting to agent launcher - restarting`, '', e);
                try { this.RunAgentStub() } catch (e) { }
            }
        }

        this.timeLastActive = Date.now();
        this.CheckInactiveTime();
        this.SendCompleteMessages();
    }


    async SignalHandler(signal) {
        this.mainProcessInterrupted = true;

        await this.Stop();

        this.offline = true;
        await this.SendDisconnectMessage();

        for (let i = 0; i < Object.keys(runningProcesses).length; i++) {
            const proc = runningProcesses[Object.keys(runningProcesses)[i]];
            if (proc && typeof (proc) == 'object' && proc.pid) {
                proc.kill();
                // delete runningProcesses[Object.keys(runningProcesses)[i]];
            }
        }

        const maxSleepCount: number = 10;
        let sleepCount: number = 0;
        while (Object.keys(runningProcesses).length > 0) {
            await SGUtils.sleep(500);
            sleepCount += 1;
            if (sleepCount >= maxSleepCount)
                break;
        }

        while (this.queueCompleteMessages && this.queueCompleteMessages.length > 0) {
            await SGUtils.sleep(500);
            sleepCount += 1;
            if (sleepCount >= maxSleepCount)
                break;
        }

        await SGUtils.sleep(1000);

        process.exit(128 + signal);
    }


    async GetArtifact(artifactId: string, destPath: string, _teamId: string) {
        return new Promise(async (resolve, reject) => {
            try {
                let artifact: any = await this.RestAPICall(`artifact/${artifactId}`, 'GET', null, null);
                const artifactPath = `${destPath}/${artifact.name}`;
                const writer = fs.createWriteStream(artifactPath);

                // console.log('GetArtifact -> url ', url, ', headers -> ', this._teamId, ', token -> ', this.token);

                const response = await axios({
                    url: artifact.url,
                    method: 'GET',
                    responseType: 'stream',
                    headers: {
                        Cookie: `Auth=${this.token};`,
                        _teamId: this._teamId
                    }
                });

                const artifactSize = await new Promise(async (resolve, reject) => {
                    response.data.pipe(writer)
                        .on('finish', () => {
                            const artifactSize: number = fs.statSync(artifactPath).size;
                            resolve(artifactSize);
                        })
                });

                if (SGUtils.GetFileExt(artifact.name) == '.gz') {
                    await SGUtils.GunzipFile(artifactPath);
                }
                resolve(artifactSize);
            } catch (e) {
                this.logger.LogError(`Error downloading artifact`, e.stack, {  artifactId, error: e.toString() });
                reject(e);
            }
        });
    };


    async RestAPICall(url: string, method: string, headers: any = {}, data: any = {}) {
        return new Promise(async (resolve, reject) => {
            try {
                let apiUrl = this.apiUrl;
                let apiVersion = this.agentLogsAPIVersion;

                const apiPort = this.apiPort;

                if (apiPort != '')
                    apiUrl += `:${apiPort}`
                url = `${apiUrl}/api/${apiVersion}/${url}`;

                const combinedHeaders: any = Object.assign({
                    Cookie: `Auth=${this.token};`,
                    _teamId: this._teamId
                }, headers);

                // this.logger.LogDebug(`RestAPICall`, {url, method, combinedHeaders, data, token: this.token});
                // console.log('Agent RestAPICall -> url ', url, ', method -> ', method, ', headers -> ', JSON.stringify(combinedHeaders, null, 4), ', data -> ', JSON.stringify(data, null, 4), ', token -> ', this.token);

                const response = await axios({
                    url,
                    method: method,
                    responseType: 'text',
                    headers: combinedHeaders,
                    data: data
                });
                resolve(response.data.data);
            } catch (e) {
                this.logger.LogDebug(`RestAPICall error`, { error: e.toString() });
                e.message = `Error occurred calling ${method} on '${url}': ${e.message}`;
                reject(e);
            }
        });
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

    updateUserConfigValues = (values: any) => {
        if (this.env == 'unittest')
            return;

        let userConfig: any = this.getUserConfigValues();
        if (values.propertyOverrides) {
            if (!(userConfig.propertyOverrides))
                userConfig.propertyOverrides = {};
            for (let i = 0; i < Object.keys(values.propertyOverrides).length; i++) {
                const key = Object.keys(values.propertyOverrides)[i];
                if (values.propertyOverrides[key] == null)
                    delete userConfig.propertyOverrides[key];
                else
                    userConfig.propertyOverrides[key] = values.propertyOverrides[key];
            }
        }

        if (values.tags) {
            userConfig.tags = values.tags;
        }

        fs.writeFileSync(userConfigPath, JSON.stringify(userConfig, null, 4));
    }

    areTagArraysEqual = (first: any[], second: any[]) => {
        let areEqual = true;
        if (first || second) {
            if (first && !second) {
                areEqual = false;
            }
            else if (second && !first) {
                areEqual = false;
            }
            else if (second.length != first.length) {
                areEqual = false;
            }
            else {
                for (let i = 0; i < first.length; i++) {
                    let foundTagMatch: boolean = false;
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
    }

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

    async LogError(msg: string, stack: string, values: any) {
        if (this.logger)
            await this.logger.LogError(msg, stack, values);
        else
            console.log(msg, stack, util.inspect(values, false, null));
    };

    async LogWarning(msg: string, values: any) {
        if (this.logger)
            await this.logger.LogWarning(msg, values);
        else
            console.log(msg, util.inspect(values, false, null));
    };

    async LogInfo(msg: string, values: any) {
        if (this.logger)
            await this.logger.LogInfo(msg, values);
        else
            console.log(msg, util.inspect(values, false, null));
    };

    async LogDebug(msg: string, values: any) {
        if (this.logger)
            await this.logger.LogDebug(msg, values);
        else
            console.log(msg, util.inspect(values, false, null));
    };

    async ConnectIPC() {
        return new Promise((resolve, reject) => {
            try {
                ipc.config.id = `sg-agent-proc-${this._teamId}`;
                ipc.config.retry = 1000;
                ipc.config.silent = true;
                ipc.config.maxRetries = 10;
                this.LogDebug(`Connecting to agent launcher`, {});
                ipc.connectTo('SGAgentLauncherProc', this.ipcPath, () => {
                    ipc.of.SGAgentLauncherProc.on('connect', async () => {
                        this.LogDebug(`Connected to agent launcher`, {});
                        resolve();
                    });
                    ipc.of.SGAgentLauncherProc.on('error', async () => {
                        this.LogError(`Error connecting to agent launcher - retrying`, '', {});
                    });
                    ipc.of.SGAgentLauncherProc.on('destroy', async () => {
                        if (!this.stopped)
                            this.LogError(`Failed to connect to agent launcher`, '', {});
                        // reject(new Error(`Failed to connect to agent launcher`));
                    });
                });
            } catch (e) {
                reject(e);
            }
        });
    }

    async SendMessageToAgentStub(params) {
        if (!this.runStandAlone) {
            return new Promise(async (resolve, reject) => {
                try {
                    this.LogDebug(`Sending message to agent launcher`, params);
                    await ipc.of.SGAgentLauncherProc.emit(`sg-agent-msg-${this._teamId}`, params);
                    resolve();
                } catch (e) {
                    reject(e);
                }
            });
        }
    }

    async SendDisconnectMessage() {
        try {
            const heartbeat_info: any = { machineId: this.MachineId(), ipAddress: SGUtils.getIpAddress(), offline: this.offline };

            await this.RestAPICall(`agent/heartbeat/${this.instanceId}`, 'PUT', null, heartbeat_info);
        } catch (e) {
            this.LogError(`Error sending disconnect message`, e.stack, { error: e.toString() });
        }
    }

    async RemoveFolder(path: string, retryCount: number) {
        try {
            if (fs.existsSync(path)) {
                fse.removeSync(path);
            }
        } catch(err) {
            retryCount += 1;
            if (retryCount > 10) {
                this.LogWarning(`Error removing folder`, { path, error: err.toString() });
            } else {
                setTimeout(() => { this.RemoveFolder(path, retryCount); }, 1000);
            }
        }
    }

    async SendHeartbeat(forceGetSysInfo: boolean = false, once: boolean = false) {
        try {
            if (this.stopped)
                return;

            const heartbeat_info: any = { machineId: this.MachineId(), ipAddress: SGUtils.getIpAddress(), reportedVersion: version, lastHeartbeatTime: new Date().getTime(), numActiveTasks: this.numActiveTasks, timezone: this.timezone, offline: this.offline };
            // console.log(`SendHeartbeat -> ${JSON.stringify(heartbeat_info)}`);
            if (this.trackSysInfo || forceGetSysInfo) {
                const sysInfo = await this.GetSysInfo();
                heartbeat_info['sysInfo'] = sysInfo;
            }

            let cron: any;
            if ((process.platform.indexOf('darwin') >= 0) || (process.platform.indexOf('linux') >= 0)) {
                cron = await this.GetCronTab();
                if (cron && cron.stdout) {
                    heartbeat_info.cron = cron.stdout;
                }
            }

            try {
                let ret: any = await this.RestAPICall(`agent/heartbeat/${this.instanceId}`, 'PUT', null, heartbeat_info);

                if (ret.tasksToCancel) {
                    this.LogDebug('Received tasks to cancel from heartbeat', { 'tasksToCancel': JSON.stringify(ret.tasksToCancel, null, 4) });
                    for (let i = 0; i < ret.tasksToCancel.length; i++) {
                        const taskToCancel = ret.tasksToCancel[i];
                        const procToCancel = runningProcesses[taskToCancel];
                        if (procToCancel && typeof (procToCancel) == 'object' && procToCancel.pid) {
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
                setTimeout(() => { this.SendHeartbeat(); }, this.heartbeatInterval);
        } catch (e) {
            if (!this.stopped) {
                this.LogError(`Error sending heartbeat`, '', {error: e});
                if (!once)
                    setTimeout(() => { this.SendHeartbeat(); }, this.heartbeatInterval);
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
                        this.LogDebug('Running inactive agent job', { 'inactiveAgentJob': this.inactiveAgentJob });

                        let runtimeVars: any = {};
                        if (this.inactiveAgentJob.runtimeVars)
                            Object.assign(runtimeVars, this.inactiveAgentJob.runtimeVars);
                        runtimeVars._agentId = this.InstanceId();

                        let data = {
                            name: `Inactive agent job - ${this.MachineId()}`,
                            runtimeVars,
                            createdBy: this.MachineId()
                        };

                        await this.RestAPICall(`job`, 'POST', { _jobDefId: this.inactiveAgentJob.id }, data);
                    } catch (e) {
                        this.LogError('Error running inactive agent job', e.stack, { inactiveAgentJob: this.inactiveAgentJob, error: e.toString() });
                    }
                }
            }
            if (!this.stopped)
                setTimeout(() => { this.CheckInactiveTime(); }, 1000);
        } catch (e) {
            if (!this.stopped)
                throw e;
        }
    }

    async SendCompleteMessages() {
        // this.LogDebug('Checking message queue', {});
        while (this.queueCompleteMessages.length > 0) {
            const msg: any = this.queueCompleteMessages.shift();
            try {
                // this.LogDebug('Sending queued message', { 'request': msg });
                await this.RestAPICall(msg.url, msg.method, msg.headers, msg.data);
                // this.queueCompleteMessages.shift();
                // this.LogDebug('Sent queued message', { 'request': msg });
            } catch (e) {
                if (!this.stopped) {
                    if (e.response && e.response.data && e.response.data.statusCode) {
                        this.LogError(`Error sending complete message`, e.stack, { request: msg, response: e.response.data, error: e.toString() });
                        // this.queueCompleteMessages.shift();
                    } else {
                        this.LogError(`Error sending complete message`, e.stack, { request: msg, error: e.toString() });
                        this.queueCompleteMessages.unshift(msg);
                        await SGUtils.sleep(10000);
                    }
                } else {
                    break;
                }
            }
        }
        setTimeout(() => { this.SendCompleteMessages(); }, 1000);
    }

    ExtractRuntimeVarsFromString(line: string) {
        let runtimeVars: any = {};
        let arrParams: string[] = line.match(/@sgo?(\{[^}]*\})/g);
        if (arrParams) {
            for (let i = 0; i < arrParams.length; i++) {
                try {
                    runtimeVars = Object.assign(runtimeVars, JSON.parse(arrParams[i].substring(4)));
                } catch (e) {
                    try {
                        if (e.message.indexOf('Unexpected token \\') >= 0) {
                            let newVal = arrParams[i].substring(4).replace(/\\+"/g, '"');
                            runtimeVars = Object.assign(runtimeVars, JSON.parse(newVal));
                        } else {
                            const re = /{['"]?([\w-]+)['"]?:[ '"]+([^,'"]+)['"]}/g;
                            const s = arrParams[i].substring(4);
                            let m;
                            while ((m = re.exec(s)) != null) {
                                const key = m[1].trim();
                                const val = m[2].trim();
                                runtimeVars[key] = val;
                            }
                        }
                    } catch (se) { }
                }
            }
        }

        return runtimeVars;
    }

    async ParseScriptStdout(filePath: string, saveOutput: boolean, stdoutBytesAlreadyProcessed: number = 0, stdoutTruncated: boolean = false) {
        let appInst = this;
        return new Promise((resolve, reject) => {
            try {
                let lineCount = 0;
                let bytesRead: number = 0;

                let output: string = '';
                let runtimeVars: any = {};
                let lastXLines: string[] = [];
                let s = fs.createReadStream(filePath)
                    .pipe(es.split())
                    .pipe(es.mapSync(function (line) {

                        // pause the readstream
                        s.pause();

                        lineCount += 1;
                        if (saveOutput && line) {
                            const strLenBytes = Buffer.byteLength(line, 'utf8');
                            bytesRead += strLenBytes;
                            if (bytesRead > stdoutBytesAlreadyProcessed) {
                                if (!stdoutTruncated) {
                                    if (strLenBytes + stdoutBytesAlreadyProcessed < appInst.maxStdoutSize) {
                                        output += `${line}\n`;
                                        stdoutBytesAlreadyProcessed += strLenBytes;
                                    } else {
                                        output = truncate(output, appInst.maxStdoutSize) + '\n(truncated)\n';
                                        stdoutTruncated = true;
                                    }
                                }

                                if (strLenBytes > appInst.maxSizeLineInTail)
                                    line = truncate(line, appInst.maxSizeLineInTail) + ' (truncated)';
                                lastXLines.push(line);
                                if (lastXLines.length > appInst.numLinesInTail)
                                    lastXLines.shift();
                            }
                        }

                        const rtv = appInst.ExtractRuntimeVarsFromString(line);
                        Object.assign(runtimeVars, rtv);

                        // resume the readstream
                        s.resume();
                    })
                        .on('error', function (err) {
                            reject(new Error(`Error reading stdout file '${filePath}' on line ${lineCount}: ${err}`));
                        })
                        .on('end', function () {
                            if (stdoutTruncated)
                                output += '\n' + lastXLines.join('\n');
                            resolve({ 'output': output, 'runtimeVars': runtimeVars, 'lastXLines': lastXLines });
                        })
                    );
            } catch (e) {
                reject(e);
            }
        });
    }

    async ParseScriptStderr(filePath: string) {
        let appInst = this;
        return new Promise((resolve, reject) => {
            try {
                let lineCount = 0;

                let output: string = '';
                let s = fs.createReadStream(filePath)
                    .pipe(es.split())
                    .pipe(es.mapSync(function (line) {

                        // pause the readstream
                        s.pause();

                        lineCount += 1;
                        if (line) {
                            if (Buffer.byteLength(output, 'utf8') < appInst.maxStderrSize) {
                                output += `${line}\n`;
                                if (Buffer.byteLength(output, 'utf8') > appInst.maxStderrSize)
                                    output = truncate(output, appInst.maxStderrSize) + ' (truncated)';
                            }
                        }

                        // resume the readstream
                        s.resume();
                    })
                        .on('error', function (err) {
                            reject(new Error(`Error reading stderr file '${filePath}' on line ${lineCount}: ${err}`));
                        })
                        .on('end', function () {
                            resolve({ 'output': output });
                        })
                    );
            } catch (e) {
                reject(e);
            }
        });
    }

    GetSysInfo = async () => {
        let sysInfo: any = {};
        let procs = await sysinfo.processes();
        procs.list = procs.list.sort((a, b) => { return b.pcpu - a.pcpu; }).slice(0, 10);
        let osInfo = await sysinfo.osInfo();
        let cpuCurrentspeed = await sysinfo.cpuCurrentspeed();
        let cpuTemperature = await sysinfo.cpuTemperature();
        let currentLoad = await sysinfo.currentLoad();
        let fsSize = await sysinfo.fsSize();
        let networkConnections = await sysinfo.networkConnections();
        let users = await sysinfo.users();
        let mem = await sysinfo.mem();
        let battery = await sysinfo.battery();
        let inetLatency = await sysinfo.inetLatency();
        let networkStats = await sysinfo.networkStats();

        let fsStats = null;
        let disksIO = null;
        if ((process.platform.indexOf('darwin') >= 0) || (process.platform.indexOf('linux') >= 0)) {
            fsStats = await sysinfo.fsStats();
            disksIO = await sysinfo.disksIO();
        }

        Object.assign(sysInfo,
            { osInfo: osInfo },
            { time: sysinfo.time() },
            { cpuCurrentspeed: cpuCurrentspeed },
            { cpuTemperature: cpuTemperature },
            { currentLoad: currentLoad },
            { mem: mem },
            { fsSize: fsSize },
            { inetLatency: inetLatency },
            { networkStats: networkStats },
            { processes: procs },
            { networkConnections: networkConnections },
            { users: users },
            { battery: battery }
        );

        if (fsStats)
            Object.assign(sysInfo, { fsStats: fsStats });
        if (disksIO)
            Object.assign(sysInfo, { disksIO: disksIO });

        return sysInfo;
    }

    RunningTailHandler = async (params: any) => {
        /// process queued tail messages
        while (true) {
            if (params.queueTail.length < 1) {
                if (params.procFinished) {
                    break;
                }
                if (!(params.taskOutcomeId in runningProcesses)) {
                    break;
                }
                for (let i = 0; i < params.appInst.sendUpdatesInterval / 10; i++) {
                    await SGUtils.sleep(params.appInst.sendUpdatesInterval / 10);
                    if (params.procFinished)
                        break;
                }
                continue;
            }

            let data: any[] = params.queueTail.splice(0);
            try {
                let dataStrings: string[] = data.map((m) => m.message);
                let dataAsString = dataStrings.join('');
                const rtv = params.appInst.ExtractRuntimeVarsFromString(dataAsString);
                let rtvUpdates = {};
                for (let indexRTV = 0; indexRTV < Object.keys(rtv).length; indexRTV++) {
                    let key = Object.keys(rtv)[indexRTV];
                    if (!params.rtvCumulative[key] || (params.rtvCumulative[key] != rtv[key])) {
                        rtvUpdates[key] = rtv[key];
                        params.rtvCumulative[key] = rtv[key];
                    }
                }

                for (let i = 0; i < data.length; i++) {
                    const msg = data[i].message;
                    if (msg.startsWith('REPORT ')) {
                        const elems: string[] = msg.split('\t');
                        for (let j = 0; j < elems.length; j++) {
                            const elem: string = elems[j];
                            if (elem.startsWith('Duration: ')) {
                                try {
                                    params.sgcDuration = Number(elem.split(':').slice(1,3).join(' ').trim().split(' ')[0]);
                                } catch (err) {}
                            } else if (elem.startsWith('Billed Duration: ')) {
                                try {
                                    params.sgcBilledDuration = Number(elem.split(':').slice(1,3).join(' ').trim().split(' ')[0]);
                                } catch (err) {}        
                            } else if (elem.startsWith('Memory Size: ')) {
                                try {
                                    params.sgcMemSize = Number(elem.split(':').slice(1,3).join(' ').trim().split(' ')[0]);
                                } catch (err) {}        
                            } else if (elem.startsWith('Max Memory Used: ')) {
                                try {
                                    params.sgcMaxMemUsed = Number(elem.split(':').slice(1,3).join(' ').trim().split(' ')[0]);
                                } catch (err) {}        
                            } else if (elem.startsWith('Init Duration: ')) {
                                try {
                                    params.sgcInitDuration = Number(elem.split(':').slice(1,3).join(' ').trim().split(' ')[0]);
                                } catch (err) { }
                            }
                        }
                    }
                }

                if (Object.keys(rtvUpdates).length > 0) {
                    // console.log(`****************** taskOutcomeId -> ${params.taskOutcomeId}, runtimeVars -> ${JSON.stringify(rtvUpdates)}`);
                    params.appInst.queueCompleteMessages.push({ url: `taskOutcome/${params.taskOutcomeId}`, method: 'PUT', headers: null, data: { _teamId: params._teamId, runtimeVars: rtvUpdates } });
                }

                params.lastXLines = params.lastXLines.concat(dataStrings).slice(-params.appInst.numLinesInTail);
                for (let i = 0; i < params.lastXLines.length; i++) {
                    if (Buffer.byteLength(params.lastXLines[i], 'utf8') > params.appInst.maxSizeLineInTail)
                    params.lastXLines[i] = truncate(params.lastXLines[i], params.appInst.maxSizeLineInTail) + ' (truncated)';
                }

                while (true) {
                    if (dataStrings.length < 1)
                        break;

                    let stdoutToUpload: string = '';
                    let countLinesToUpload: number = 0;
                    if (!params.stdoutTruncated) {
                        const maxStdoutUploadSize: number = 51200;
                        let stdoutBytesProcessedLocal: number = 0;
                        for (let i = 0; i < dataStrings.length; i++) {
                            const strLenBytes = Buffer.byteLength(dataStrings[i], 'utf8');
                            if (params.stdoutBytesProcessed + strLenBytes > params.appInst.maxStdoutSize) {
                                stdoutToUpload += '\n(max stdout size exceeded - results truncated)\n';
                                params.stdoutTruncated = true;
                                break;
                            }
                            if (stdoutBytesProcessedLocal + strLenBytes > maxStdoutUploadSize) {
                                break;
                            }
                            stdoutToUpload += `${dataStrings[i]}\n`;
                            params.stdoutBytesProcessed += strLenBytes;
                            stdoutBytesProcessedLocal += strLenBytes;
                            countLinesToUpload += 1;
                        }
                    }

                    dataStrings.splice(0, countLinesToUpload);

                    // console.log('================== -> ', new Date().toISOString(), ', lastUpdateTime -> ', new Date(lastUpdateTime).toISOString(), ', sendUpdatesInterval -> ', appInst.sendUpdatesInterval);
                    // console.log('sending step update -> ', new Date().toISOString(), ', lines -> ', tmpXLines, ', updateId -> ', updateId, ' -> ', new Date().toISOString());
                    const updates: any = { _teamId: params._teamId, tail: params.lastXLines, stdout: stdoutToUpload, status: Enums.StepStatus.RUNNING, lastUpdateId: params.updateId };
                    params.updateId += 1;
                    await params.appInst.RestAPICall(`stepOutcome/${params.stepOutcomeId}`, 'PUT', null, updates);

                    if (params.stdoutTruncated)
                        break;
                }
            } catch (err) {
                this.LogError(`Error handling stdout tail`, err.stack, { error: err.toString() });
                await SGUtils.sleep(1000);
            }
        }
        params.stdoutAnalysisFinished = true;
    }

    RunStepAsync_Lambda = async (step: StepSchema, workingDirectory: string, task: TaskSchema, stepOutcomeId: mongodb.ObjectId, lastUpdatedId: number, taskOutcomeId: mongodb.ObjectId) => {
        const appInst = this;
        return new Promise(async (resolve, reject) => {
            let error = '';
            try {
                let lambdaFileLoadedToSGAWS: boolean = false;
                let updateId = lastUpdatedId + 1;
                let lastXLines: string[] = [];
                let rtvCumulative: any = {};
                let queueTail: any[] = [];
                let procFinished: boolean = false;
                let stdoutAnalysisFinished: boolean = false;
                let stdoutBytesProcessed: number = 0;
                let stdoutTruncated: boolean = false;
                let _teamId: string = step._teamId;
                let runLambdaFinished: boolean = false;
                let sgcDuration: string = undefined;
                let sgcBilledDuration: string = undefined;
                let sgcMemSize: string = undefined;
                let sgcMaxMemUsed: string = undefined;
                let sgcInitDuration: string = undefined;
                let runParams: any = { queueTail, procFinished, taskOutcomeId, appInst, rtvCumulative, lastXLines, stdoutTruncated, stdoutBytesProcessed, updateId, stepOutcomeId, stdoutAnalysisFinished, _teamId, runLambdaFinished, sgcDuration, sgcBilledDuration, sgcMemSize, sgcMaxMemUsed, sgcInitDuration };

                const stdoutFileName = workingDirectory + path.sep + SGUtils.makeid(10) + '.out';
                const out = fs.openSync(stdoutFileName, 'w');
                
                let lambdaCode: any = {};
                let zipFilePath: string = '';
                let handler: string = '';
                if (!(step.lambdaZipfile)) {
                    let msg: string = `${new Date().toISOString()} Creating saas glue compute function\n`;
                    runParams.lastXLines.push(msg);
                    const updates: any = { _teamId: runParams._teamId, tail: runParams.lastXLines, stdout: msg, status: Enums.StepStatus.RUNNING, lastUpdateId: runParams.updateId };
                    await appInst.RestAPICall(`stepOutcome/${runParams.stepOutcomeId}`, 'PUT', null, updates);
                    runParams.updateId += 1;

                    if (step.lambdaRuntime.toLowerCase().startsWith('node')) {
                        zipFilePath = (<string>await SGUtils.CreateAWSLambdaZipFile_NodeJS(workingDirectory, SGUtils.atob(step.script.code), step.lambdaDependencies, task.id));
                        const zipContents = fs.readFileSync(zipFilePath);
                        lambdaCode.ZipFile = zipContents;
                        handler = 'index.handler';
                    } else if (step.lambdaRuntime.toLowerCase().startsWith('python')) {
                        zipFilePath = (<string>await SGUtils.CreateAWSLambdaZipFile_Python(workingDirectory, SGUtils.atob(step.script.code), step.lambdaDependencies, task.id));
                        const zipContents = fs.readFileSync(zipFilePath);
                        lambdaCode.ZipFile = zipContents;
                        handler = 'lambda_function.lambda_handler';
                    } else if (step.lambdaRuntime.toLowerCase().startsWith('ruby')) {
                        zipFilePath = (<string>await SGUtils.CreateAWSLambdaZipFile_Ruby(workingDirectory, SGUtils.atob(step.script.code), step.lambdaDependencies, task.id));
                        const zipContents = fs.readFileSync(zipFilePath);
                        lambdaCode.ZipFile = zipContents;
                        handler = 'lambda_function.lambda_handler';
                    } else {
                        appInst.LogError(`Unsupported lambda runtime`, '', { step });
                        throw new Error('Unsupported lambda runtime');
                    }
                    const zipFileSizeMB: number = fs.statSync(zipFilePath).size / 1024.0 / 1024.0;
                    if (zipFileSizeMB > 0) {
                        let s3Path = `lambda/${task.id}`;
                        let res: any = await SGUtils.RunCommand(`aws s3 cp ${zipFilePath} s3://${step.s3Bucket}/${s3Path}`, {})
                        if (res.stderr != '' || res.code != 0) {
                            appInst.LogError(`Error loading large lambda function to S3`, '', { stderr: res.stderr, stdout: res.stdout, code: res.code});
                            throw new Error (`Error loading lambda function`);
                        }
                        lambdaCode.S3Bucket = step.s3Bucket;
                        lambdaCode.S3Key = s3Path;
                        delete lambdaCode.ZipFile;
                        lambdaFileLoadedToSGAWS = true;
                    }
                } else {
                    let artifact: any = await this.RestAPICall(`artifact/${step.lambdaZipfile}`, 'GET', null, { _teamId });
                    lambdaCode.S3Bucket = step.s3Bucket;

                    let s3Path = '';
                    if (appInst.env != 'production') {
                        if (appInst.env == 'unittest')
                            s3Path += `debug/`;
                        else
                            s3Path += `${appInst.env}/`;
                    }
                    s3Path += `${_teamId}/`;
            
                    if (artifact.prefix)
                        s3Path += `${artifact.prefix}`;
                    s3Path += artifact.name;

                    lambdaCode.S3Key = s3Path;
                    handler = step.lambdaFunctionHandler;
                }

                await SGUtils.CreateAWSLambda(task._teamId, task._jobId, step.lambdaRole, task.id, lambdaCode, step.lambdaRuntime, step.lambdaMemorySize, step.lambdaTimeout, step.lambdaAWSRegion, handler);

                if (zipFilePath) {
                    try { if (fs.existsSync(zipFilePath)) fs.unlinkSync(zipFilePath); } catch (e) { }
                }

                let msg: string = `${new Date().toISOString()} Running saas glue compute function\n`;
                runParams.lastXLines.push(msg);
                const updates: any = { _teamId: runParams._teamId, tail: runParams.lastXLines, stdout: msg, status: Enums.StepStatus.RUNNING, lastUpdateId: runParams.updateId };
                await appInst.RestAPICall(`stepOutcome/${runParams.stepOutcomeId}`, 'PUT', null, updates);
                runParams.updateId += 1;

                let payload = {};
                if (step.variables)
                    payload = Object.assign(payload, step.variables);
                runningProcesses[runParams.taskOutcomeId] = 'no requestId yet';
                let runLambdaError: any;
                let runLambdaResult: any;
                SGUtils.RunAWSLambda(task.id, step.lambdaAWSRegion, payload, (err, data) => {
                    if (err) {
                        runLambdaError = err;
                        runParams.runLambdaFinished = true;
                    }
                    if (data) {
                        runLambdaResult = data;
                    }
                });

                appInst.RunningTailHandler(runParams);

                await SGUtils.GetCloudWatchLogsEvents(task.id, runParams, appInst.logger, (msgs) => {
                    for (let i = 0; i < msgs.length; i++) {
                        if (msgs[i].message.startsWith('START')) {
                            const requestId = msgs[i].message.split(' ')[2]
                            runningProcesses[runParams.taskOutcomeId] = `lambda ${requestId}`;
                        } else {
                            let msg = msgs[i].message.split('\t');
                            if (msg.length > 2) {
                                if (msg[2] == 'ERROR') {
                                    error = msg;
                                    if (msg.length > 4) {
                                        const jmsg = JSON.parse(msg[4]);
                                        if ('stack' in jmsg)
                                            error += (jmsg.stack + '\n');
                                    }
                                }
                            }
                        }
                        runParams.queueTail.push(msgs[i]);
                    }

                    fs.writeSync(out, msgs.map((m) => m.message).join('\n'));
                });

                runParams.procFinished = true;

                await SGUtils.sleep(100);
                while (!runParams.stdoutAnalysisFinished)
                    await SGUtils.sleep(100);

                fs.closeSync(out);

                if (runLambdaError) {
                    appInst.LogError(runLambdaError.message, runLambdaError.stack, runLambdaError);
                    error = 'Unknown error occurred running lambda function';
                }
                if (runLambdaResult) {
                    if (runLambdaResult.FunctionError && runLambdaResult.Payload) {
                        let payload = JSON.parse(runLambdaResult.Payload);
                        error = `errorType: ${payload.errorType} - errorMessage: ${payload.errorMessage} - stackTrace: ${payload.stackTrace}\n${error}`;
                    }
                }

                let parseStdoutResult: any = {};
                if (fs.existsSync(stdoutFileName)) {
                    parseStdoutResult = await this.ParseScriptStdout(stdoutFileName, true, runParams.stdoutBytesProcessed, runParams.stdoutTruncated);
                    runParams.lastXLines = runParams.lastXLines.concat(parseStdoutResult.lastXLines).slice(-appInst.numLinesInTail);
                } else {
                    parseStdoutResult.output = '';
                    parseStdoutResult.runtimeVars = {};
                }

                let runtimeVars: any = {};
                Object.assign(runtimeVars, parseStdoutResult.runtimeVars)

                let outParams: any = { sgcDuration: runParams.sgcDuration, sgcBilledDuration: runParams.sgcBilledDuration, sgcMemSize: runParams.sgcMemSize, sgcMaxMemUsed: runParams.sgcMaxMemUsed, sgcInitDuration: runParams.sgcInitDuration };
                let code;
                if (error == '') {
                    code = 0;
                    outParams[SGStrings.status] = Enums.StepStatus.SUCCEEDED;
                } else {
                    code = -1;
                    runtimeVars['route'] = 'fail';
                    outParams[SGStrings.status] = Enums.StepStatus.FAILED;
                    outParams['failureCode'] = Enums.TaskFailureCode.TASK_EXEC_ERROR;
                }

                outParams['runtimeVars'] = runtimeVars;
                outParams['dateCompleted'] = new Date().toISOString();
                outParams['stdout'] = parseStdoutResult.output;
                outParams['tail'] = runParams.lastXLines;
                outParams['stderr'] = error;
                outParams['exitCode'] = code;
                outParams['lastUpdateId'] = runParams.updateId + 1;
                outParams['_teamId'] = _teamId;

                await SGUtils.DeleteAWSLambda(task.id, step.lambdaAWSRegion);
                await SGUtils.DeleteCloudWatchLogsEvents(task.id);
                if (lambdaFileLoadedToSGAWS) {
                    await SGUtils.RunCommand(`aws s3 rm s3://${lambdaCode.S3Bucket}/${lambdaCode.S3Key}`, {})
                }
                resolve(outParams);
            } catch (e) {
                this.LogError('Error in RunStepAsync_Lambda', e.stack, { error: e.toString() });
                await SGUtils.sleep(1000);
                error += (e.message + '\n');
                resolve({ 'status': Enums.StepStatus.FAILED, 'code': -1, 'route': 'fail', 'stderr': error, 'failureCode': TaskFailureCode.AGENT_EXEC_ERROR });
            }
        })
    }

    RunStepAsync = async (step: StepSchema, workingDirectory: string, task: TaskSchema, stepOutcomeId: mongodb.ObjectId, lastUpdatedId: number, taskOutcomeId: mongodb.ObjectId) => {
        const appInst = this;
        return new Promise(async (resolve, reject) => {
            try {
                let script = step.script;

                let scriptFileName = workingDirectory + path.sep + SGUtils.makeid(10);

                if (script.scriptType == Enums.ScriptType.NODE) {
                    scriptFileName += '.js';
                } else if (script.scriptType == Enums.ScriptType.PYTHON) {
                    scriptFileName += '.py';
                } else if (script.scriptType == Enums.ScriptType.SH) {
                    scriptFileName += '.sh';
                } else if (script.scriptType == Enums.ScriptType.CMD) {
                    scriptFileName += '.bat';
                } else if (script.scriptType == Enums.ScriptType.RUBY) {
                    scriptFileName += '.rb';
                } else if (script.scriptType == Enums.ScriptType.LUA) {
                    scriptFileName += '.lua';
                } else if (script.scriptType == Enums.ScriptType.PERL) {
                    scriptFileName += '.pl';
                } else if (script.scriptType == Enums.ScriptType.PHP) {
                    scriptFileName += '.php';
                } else if (script.scriptType == Enums.ScriptType.POWERSHELL) {
                    scriptFileName += '.ps1';
                }

                // console.log('script -> ', JSON.stringify(script, null, 4));
                fs.writeFileSync(scriptFileName, SGUtils.atob(script.code));

                if (script.scriptType == Enums.ScriptType.SH) {
                    await new Promise(async (resolve, reject) => {
                        fs.chmod(scriptFileName, 0o0755, ((err) => {
                            if (err) reject(err);
                            resolve();
                        }));
                    });
                }

                let commandString = '';
                if (step.command) {
                    commandString = step.command.trim() + ' ';
                } else {
                    if ((script.scriptType != Enums.ScriptType.CMD) && (script.scriptType != Enums.ScriptType.SH)) {
                        commandString += `${Enums.ScriptTypeDetails[Enums.ScriptType[script.scriptType.toString()]].cmd} `;
                    }
                }
                commandString += scriptFileName;
                if (step.arguments)
                    commandString += ` ${step.arguments}`;

                const stdoutFileName = workingDirectory + path.sep + SGUtils.makeid(10) + '.out';
                const stderrFileName = workingDirectory + path.sep + SGUtils.makeid(10) + '.err';

                const out = fs.openSync(stdoutFileName, 'w');
                const err = fs.openSync(stderrFileName, 'w');

                let updateId = lastUpdatedId + 1;
                let lastXLines: string[] = [];
                let rtvCumulative: any = {};
                let queueTail: any[] = [];
                let procFinished: boolean = false;
                let stdoutAnalysisFinished: boolean = false;
                let stdoutBytesProcessed: number = 0;
                let stdoutTruncated: boolean = false;

                /// tail the stdout
                let tail = new Tail(stdoutFileName, { useWatchFile: true, flushAtEOF: true });
                tail.on('line', async (data) => {
                    if (process.platform.indexOf('win') != 0)
                        try { if (fs.existsSync(scriptFileName)) fs.unlinkSync(scriptFileName); } catch (e) { }
                    queueTail.push(data);
                });

                tail.on("error", function (error) {
                    this.LogError('Error tailing stdout file', error.stack, { error: error.toString() });
                });

                let env: any = Object.assign({}, process.env);
                if (step.variables)
                    env = Object.assign(env, step.variables);
                env.sgAgentId = this.InstanceId();

                let cmd = spawn(commandString, [], { stdio: ['ignore', out, err], shell: true, detached: false, env: env, cwd: workingDirectory });
    
                runningProcesses[taskOutcomeId] = cmd;

                /// called if there is an error running the script
                cmd.on('error', (err) => {
                    try {
                        try { if (fs.existsSync(scriptFileName)) fs.unlinkSync(scriptFileName); } catch (e) { }

                        // console.log('error: ' + err);
                        this.LogError(`Error running script`, '', { error: err.toString() });
                        resolve({ 'status': Enums.StepStatus.FAILED, 'code': -1, 'route': 'fail', 'stderr': err, 'failureCode': TaskFailureCode.AGENT_EXEC_ERROR });
                    } catch (e) {
                        this.LogError('Error handling error event', e.stack, { error: e.message });
                    }
                });

                /// called when external process completes
                cmd.on('exit', async (code, signal) => {
                    try {
                        try { if (fs.existsSync(scriptFileName)) fs.unlinkSync(scriptFileName); } catch (e) { }

                        fs.closeSync(out);
                        fs.closeSync(err);

                        procFinished = true;
                        tail.unwatch();

                        await SGUtils.sleep(100);
                        while (!stdoutAnalysisFinished)
                            await SGUtils.sleep(100);

                        let parseStdoutResult: any = {};
                        if (fs.existsSync(stdoutFileName)) {
                            parseStdoutResult = await this.ParseScriptStdout(stdoutFileName, true, stdoutBytesProcessed, stdoutTruncated);
                            lastXLines = lastXLines.concat(parseStdoutResult.lastXLines).slice(-appInst.numLinesInTail);
                        } else {
                            parseStdoutResult.output = '';
                            parseStdoutResult.runtimeVars = {};
                        }

                        let parseStderrResult: any = {};
                        if (fs.existsSync(stderrFileName)) {
                            parseStderrResult = await this.ParseScriptStderr(stderrFileName);
                        } else {
                            parseStderrResult.output = '';
                        }

                        let runtimeVars: any = {};
                        let match: string[] = [];
                        while ((match = regexStdoutRedirectFiles.exec(step.arguments)) !== null) {
                            const fileName = match[1];
                            let parseResult: any = {};
                            parseResult = await this.ParseScriptStdout(workingDirectory + path.sep + fileName, false);
                            Object.assign(runtimeVars, parseResult.runtimeVars)
                        }

                        Object.assign(runtimeVars, parseStdoutResult.runtimeVars)

                        let outParams: any = {};
                        if (code == 0) {
                            outParams[SGStrings.status] = Enums.StepStatus.SUCCEEDED;
                        } else {
                            if (signal == 'SIGTERM' || signal == 'SIGINT' || this.mainProcessInterrupted) {
                                runtimeVars['route'] = 'interrupt';
                                outParams[SGStrings.status] = Enums.StepStatus.INTERRUPTED;
                            } else {
                                runtimeVars['route'] = 'fail';
                                outParams[SGStrings.status] = Enums.StepStatus.FAILED;
                                outParams['failureCode'] = Enums.TaskFailureCode.TASK_EXEC_ERROR;
                            }
                        }

                        outParams['signal'] = signal;
                        outParams['runtimeVars'] = runtimeVars;
                        outParams['dateCompleted'] = new Date().toISOString();
                        outParams['stdout'] = parseStdoutResult.output;
                        outParams['tail'] = lastXLines;
                        outParams['stderr'] = parseStderrResult.output;
                        outParams['exitCode'] = code;
                        outParams['lastUpdateId'] = updateId;

                        resolve(outParams);
                    } catch (e) {
                        this.LogError('Error handling script exit', e.stack, { error: e.toString() });
                        resolve({ 'status': Enums.StepStatus.FAILED, 'code': -1, 'route': 'fail', 'stderr': JSON.stringify(e), 'failureCode': TaskFailureCode.AGENT_EXEC_ERROR });
                    }
                });

                /// process queued tail messages
                while (true) {
                    if (queueTail.length < 1) {
                        if (procFinished) {
                            break;
                        }
                        if (!(taskOutcomeId in runningProcesses)) {
                            break;
                        }
                        for (let i = 0; i < appInst.sendUpdatesInterval / 1000; i++) {
                            await SGUtils.sleep(1000);
                            if (procFinished)
                                break;
                        }
                        continue;
                    }

                    let data: string[] = queueTail.splice(0);
                    try {
                        let dataAsString = data.join('\n');
                        if (!(task.target & (TaskDefTarget.ALL_AGENTS | TaskDefTarget.ALL_AGENTS_WITH_TAGS))) {
                            const rtv = appInst.ExtractRuntimeVarsFromString(dataAsString);
                            let rtvUpdates = {};
                            for (let indexRTV = 0; indexRTV < Object.keys(rtv).length; indexRTV++) {
                                let key = Object.keys(rtv)[indexRTV];
                                if (!rtvCumulative[key] || (rtvCumulative[key] != rtv[key])) {
                                    rtvUpdates[key] = rtv[key];
                                    rtvCumulative[key] = rtv[key];
                                }
                            }

                            if (Object.keys(rtvUpdates).length > 0) {
                                // console.log(`****************** taskOutcomeId -> ${taskOutcomeId}`);
                                await appInst.RestAPICall(`taskOutcome/${taskOutcomeId}`, 'PUT', null, { runtimeVars: rtvUpdates });
                            }
                        }

                        lastXLines = lastXLines.concat(data).slice(-appInst.numLinesInTail);
                        for (let i = 0; i < lastXLines.length; i++) {
                            if (Buffer.byteLength(lastXLines[i], 'utf8') > appInst.maxSizeLineInTail)
                                lastXLines[i] = truncate(lastXLines[i], appInst.maxSizeLineInTail) + ' (truncated)';
                        }

                        while (true) {
                            if (data.length < 1)
                                break;

                            let stdoutToUpload: string = '';
                            let countLinesToUpload: number = 0;
                            if (!stdoutTruncated) {
                                const maxStdoutUploadSize: number = 51200;
                                let stdoutBytesProcessedLocal: number = 0;
                                for (let i = 0; i < data.length; i++) {
                                    const strLenBytes = Buffer.byteLength(data[i], 'utf8');
                                    if (stdoutBytesProcessed + strLenBytes > appInst.maxStdoutSize) {
                                        stdoutToUpload += '\n(max stdout size exceeded - results truncated)\n';
                                        stdoutTruncated = true;
                                        break;
                                    }
                                    if (stdoutBytesProcessedLocal + strLenBytes > maxStdoutUploadSize) {
                                        break;
                                    }
                                    stdoutToUpload += `${data[i]}\n`;
                                    stdoutBytesProcessed += strLenBytes;
                                    stdoutBytesProcessedLocal += strLenBytes;
                                    countLinesToUpload += 1;
                                }
                            }

                            data.splice(0, countLinesToUpload);

                            // console.log('================== -> ', new Date().toISOString(), ', lastUpdateTime -> ', new Date(lastUpdateTime).toISOString(), ', sendUpdatesInterval -> ', appInst.sendUpdatesInterval);
                            // console.log('sending step update -> ', new Date().toISOString(), ', lines -> ', tmpXLines, ', updateId -> ', updateId, ' -> ', new Date().toISOString());
                            const updates: any = { tail: lastXLines, stdout: stdoutToUpload, status: Enums.StepStatus.RUNNING, lastUpdateId: updateId };
                            updateId += 1;
                            await appInst.RestAPICall(`stepOutcome/${stepOutcomeId}`, 'PUT', null, updates);

                            if (stdoutTruncated)
                                break;
                        }
                    } catch (err) {
                        this.LogError(`Error handling stdout tail`, err.stack, { error: err.toString() });
                        await SGUtils.sleep(1000);
                    }
                }
                stdoutAnalysisFinished = true;
            } catch (e) {
                this.LogError('Error in RunStepAsync', e.stack, { error: e.toString() });
                await SGUtils.sleep(1000);
                resolve({ 'status': Enums.StepStatus.FAILED, 'code': -1, 'route': 'fail', 'stderr': e.message, 'failureCode': TaskFailureCode.AGENT_EXEC_ERROR });
            }
        })
    }

    RunTask = async (task: TaskSchema) => {
        // this.LogDebug('Running task', { 'id': task.id });
        // console.log('Agent -> RunTask -> task -> ', util.inspect(task, false, null));
        let dateStarted = new Date().toISOString();

        let workingDirectory = process.cwd() + path.sep + SGUtils.makeid(10);

        if (!fs.existsSync(workingDirectory))
            fs.mkdirSync(workingDirectory);

        let artifactsDownloadedSize: number = 0;
        if (task.artifacts) {
            for (let i = 0; i < task.artifacts.length; i++) {
                let artifactSize: number = 0;
                try {
                    artifactSize = (<number>await this.GetArtifact(task.artifacts[i], workingDirectory, this._teamId));
                } catch (err) {
                    this.LogError('Error in RunTask: ' + err.message, err.stack, task.artifacts[i]);
                }
                artifactsDownloadedSize += artifactSize;
            }
        }

        let allStepsCompleted = true;

        let stepsAsc: StepSchema[] = (<any>task).steps;
        // console.log('Agent -> RunTask -> stepsAsc -> beforesort -> ', util.inspect(stepsAsc, false, null));
        stepsAsc = stepsAsc.sort((a: StepSchema, b: StepSchema) => a.order > b.order ? 1 : a.order < b.order ? -1 : 0);
        // console.log('Agent -> RunTask -> stepsAsc -> ', util.inspect(stepsAsc, false, null));

        let taskOutcome: any = {
            _teamId: this._teamId,
            _jobId: task._jobId,
            _taskId: task.id,
            _agentId: this.instanceId,
            sourceTaskRoute: task.sourceTaskRoute,
            source: task.source,
            status: Enums.TaskStatus.RUNNING,
            correlationId: task.correlationId,
            dateStarted: dateStarted,
            ipAddress: this.ipAddress,
            machineId: this.MachineId(),
            artifactsDownloadedSize: artifactsDownloadedSize,
            target: task.target,
            runtimeVars: task.runtimeVars,
            autoRestart: task.autoRestart
        }

        if (task.target == Enums.TaskDefTarget.AWS_LAMBDA) {
            taskOutcome._teamId = task._teamId;
            taskOutcome.ipAddress = '0.0.0.0';
            taskOutcome.machineId = 'lambda-executor';
        }

        taskOutcome = <TaskOutcomeSchema>await this.RestAPICall(`taskOutcome`, 'POST', null, taskOutcome);
        // console.log('taskOutcome -> POST -> ', util.inspect(taskOutcome, false, null));
        if (taskOutcome.status == Enums.TaskStatus.RUNNING) {
            let lastStepOutcome = undefined;
            for (let step of stepsAsc) {

                if (step.variables) {
                    let newEnv: any = _.clone(step.variables);
                    for (let e = 0; e < Object.keys(newEnv).length; e++) {
                        let eKey = Object.keys(newEnv)[e];
                        if (eKey in task.runtimeVars) {
                            newEnv[eKey] = task.runtimeVars[eKey];
                        }
                    }
                    step.variables = newEnv;
                }

                let newScript = await SGUtils.injectScripts(this._teamId, SGUtils.atob(step.script.code), task.scriptsToInject, this.LogError);
                step.script.code = SGUtils.btoa_(newScript);

                newScript = SGUtils.atob(step.script.code);
                let arrInjectVarsScript: string[] = newScript.match(/@sgg?(\([^)]*\))/g);
                if (arrInjectVarsScript) {
                    // replace runtime variables in script
                    for (let i = 0; i < arrInjectVarsScript.length; i++) {
                        let found: boolean = false;
                        try {
                            let injectVarKey = arrInjectVarsScript[i].substr(5, arrInjectVarsScript[i].length - 6);
                            if (injectVarKey.substr(0, 1) === '"' && injectVarKey.substr(injectVarKey.length - 1, 1) === '"')
                                injectVarKey = injectVarKey.slice(1, -1);
                            if (injectVarKey in task.runtimeVars) {
                                let injectVarVal = task.runtimeVars[injectVarKey];
                                newScript = newScript.replace(`${arrInjectVarsScript[i]}`, `${injectVarVal}`);
                                found = true;
                            }

                            if (!found) {
                                newScript = newScript.replace(`${arrInjectVarsScript[i]}`, 'null');
                            }
                        } catch (e) {
                            this.LogError(`Error replacing script @sgg capture `, e.stack, { task, capture: arrInjectVarsScript[i], error: e.toString() });
                        }
                    }
                    step.script.code = SGUtils.btoa_(newScript);
                }

                let newArgs: string = step.arguments;
                let arrInjectVarsArgs: string[] = newArgs.match(/@sgg?(\([^)]*\))/g);
                if (arrInjectVarsArgs) {
                    // replace runtime variables in arguments
                    for (let i = 0; i < arrInjectVarsArgs.length; i++) {
                        let found: boolean = false;
                        try {
                            let injectVarKey = arrInjectVarsArgs[i].substr(5, arrInjectVarsArgs[i].length - 6);
                            if (injectVarKey.substr(0, 1) === '"' && injectVarKey.substr(injectVarKey.length - 1, 1) === '"')
                                injectVarKey = injectVarKey.slice(1, -1);
                            if (injectVarKey in task.runtimeVars) {
                                let injectVarVal = task.runtimeVars[injectVarKey];
                                if (injectVarVal) {
                                    newArgs = newArgs.replace(`${arrInjectVarsArgs[i]}`, `${injectVarVal}`);
                                    found = true;
                                }
                            }

                            if (!found) {
                                newArgs = newArgs.replace(`${arrInjectVarsArgs[i]}`, 'null');
                            }
                        } catch (e) {
                            this.LogError(`Error replacing arguments @sgg capture `, e.stack, { task, capture: arrInjectVarsScript[i], error: e.toString() });
                        }
                    }
                    step.arguments = newArgs;
                }

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
                    runCode: step.script.code,
                    status: Enums.TaskStatus.RUNNING,
                    dateStarted: new Date().toISOString()
                };

                if (task.target == Enums.TaskDefTarget.AWS_LAMBDA) {
                    stepOutcome._teamId = task._teamId;
                    stepOutcome.ipAddress = '0.0.0.0';
                    stepOutcome.machineId = 'lambda-executor';
                }

                stepOutcome = <StepOutcomeSchema>await this.RestAPICall(`stepOutcome`, 'POST', null, stepOutcome);

                // console.log('Agent -> RunTask -> RunStepAsync -> step -> ', util.inspect(step, false, null));
                let res: any;
                if (task.target == Enums.TaskDefTarget.AWS_LAMBDA) {
                    res = await this.RunStepAsync_Lambda(step, workingDirectory, task, stepOutcome.id, stepOutcome.lastUpdateId, taskOutcome.id);
                } else {
                    res = await this.RunStepAsync(step, workingDirectory, task, stepOutcome.id, stepOutcome.lastUpdateId, taskOutcome.id);
                }
                lastStepOutcome = res;
                // console.log('Agent -> RunTask -> RunStepAsync -> res -> ', util.inspect(res, false, null));

                this.queueCompleteMessages.push({ url: `stepOutcome/${stepOutcome.id}`, method: 'PUT', headers: null, data: res });

                Object.assign(task.runtimeVars, res.runtimeVars);
                Object.assign(taskOutcome.runtimeVars, res.runtimeVars);

                if (res.status === Enums.StepStatus.INTERRUPTED || res.status === Enums.StepStatus.FAILED) {
                    allStepsCompleted = false;
                    break;
                }
            }

            let dateCompleted = new Date().toISOString();

            if (allStepsCompleted) {
                taskOutcome.status = Enums.TaskStatus.SUCCEEDED;
            } else {
                if (lastStepOutcome) {
                    taskOutcome.status = lastStepOutcome.status;
                    if (lastStepOutcome.failureCode)
                        taskOutcome.failureCode = lastStepOutcome.failureCode;
                } else {
                    taskOutcome.status = Enums.TaskStatus.FAILED;
                    taskOutcome.failureCode = TaskFailureCode.AGENT_EXEC_ERROR;
                }
            }

            let taskOutcomeUpdates: any = {};
            taskOutcomeUpdates.status = taskOutcome.status;
            if (taskOutcome.failureCode)
                taskOutcomeUpdates.failureCode = taskOutcome.failureCode;
            taskOutcomeUpdates.dateCompleted = dateCompleted;
            taskOutcomeUpdates.runtimeVars = taskOutcome.runtimeVars;

            if (task.target == Enums.TaskDefTarget.AWS_LAMBDA)
                taskOutcomeUpdates._teamId = task._teamId;            
            // console.log(`???????????????????\n\ntaskOutcomeId -> ${taskOutcome.id}\n\ntaskOutcome -> ${JSON.stringify(taskOutcome)}\n\ntask -> ${JSON.stringify(task)}\n\ntaskOutcomeUpdates -> ${JSON.stringify(taskOutcomeUpdates)}`);
            this.queueCompleteMessages.push({ url: `taskOutcome/${taskOutcome.id}`, method: 'PUT', headers: null, data: taskOutcomeUpdates });
            // console.log('taskOutcome -> PUT -> ', util.inspect(taskOutcome, false, null));

            delete runningProcesses[taskOutcome.id];
        }

        this.RemoveFolder(workingDirectory, 0);
    }

    CompleteTaskGeneralErrorHandler = async (params: any) => {
        try {
            const _teamId = params._teamId;

            let taskOutcome: any = {
                _teamId: _teamId,
                _jobId: params._jobId,
                _taskId: params.id,
                _agentId: this.instanceId,
                source: params.source,
                sourceTaskRoute: params.sourceTaskRoute,
                correlationId: params.correlationId,
                dateStarted: new Date().toISOString(),
                ipAddress: '',
                machineId: '',
                artifactsDownloadedSize: 0,
                target: params.target,
                runtimeVars: params.runtimeVars,
                autoRestart: params.autoRestart
            }

            taskOutcome = <TaskOutcomeSchema>await this.RestAPICall(`taskOutcome`, 'POST', null, taskOutcome);

            let taskOutcomeUpdates: any = { runtimeVars: { route: 'fail' } };
            taskOutcomeUpdates.status = Enums.TaskStatus.FAILED;
            taskOutcomeUpdates.failureCode = TaskFailureCode.AGENT_EXEC_ERROR;
            taskOutcomeUpdates.dateCompleted = new Date().toISOString();
            this.queueCompleteMessages.push({ url: `taskOutcome/${taskOutcome.id}`, method: 'PUT', headers: null, data: taskOutcomeUpdates });

            delete runningProcesses[taskOutcome.id];
        } catch (e) {
            this.LogError('Error in CompleteTaskGeneralErrorHandler', e.stack, { error: e.toString() });
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
            this.LogError('Error in CompleteTask', e.stack, { error: e.toString() });
            // await this.CompleteTaskGeneralErrorHandler(params);
            return cb(true, msgKey);
        } finally {
            this.numActiveTasks -= 1;
        }
    };

    Update = async (params: any, msgKey: string, cb: any) => {
        try {
            await cb(true, msgKey);
            await this.LogDebug('Update received', { msgKey, params });
            if (this.updating) {
                await this.LogWarning('Version update running - skipping this update', {});
                return;
            }

            if (this.stopping) {
                await this.LogWarning('Agent stopping - skipping this update', {});
                return;
            }

            if (params.targetVersion && params.reportedVersion) {
                if ((params.targetVersion == params.reportedVersion) || this.runStandAlone) {
                    return;
                }

                this.updating = true;
                await this.LogDebug('Update Agent version message received', { msgKey, params });
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
                this.updateUserConfigValues({ 'tags': this.tags });
            }

            if (params.propertyOverrides) {
                await this.LogDebug('Update property overrides message received', { msgKey, params });


                // await cb(true, msgKey);
                await this.UpdatePropertyOverrides(params.propertyOverrides, 'server');
                this.updateUserConfigValues({ 'propertyOverrides': params.propertyOverrides });
                await this.SendHeartbeat(false, true);
                await this.SendMessageToAgentStub(params);
            }

            if (params.interruptTask) {
                await this.LogDebug('Interrupt task message received', { msgKey, params });
                const procToInterrupt = runningProcesses[params.interruptTask.id];
                if (procToInterrupt && typeof(procToInterrupt) == 'object' && procToInterrupt.pid) {
                    // console.log('Interrupting task');
                    // procToInterrupt.stdin.pause();
                    // console.log('stdin paused');
                    procToInterrupt.kill();
                    // console.log('Task interrupted');
                } else {
                    const runtimeVars: any = { 'route': 'interrupt' };
                    let taskOutcomeUpdate: any = {
                        status: Enums.TaskStatus.INTERRUPTED,
                        runtimeVars: runtimeVars
                    }
                    await this.RestAPICall(`taskOutcome/${params.interruptTask.id}`, 'PUT', null, taskOutcomeUpdate);
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
                    if (!this.queueCompleteMessages || this.queueCompleteMessages.length <= 0)
                        break;
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
        if (!propertyOverrides)
            return;

        for (let i = 0; i < Object.keys(propertyOverrides).length; i++) {
            let key = Object.keys(propertyOverrides)[i];
            if ((source == 'debug') || (this.userConfigurableProperties.indexOf(key) >= 0)) {
                if (key == 'logLevel') {
                    if (propertyOverrides[key] != null) {
                        this.logger.logLevel = propertyOverrides[key];
                        let props = {};
                        props[key] = propertyOverrides[key];
                        await this.SendMessageToAgentStub({ propertyOverrides: props });
                    }
                } else {
                    if (propertyOverrides[key] == null) {
                        this[key] = undefined;
                    } else {
                        if (typeof (this[key]) === 'number')
                            this[key] = +propertyOverrides[key];
                        else
                            this[key] = propertyOverrides[key];
                    }
                }
            }
        }
    }

    async CheckStompConnection() {
        if (this.stopped)
            return;

        if (!this.stompConsumer.IsConnected()) {
            await this.OnRabbitMQDisconnect();
        } else {
            setTimeout(() => { this.CheckStompConnection(); }, 10000);
        }
    }

    OnRabbitMQDisconnect = async () => {
        if (this.stopped)
            return;

        lock.acquire(lockConnectStomp, async () => {
            if (!this.stompConsumer.IsConnected()) {
                this.LogError(`Not connected to RabbitMQ - attempting to connect`, '', {});
                await this.stompConsumer.Stop();
                await this.ConnectStomp();
            }
        }, (err, ret) => {
            if (err) {
                this.LogError('Error in OnRabbitMQDisconnect', err.stack, { error: err.toString() });
                process.exitCode = 1;
            }
        }, {});
    };

    async ConnectStomp() {
        try {
            const elapsed = Date.now() - this.lastStompConnectAttemptTime;
            if (elapsed < this.stompReconnectMinWaitTime) {
                const ttw = this.stompReconnectMinWaitTime - elapsed;
                await SGUtils.sleep(ttw);
            }
            this.lastStompConnectAttemptTime = Date.now();
            this.LogDebug('Connecting to stomp', {url: this.stompUrl, user: this.rmqUsername, password: this.rmqPassword, vhost: this.rmqVhost});
            this.stompConsumer = new StompConnector(this.appName, this.instanceId.toHexString(), this.stompUrl, this.rmqUsername, this.rmqPassword, this.rmqAdminUrl, this.rmqVhost, 1, () => this.OnRabbitMQDisconnect(), this.logger);
            await this.stompConsumer.Start();
            await this.ConnectAgentWorkQueuesStomp();
            await this.CheckStompConnection();
        } catch (e) {
            this.LogError('Error in ConnectStomp', e.stack, { error: e.toString() });
            // setTimeout(() => { this.ConnectStomp(); }, 30000);
        }
    }

    async ConnectAgentWorkQueuesStomp() {
        let exchange = SGStrings.GetTeamExchangeName(this._teamId);
        const agentQueue = SGStrings.GetAgentQueue(this._teamId, this.instanceId.toHexString());

        // Queue to receive version update messages
        await this.stompConsumer.ConsumeQueue(SGStrings.GetAgentUpdaterQueue(this._teamId, this.instanceId.toHexString()), false, true, false, false, (msg, msgKey, cb) => this.Update(msg, msgKey, cb), SGStrings.GetTeamRoutingPrefix(this._teamId), this.inactiveAgentQueueTTL);

        // Queue to receive messages sent to this agent
        await this.stompConsumer.ConsumeQueue(agentQueue, false, true, false, false, (msg, msgKey, cb) => this.CompleteTask(msg, msgKey, cb), exchange, this.inactiveAgentQueueTTL);
    }


    async RunAgentStub() {
        let commandString: any = process.cwd() + '/sg-agent-launcher';
        try {
            spawn(commandString, [], { stdio: 'pipe', shell: true });
            process.exit();
        } catch (e) {
            console.error(`Error starting agent launcher '${commandString}': ${e.message}`, e.stack);
        }
    };


    async GetCronTab() {
        const commandString: string = 'crontab -l';
        const args = [];
        return new Promise((resolve, reject) => {
            try {
                let stdout: string = '';
                // this.LogDebug('GetCronTab: ' + commandString + ' ' + args, {});
                let cmd: any = spawn(commandString, args, { stdio: 'pipe', shell: true });

                cmd.stdout.on('data', (data) => {
                    try {
                        this.LogDebug('GetCronTab on.stdout.data', { data: data.toString() });
                        stdout = data.toString();
                    } catch (e) {
                        this.LogError('Error handling stdout in GetCronTab', e.stack, { error: e.toString() });
                        resolve();
                    }
                });

                cmd.on('exit', (code) => {
                    try {
                        resolve({ 'code': code, 'stdout': stdout });
                    } catch (e) {
                        this.LogError('Error handling exit in GetCronTab', e.stack, { error: e.toString() });
                        resolve();
                    }
                });
            } catch (e) {
                this.LogError(`GetCronTab error`, e.stack, { commandString, error: e.toString() });
                resolve();
            }
        })
    };
}
