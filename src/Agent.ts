declare function require(name: string);
const spawn = require('child_process').spawn;
const Tail = require('tail').Tail;
import * as os from 'os';
import * as fs from 'fs';
import * as fse from 'fs-extra';
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

const version = 'v0.0.0.4';

const userConfigPath: string = process.cwd() + '/sg.cfg';

const regexStdoutRedirectFiles = RegExp('(?<=\\>)(?<!2\\>)(?:\\>| )*([\\w\\.]+)', 'g');

let runningProcesses: any = {};

export default class Agent {
    private appName: string;
    private machineId: string = undefined;
    private runStandAlone: boolean = undefined;
    private disconnectedMessages: string[] = [];
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
    private updating: boolean = false;
    private numActiveTasks: number = 0;
    private maxActiveTasks: number = 10;
    private env: string;
    private logDest: string;
    private trackSysInfo: boolean = false;
    private logLevel: LogLevel = LogLevel.DEBUG;
    private heartbeatInterval: number = 30000;
    private token: string;
    private userConfig: any = {};
    private timeLastActive: number = Date.now();
    private inactivePeriodWaitTime: number = 0;
    private inactiveAgentTask: any;
    private ipcPath: string;
    private handleGeneralTasks: boolean = true;
    private maxStdoutSize: number = 307200; // bytes
    private maxStderrSize: number = 51200; // bytes
    private numLinesInTail: number = 5;
    private maxSizeLineInTail: number = 1024; //bytes
    private sendUpdatesInterval: number = 1000;
    private queueCompleteMessages: any[] = [];
    private offline: boolean = false;
    private mainProcessInterrupted: boolean = false;
    public _teamId: string;


    private userConfigurableProperties: string[] = ['maxActiveTasks', 'inactivePeriodWaitTime', 'inactiveAgentTask', 'handleGeneralTasks', 'trackSysInfo'];

    InstanceId() { return this.instanceId; }

    MachineId() { return (this.machineId ? this.machineId : os.hostname()); }


    constructor(params: any) {
        this.appName = 'Agent';

        // console.log(process.env.NODE_ENV);

        if (params.hasOwnProperty('logLevel'))
            this.logLevel = params['logLevel'];

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

        if ('inactiveAgentTask' in params)
            this.inactiveAgentTask = params.inactiveAgentTask;

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

        this.logger = new AgentLogger(this.appName, this._teamId, this.logLevel, process.cwd() + '/logs', this.apiUrl, this.apiPort, this.agentLogsAPIVersion, params.token, this.env, this.logDest, this.machineId);
        this.logger.Start();

        this.logger.LogDebug(`Starting Agent`, { tags: this.tags, propertyOverrides: this.UpdatePropertyOverrides, userConfigPath, env: this.env });

        this.ipcPath = process.argv[2];
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
                this.logger.LogWarning(`Error getting agent properties: ${err.message}`, {});
                agentProperties = await this.CreateAgentInAPI();
            } else {
                this.logger.LogError(`Error getting agent properties: ${err.message}`, err.stack, {});
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
        await this.ConnectAgentWorkQueuesStomp();

        if (!this.runStandAlone) {
            try {
                await this.ConnectIPC();
                ipc.of.SGAgentLauncherProc.on('disconnect', async () => {
                    this.LogError(`Disconnected from agent updater - attempting to reconnect`, '', {});
                    setTimeout(async () => {
                        try {
                            await this.ConnectIPC();
                        } catch (e) {
                            console.error('Error connecting to agent updater - restarting: ', e);
                            try { this.RunAgentStub() } catch (e) { }
                        }
                    }, 1000);
                });
                await this.SendMessageToAgentStub({ propertyOverrides: { 'instanceId': this.instanceId, 'apiUrl': this.apiUrl, 'apiPort': this.apiPort, 'agentLogsAPIVersion': this.agentLogsAPIVersion } });
            } catch (e) {
                console.error('Error connecting to agent updater - restarting: ', e);
                try { this.RunAgentStub() } catch (e) { }
            }
        }

        this.timeLastActive = Date.now();
        this.CheckInactiveTime();
        this.SendCompleteMessages();
    }


    async SignalHandler(signal) {
        // console.log('SignalHandler -> start -> runningProcesses -> ', runningProcesses);
        this.mainProcessInterrupted = true;

        await this.Stop();

        this.offline = true;
        await this.SendDisconnectMessage();

        for (let i = 0; i < Object.keys(runningProcesses).length; i++) {
            const proc = runningProcesses[Object.keys(runningProcesses)[i]];
            proc.kill();
            // delete runningProcesses[Object.keys(runningProcesses)[i]];
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


    async GetArtifact(artifactId: string, destPath: string) {
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
                            const artifactSize: number = fs.statSync(artifactPath).size
                            resolve(artifactSize);
                        })
                });

                if (SGUtils.GetFileExt(artifact.name) == '.gz') {
                    await SGUtils.GunzipFile(artifactPath);
                }
                resolve(artifactSize);
            } catch (e) {
                this.logger.LogError(`Error downloading artifact ${artifactId}: ${e.message}`, e.stack, {});
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

                console.log('Agent RestAPICall -> url ', url, ', method -> ', method, ', headers -> ', JSON.stringify(combinedHeaders, null, 4), ', data -> ', JSON.stringify(data, null, 4), ', token -> ', this.token);

                const response = await axios({
                    url,
                    method: method,
                    responseType: 'text',
                    headers: combinedHeaders,
                    data: data
                });
                resolve(response.data.data);
            } catch (e) {
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
                this.LogInfo(`Connecting to agent launcher`, {});
                ipc.connectTo('SGAgentLauncherProc', this.ipcPath, () => {
                    ipc.of.SGAgentLauncherProc.on('connect', async () => {
                        this.LogInfo(`Connected to agent launcher`, {});
                        resolve();
                    });
                    ipc.of.SGAgentLauncherProc.on('error', async () => {
                        this.LogError(`Error connecting to agent launcher - retrying`, '', {});
                        await SGUtils.sleep(5000);
                    });
                    ipc.of.SGAgentLauncherProc.on('destroy', async () => {
                        this.LogError(`Failed to connect to agent launcher`, '', {});
                        reject(new Error(`Failed to connect to agent launcher`));
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
                    this.LogInfo(`Sending message to agent launcher`, params);
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
            this.LogError(`Error sending disconnect message - ${e.message}`, '', {});
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
                if (cron.stdout) {
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
                        if (procToCancel) {
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
                this.LogError(`Error sending heartbeat: ${e.message}`, '', {});
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

                if (this.inactiveAgentTask) {
                    this.numActiveTasks += 1;
                    try {
                        this.LogDebug('Running inactive agent task', { 'inactiveAgentTask': util.inspect(this.inactiveAgentTask, false, null) });

                        let script: any = await this.RestAPICall(`script/${this.inactiveAgentTask.script._id}`, 'GET', null, null);
                        let data = {
                            job: {
                                name: `Inactive agent job - ${this.machineId}`,
                                dateCreated: new Date().toISOString(),
                                runtimeVars: { _agentId: this.InstanceId() },
                                tasks: [
                                    {
                                        name: 'InactiveTask',
                                        source: TaskSource.JOB,
                                        targetAgentId: this.instanceId,
                                        requiredTags: [],
                                        target: TaskDefTarget.SINGLE_SPECIFIC_AGENT,
                                        fromRoutes: [],
                                        steps: [
                                            {
                                                name: 'Step1',
                                                'script': {
                                                    scriptType: Enums.ScriptType[script.scriptType],
                                                    code: script.code
                                                },
                                                order: 0,
                                                arguments: this.inactiveAgentTask.arguments,
                                                variables: this.inactiveAgentTask.variables
                                            }
                                        ]
                                    }
                                ]
                            }
                        }

                        await this.RestAPICall(`job`, 'POST', null, data);
                    } catch (e) {
                        this.LogError('Error running inactive agent task: ' + e.message, e.stack, {});
                    } finally {
                        this.numActiveTasks -= 1;
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
        while (this.queueCompleteMessages.length > 0) {
            const msg: any = this.queueCompleteMessages[0];
            try {
                await this.RestAPICall(msg.url, msg.method, msg.headers, msg.data);
                this.queueCompleteMessages.shift();
            } catch (e) {
                if (!this.stopped) {
                    if (e.response && e.response.data && e.response.data.statusCode) {
                        this.LogError(`Error sending complete message: ${e.message}`, e.stack, { msg, response: e.response.data });
                        this.queueCompleteMessages.shift();
                    } else {
                        this.LogError(`Error sending complete message: ${e.message}`, e.stack, { msg });
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
            { processes: procs },
            { time: sysinfo.time() },
            { osInfo: osInfo },
            { cpuCurrentspeed: cpuCurrentspeed },
            { cpuTemperature: cpuTemperature },
            { currentLoad: currentLoad },
            { fsSize: fsSize },
            { networkConnections: networkConnections },
            { users: users },
            { mem: mem },
            { battery: battery },
            { inetLatency: inetLatency },
            { networkStats: networkStats }
        );

        if (fsStats)
            Object.assign(sysInfo, { fsStats: fsStats });
        if (disksIO)
            Object.assign(sysInfo, { disksIO: disksIO });

        return sysInfo;
    }

    RunStepAsync = async (step: StepSchema, workingDirectory: string, task: TaskSchema, stepOutcomeId: mongodb.ObjectId, lastUpdatedId: number, taskOutcomeId: mongodb.ObjectId) => {
        const appInst = this;
        return new Promise(async (resolve, reject) => {
            try {
                let script = step.script;

                let scriptFileName = workingDirectory + '/' + SGUtils.makeid(10);

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

                const stdoutFileName = workingDirectory + '/' + SGUtils.makeid(10) + '.out';
                const stderrFileName = workingDirectory + '/' + SGUtils.makeid(10) + '.err';

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
                    this.LogError('Error tailing stdout file: ' + error.message, error.stack, {});
                });

                let env = Object.assign({}, process.env);
                if (step.variables)
                    env = Object.assign(env, step.variables);

                let cmd = spawn(commandString, [], { stdio: ['ignore', out, err], shell: false, detached: false, env: env, cwd: workingDirectory });
    
                runningProcesses[taskOutcomeId] = cmd;

                /// called if there is an error running the script
                cmd.on('error', (err) => {
                    try {
                        try { if (fs.existsSync(scriptFileName)) fs.unlinkSync(scriptFileName); } catch (e) { }

                        // console.log('error: ' + err);
                        this.LogError(`Error running script: ${err}`, '', {});
                        resolve({ 'status': Enums.StepStatus.FAILED, 'code': -1, 'route': 'fail', 'stderr': err, 'failureCode': TaskFailureCode.AGENT_EXEC_ERROR });
                    } catch (e) {
                        this.LogError('Error handling error event: ' + e.message, e.stack, {});
                    }
                });

                /// called when external process completes
                cmd.on('exit', async (code, signal) => {
                    try {
                        try { if (fs.existsSync(scriptFileName)) fs.unlinkSync(scriptFileName); } catch (e) { }

                        procFinished = true;
                        tail.unwatch();

                        await SGUtils.sleep(100);
                        while (!stdoutAnalysisFinished)
                            await SGUtils.sleep(100);

                        let parseStdoutResult: any = {};
                        if (fs.existsSync(stdoutFileName)) {
                            parseStdoutResult = await this.ParseScriptStdout(stdoutFileName, true, stdoutBytesProcessed, stdoutTruncated);
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
                            parseResult = await this.ParseScriptStdout(workingDirectory + '/' + fileName, false);
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
                        outParams['tail'] = parseStdoutResult.lastXLines;
                        outParams['stderr'] = parseStderrResult.output;
                        outParams['exitCode'] = code;
                        outParams['lastUpdateId'] = updateId + 1;

                        resolve(outParams);
                    } catch (e) {
                        this.LogError('Error handling script exit: ' + e.message, e.stack, {});
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
                        await SGUtils.sleep(appInst.sendUpdatesInterval);
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
                            await appInst.RestAPICall(`stepOutcome/${stepOutcomeId}`, 'PUT', null, updates);
                            updateId += 1;

                            if (stdoutTruncated)
                                break;
                        }
                    } catch (err) {
                        this.LogError(`Error handling stdout tail: ${err.message}`, err.stack, {});
                        await SGUtils.sleep(1000);
                    }
                }
                stdoutAnalysisFinished = true;
            } catch (e) {
                this.LogError('Error in RunStepAsync: ' + e.message, e.stack, {});
                await SGUtils.sleep(1000);
                resolve({ 'status': Enums.StepStatus.FAILED, 'code': -1, 'route': 'fail', 'stderr': e.message, 'failureCode': TaskFailureCode.AGENT_EXEC_ERROR });
            }
        })
    }

    RunTask = async (task: TaskSchema) => {
        // console.log('Agent -> RunTask -> task -> ', util.inspect(task, false, null));
        let dateStarted = new Date().toISOString();

        let workingDirectory = process.cwd() + '/' + SGUtils.makeid(10);

        if (!fs.existsSync(workingDirectory))
            fs.mkdirSync(workingDirectory);

        let artifactsDownloadedSize: number = 0;
        if (task.artifacts) {
            for (let i = 0; i < task.artifacts.length; i++) {
                let artifactSize: number = 0;
                try {
                    artifactSize = (<number>await this.GetArtifact(task.artifacts[i], workingDirectory));
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
                            this.LogError(`Error replacing script @sgg capture for string \"${arrInjectVarsScript[i]}\": ${e.message}`, e.stack, { task: JSON.stringify(task, null, 4) });
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
                            this.LogError(`Error replacing arguments @sgg capture for string \"${arrInjectVarsArgs[i]}\": ${e.message}`, e.stack, { task: JSON.stringify(task, null, 4) });
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
                stepOutcome = <StepOutcomeSchema>await this.RestAPICall(`stepOutcome`, 'POST', null, stepOutcome);

                // console.log('Agent -> RunTask -> RunStepAsync -> step -> ', util.inspect(step, false, null));
                let res: any = await this.RunStepAsync(step, workingDirectory, task, stepOutcome.id, stepOutcome.lastUpdateId, taskOutcome.id);
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
            // console.log(`???????????????????\n\ntaskOutcomeId -> ${taskOutcome.id}\n\ntaskOutcome -> ${JSON.stringify(taskOutcome)}\n\ntask -> ${JSON.stringify(task)}\n\ntaskOutcomeUpdates -> ${JSON.stringify(taskOutcomeUpdates)}`);
            this.queueCompleteMessages.push({ url: `taskOutcome/${taskOutcome.id}`, method: 'PUT', headers: null, data: taskOutcomeUpdates });
            // console.log('taskOutcome -> PUT -> ', util.inspect(taskOutcome, false, null));

            delete runningProcesses[taskOutcome.id];
        }

        if (fs.existsSync(workingDirectory))
            fse.removeSync(workingDirectory);
    }

    CompleteTaskGeneralErrorHandler = async (params: any) => {
        try {
            const _teamId = params._teamId;

            let taskOutcome: any = {
                _teamId: _teamId,
                _jobId: params._jobId,
                _taskId: params.id,
                _agentId: this.instanceId.toHexString(),
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
            this.LogError('Error in CompleteTaskGeneralErrorHandler: ' + e.message, e.stack, {});
        }
    };

    CompleteTask = async (params: any, msgKey: string, cb: any) => {
        this.LogDebug('Task received', { 'MsgKey': msgKey, 'Params': util.inspect(params, false, null) });
        this.numActiveTasks += 1;
        try {
            if (this.numActiveTasks > this.maxActiveTasks) {
                cb(false, msgKey);
            } else {
                cb(true, msgKey);
                await this.RunTask(params);
            }
        } catch (e) {
            this.LogError('Error in CompleteTask: ' + e.message, e.stack, {});
            // await this.CompleteTaskGeneralErrorHandler(params);
            return cb(true, msgKey);
        } finally {
            this.numActiveTasks -= 1;
        }
    };

    Update = async (params: any, msgKey: string, cb: any) => {
        try {
            await cb(true, msgKey);
            // await this.LogDebug('Update received', { 'MsgKey': msgKey, 'Params': params });
            if (this.updating) {
                await this.LogWarning('Version update running - skipping this update', {});
                return;
            }

            if (params.targetVersion && params.reportedVersion) {
                if ((params.targetVersion == params.reportedVersion) || this.runStandAlone) {
                    return;
                }

                await this.LogDebug('Update Agent version message received', { 'MsgKey': msgKey, 'Params': params });
                this.updating = true;
                await SGUtils.sleep(2000);
                await this.StopConsuming();
                if (this.numActiveTasks > 0)
                    await this.LogWarning('Updating Agent - waiting for current tasks to complete', {});
                while (this.numActiveTasks > 0) {
                    await SGUtils.sleep(5000);
                }
                await this.LogWarning('Updating Agent - shutting down', {});
                process.exit(96);
            }

            if (params.tags) {
                await this.LogDebug('Update tags message received', { 'MsgKey': msgKey, 'Params': params });
                this.tags = params.tags;
                this.updateUserConfigValues({ 'tags': this.tags });
            }

            if (params.propertyOverrides) {
                await this.LogDebug('Update property overrides message received', { 'MsgKey': msgKey, 'Params': params });


                // await cb(true, msgKey);
                await this.UpdatePropertyOverrides(params.propertyOverrides, 'server');
                this.updateUserConfigValues({ 'propertyOverrides': params.propertyOverrides });
                await this.SendHeartbeat(false, true);
                await this.SendMessageToAgentStub(params);
            }

            if (params.interruptTask) {
                await this.LogDebug('Interrupt task message received', { 'MsgKey': msgKey, 'Params': params });
                const procToInterrupt = runningProcesses[params.interruptTask.id];
                if (procToInterrupt) {
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

            // await cb(true, msgKey);
        } catch (e) {
            this.LogError(`Error in Update: ${e.message}`, e.stack, {});
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

    OnRabbitMQDisconnect = (activeMessages) => {
        this.disconnectedMessages = this.disconnectedMessages.concat(activeMessages);
    };

    async ConnectStomp() {
        try {
            this.stompConsumer = new StompConnector(this.appName, this.instanceId.toHexString(), this.stompUrl, this.rmqUsername, this.rmqPassword, this.rmqAdminUrl, this.rmqVhost, 1, (activeMessages) => this.OnRabbitMQDisconnect(activeMessages), this.logger);
            await this.stompConsumer.Start();
        } catch (e) {
            this.LogError('Error in ConnectStomp: ' + e.message, e.stack, {});
        }
    }

    async ConnectAgentWorkQueuesStomp() {
        try {
            let exchange = SGStrings.GetTeamExchangeName(this._teamId);
            const agentQueue = SGStrings.GetAgentQueue(this._teamId, this.instanceId.toHexString());

            // Queue to receive version update messages
            await this.stompConsumer.ConsumeQueue(SGStrings.GetAgentUpdaterQueue(this._teamId, this.instanceId.toHexString()), false, true, false, false, (msg, msgKey, cb) => this.Update(msg, msgKey, cb), SGStrings.GetTeamRoutingPrefix(this._teamId), this.inactiveAgentQueueTTL);

            // Queue to receive messages sent to this agent
            await this.stompConsumer.ConsumeQueue(agentQueue, false, true, false, false, (msg, msgKey, cb) => this.CompleteTask(msg, msgKey, cb), exchange, this.inactiveAgentQueueTTL);
        } catch (e) {
            this.LogError('Error in ConnectStomp: ' + e.message, e.stack, {});
        }
    }


    async RunAgentStub() {
        let commandString: any = process.cwd() + '/sg-agent-launcher';
        try {
            spawn(commandString, [], { stdio: 'pipe', shell: true });
            process.exit();
        } catch (e) {
            console.error(`Error starting agent updater'${commandString}': ${e.message}`, e.stack);
        }
    };

    async RunShellCommand(commandString: any, args: string[]) {
        return new Promise((resolve, reject) => {
            try {
                let stdout: string = '';
                this.LogDebug('RunShellCommand: ' + commandString + ' ' + args, {});
                let cmd: any = spawn(commandString, args, { stdio: 'pipe', shell: true });

                cmd.stdout.on('data', (data) => {
                    try {
                        this.LogDebug('RunShellCommand on.stdout.data: ' + data, {});
                        stdout = data.toString();
                    } catch (e) {
                        this.LogError('Error handling stdout in RunShellCommand: ' + e.message, e.stack, {});
                    }
                });

                cmd.stderr.on('data', (data) => {
                    try {
                        this.LogDebug('Error in RunShellCommand on.stderr.data: ' + data, {});
                        // console.log(`agent err: ${data.toString()}`);
                    } catch (e) {
                        this.LogError('Error handling stderr in RunShellCommand: ' + e.message, e.stack, {});
                    }
                });

                cmd.on('exit', (code) => {
                    try {
                        resolve({ 'code': code, 'stdout': stdout });
                    } catch (e) {
                        this.LogError('Error handling exit in RunShellCommand: ' + e.message, e.stack, {});
                    }
                });
            } catch (e) {
                this.LogError(`RunShellCommand '${commandString}': ${e.message}`, e.stack, {});
            }
        })
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
                        this.LogDebug('GetCronTab on.stdout.data: ' + data, {});
                        stdout = data.toString();
                    } catch (e) {
                        this.LogError('Error handling stdout in GetCronTab: ' + e.message, e.stack, {});
                        resolve();
                    }
                });

                cmd.on('exit', (code) => {
                    try {
                        resolve({ 'code': code, 'stdout': stdout });
                    } catch (e) {
                        this.LogError('Error handling exit in GetCronTab: ' + e.message, e.stack, {});
                        resolve();
                    }
                });
            } catch (e) {
                this.LogError(`GetCronTab '${commandString}': ${e.message}`, e.stack, {});
                resolve();
            }
        })
    };
}
