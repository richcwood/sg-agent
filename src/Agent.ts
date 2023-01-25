declare function require(name: string);

const moment = require("moment");
const mtz = require("moment-timezone");
const spawn = require("child_process").spawn;
const Tail = require("tail").Tail;

import * as es from "event-stream";
import * as fs from "fs";
import * as fse from "fs-extra";
import * as ipc from "node-ipc";
import * as mongodb from "mongodb";
import * as os from "os";
import * as path from "path";
import * as sysinfo from "systeminformation";
import * as truncate from "truncate-utf8-bytes";
import * as util from "util";
import * as _ from "lodash";
import * as AsyncLock from "async-lock";

import axios from "axios";

import {StepSchema} from "./domain/Step";
import {StepOutcomeSchema} from "./domain/StepOutcome";
import {TaskSchema} from "./domain/Task";
import {IPCClient, IPCServer} from "./shared/Comm";
import {
  LogLevel,
  ScriptType,
  ScriptTypeDetails,
  StepStatus,
  TaskDefTarget,
  TaskFailureCode,
  TaskStatus,
} from "./shared/Enums";
import {AgentLogger} from "./shared/SGAgentLogger";
import {SGStrings} from "./shared/SGStrings";
import {SGUtils} from "./shared/SGUtils";
import {StompConnector} from "./shared/StompLib";

const version = "v0.0.80";
const SG_AGENT_CONFIG_FILE_NAME = "sg.cfg";

const regexStdoutRedirectFiles = RegExp("(?<=\\>)(?<!2\\>)(?:\\>| )*([\\w\\.]+)", "g");

let runningProcesses: any = {};

const lock = new AsyncLock({timeout: 5000});
const lockConnectStomp: string = "lock_connect_stomp_key";
const lockApiLogin: string = "lock_api_login_key";
const lockRefreshToken: string = "lock_refresh_token_key";

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
  private tags: any = {};
  private instanceId: mongodb.ObjectId;
  private ipAddress: string = "";
  private timezone: string = "";
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
  private tokenRefreshTime: number = 0;
  private refreshToken: string;
  private accessKeyId: string;
  private accessKeySecret: string;
  private userConfig: any = {};
  private timeLastActive: number = Date.now();
  private inactivePeriodWaitTime: number = 0;
  private inactiveAgentJob: any;
  private agentLauncherIPCPath: string;
  private ipcClient: any = undefined;
  private ipcServer: any = undefined;
  private handleGeneralTasks: boolean = true;
  private maxStdoutSize: number = 307200; // bytes
  private maxStderrSize: number = 51200; // bytes
  private numLinesInTail: number = 5;
  private maxSizeLineInTail: number = 10240; //bytes
  private sendUpdatesInterval: number = 10000;
  private queueAPICall: any[] = [];
  private offline: boolean = false;
  private mainProcessInterrupted: boolean = false;
  private lastStompConnectAttemptTime: number = 0;
  private stompReconnectMinWaitTime: number = 10000;
  public _teamId: string;

  private userConfigurableProperties: string[] = [
    "maxActiveTasks",
    "inactivePeriodWaitTime",
    "inactiveAgentJob",
    "handleGeneralTasks",
    "trackSysInfo",
  ];

  InstanceId() {
    return this.instanceId;
  }

  MachineId() {
    return this.machineId ? this.machineId : os.hostname();
  }

  constructor(params: any) {
    this.appName = "Agent";

    if (process.env.SG_AGENT_CONFIG_PATH)
      this.userConfigPath = path.join(process.env.SG_AGENT_CONFIG_PATH, SG_AGENT_CONFIG_FILE_NAME);
    else this.userConfigPath = SGUtils.getConfigFilePath();

    if (params.hasOwnProperty("logLevel")) this.logLevel = parseInt(params["logLevel"]);

    this.logDest = "file";
    if (params.hasOwnProperty("logDest")) this.logDest = params["logDest"];

    this._teamId = params._teamId;
    this.env = params.env;
    this.accessKeyId = params.accessKeyId;
    this.accessKeySecret = params.accessKeySecret;
    this.apiUrl = params.apiUrl;
    this.apiPort = params.apiPort;
    this.agentLogsAPIVersion = params.agentLogsAPIVersion;

    if ("machineId" in params) this.machineId = params.machineId;

    if ("runStandAlone" in params) this.runStandAlone = params.runStandAlone;

    if ("maxActiveTasks" in params) this.maxActiveTasks = params.maxActiveTasks;

    if ("inactivePeriodWaitTime" in params) this.inactivePeriodWaitTime = params.inactivePeriodWaitTime;

    if ("inactiveAgentJob" in params) this.inactiveAgentJob = params.inactiveAgentJob;

    if ("handleGeneralTasks" in params) this.handleGeneralTasks = params.handleGeneralTasks;

    if ("trackSysInfo" in params) this.trackSysInfo = params.trackSysInfo;

    if ("tags" in params) this.tags = params.tags;

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

    if (this.env != "unittest") {
      if ("tags" in this.userConfig) this.tags = this.userConfig["tags"];
      if ("propertyOverrides" in this.userConfig)
        this.UpdatePropertyOverrides(this.userConfig["propertyOverrides"], "local");
      if (this.env == "debug") {
        if ("debug" in this.userConfig) this.UpdatePropertyOverrides(this.userConfig["debug"], "debug");
      }
    }

    this.agentLauncherIPCPath = process.argv[2];
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
      propertyOverrides: {
        trackSysInfo: false,
        maxActiveTasks: this.maxActiveTasks,
        handleGeneralTasks: this.handleGeneralTasks,
      },
      sysInfo: await this.GetSysInfo(),
    };

    agentProperties = await this.RestAPICall(`agent`, "POST", {data: agent_info, retryWithBackoff: true});

    return agentProperties;
  }

  async Init() {
    if (!this._teamId) await this.RestAPILogin();

    this.logger = new AgentLogger(
      this,
      this.logLevel,
      process.cwd() + "/logs",
      this.apiUrl,
      this.apiPort,
      this.agentLogsAPIVersion
    );
    this.logger.Start();

    this.ipcServer = new IPCServer(
      "SGAgentProc",
      SGUtils.makeid(10),
      `sg-agent-launcher-msg-${this._teamId}`,
      async (message, socket) => {
        const logMsg = "Message from AgentLauncher";
        this.logger.LogDebug(logMsg, message);
        if (message.signal) {
          await this.SignalHandler(message.signal);
        }
      }
    );

    this.logger.LogDebug(`Starting Agent`, {
      tags: this.tags,
      propertyOverrides: this.UpdatePropertyOverrides,
      userConfigPath: this.userConfigPath,
      env: this.env,
    });

    let agentProperties: any = {};
    try {
      agentProperties = await this.RestAPICall(`agent/machineid/${this.MachineId()}`, "GET", {
        headers: {_teamId: this._teamId},
      });
    } catch (e) {
      if (e.response && e.response.status == 404) {
        agentProperties = await this.CreateAgentInAPI();
      } else {
        this.logger.LogError(`Error getting agent properties`, e.stack, SGUtils.errorToObj(e));
        throw e;
      }
    }

    this.instanceId = new mongodb.ObjectId(agentProperties.id);
    this.inactiveAgentQueueTTL = agentProperties.inactiveAgentQueueTTL;
    this.stompUrl = agentProperties.stompUrl;
    this.rmqAdminUrl = agentProperties.rmqAdminUrl;
    this.rmqUsername = agentProperties.rmqUsername;
    this.rmqPassword = agentProperties.rmqPassword;
    this.rmqVhost = agentProperties.rmqVhost;

    if (!this.areObjectsEqual(this.tags, agentProperties.tags)) {
      if (this.tags) {
        try {
          await this.RestAPICall(`agent/tags/${this.instanceId.toHexString()}`, "PUT", {data: {tags: this.tags}});
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
          method: "PUT",
          headers: null,
          data: this.userConfig.propertyOverrides,
        });

        // await this.UpdatePropertyOverridesAPI(this.userConfig.propertyOverrides)
      }
    }

    if (this.env == "debug") {
      if ("debug" in this.userConfig) {
        if ("stompUrl" in this.userConfig.debug) this.stompUrl = this.userConfig.debug.stompUrl;
        if ("rmqAdminUrl" in this.userConfig.debug) this.rmqAdminUrl = this.userConfig.debug.rmqAdminUrl;
      }
    }

    this.logger.instanceId = this.instanceId.toHexString();

    process.on("SIGINT", this.SignalHandler.bind(this));
    process.on("SIGTERM", this.SignalHandler.bind(this));

    await this.SendHeartbeat(true, false);

    await this.ConnectStomp();

    if (!this.runStandAlone) {
      try {
        this.ipcClient = new IPCClient(
          "SGAgentLauncherProc",
          `sg-agent-proc-${this._teamId}`,
          this.agentLauncherIPCPath,
          () => {
            this.LogError("Error connecting to agent launcher - retrying", "", {});
          },
          () => {
            if (!this.stopped) this.LogError(`Failed to connect to agent launcher`, "", {});
          },
          async () => {
            if (this.stopped) return;
            this.LogError(`Disconnected from agent launcher - attempting to reconnect in 10 seconds`, "", {});
            for (let i = 0; i < 10; i++) {
              if (this.stopped) break;
              await SGUtils.sleep(1000);
            }
            setTimeout(async () => {
              try {
                if (!this.stopped) await this.ipcClient.ConnectIPC();
              } catch (e) {
                this.LogError(`Error connecting to agent launcher - restarting`, "", e);
                try {
                  this.RunAgentStub();
                } catch (e) {}
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
        this.LogError(`Error connecting to agent launcher - restarting`, "", e);
        try {
          this.RunAgentStub();
        } catch (e) {}
      }
    }

    this.timeLastActive = Date.now();
    this.CheckInactiveTime();
    this.SendMessageToAPIAsync();
  }

  async SignalHandler(signal) {
    this.mainProcessInterrupted = true;

    await this.Stop();

    this.offline = true;
    await this.SendDisconnectMessage();

    for (let i = 0; i < Object.keys(runningProcesses).length; i++) {
      const proc = runningProcesses[Object.keys(runningProcesses)[i]];
      if (proc && typeof proc == "object" && proc.pid) {
        proc.kill();
        // delete runningProcesses[Object.keys(runningProcesses)[i]];
      }
    }

    const maxSleepCount: number = 10;
    let sleepCount: number = 0;
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

  async GetArtifact(artifactId: string, destPath: string, _teamId: string) {
    return new Promise(async (resolve, reject) => {
      let artifactPrefix: string = "";
      let artifactName: string = "";
      try {
        let artifact: any = await this.RestAPICall(`artifact/${artifactId}`, "GET");
        const artifactPath = `${destPath}/${artifact.name}`;
        const writer = fs.createWriteStream(artifactPath);

        // console.log('GetArtifact -> url ', url, ', headers -> ', this._teamId, ', token -> ', this.token);

        const response = await axios({
          url: artifact.url,
          method: "GET",
          responseType: "stream",
        });

        const artifactSize = await new Promise(async (resolve, reject) => {
          response.data.pipe(writer).on("finish", () => {
            const artifactSize: number = fs.statSync(artifactPath).size;
            resolve(artifactSize);
          });
        });

        if (SGUtils.GetFileExt(artifact.name) == ".gz") {
          await SGUtils.GunzipFile(artifactPath);
        }
        resolve({success: true, artifactSize});
      } catch (e) {
        resolve({success: false, error: SGUtils.errorToObj(e), artifactPrefix, artifactName});
      }
    });
  }

  async RestAPILogin(retryCount: number = 0) {
    return new Promise<void>(async (resolve, reject) => {
      // console.log('Waiting to aquire lockRefreshToken');
      lock.acquire(
        lockApiLogin,
        async () => {
          try {
            if (new Date().getTime() - this.tokenRefreshTime < 30000 && this.token) return;

            this.token = "";

            let apiUrl = this.apiUrl;

            const apiPort = this.apiPort;

            if (apiPort != "") apiUrl += `:${apiPort}`;
            const url = `${apiUrl}/login/apiLogin`;

            const response = await axios({
              url,
              method: "POST",
              responseType: "text",
              headers: {
                "Content-Type": "application/json",
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
        (err, ret) => {
          if (err) {
            retryCount += 1;
            if (retryCount > 5) {
              this.LogError("Error acquiring api login lock in RestAPILogin", err.stack, {error: err.toString()});
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

  async RefreshAPIToken(retryCount: number = 0) {
    return new Promise<void>(async (resolve, reject) => {
      // console.log('Waiting to aquire lockRefreshToken');
      lock.acquire(
        lockRefreshToken,
        async () => {
          try {
            if (new Date().getTime() - this.tokenRefreshTime < 30000 && this.token) return;

            this.token = "";

            let apiUrl = this.apiUrl;

            const apiPort = this.apiPort;

            if (apiPort != "") apiUrl += `:${apiPort}`;
            const url = `${apiUrl}/login/refreshtoken`;

            const response = await axios({
              url,
              method: "POST",
              responseType: "text",
              headers: {
                "Content-Type": "application/json",
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
        (err, ret) => {
          if (err) {
            retryCount += 1;
            if (retryCount > 5) {
              this.LogError("Error acquiring api login lock in RefreshAPIToken", err.stack, {error: err.toString()});
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

  async RestAPICall(url: string, method: string, options: any = {}) {
    return new Promise(async (resolve, reject) => {
      const mergedOptions: any = {...{headers: {}, data: {}, retryWithBackoff: false}, ...options};
      let waitTimesBackoff = [1000, 5000, 10000, 20000, 30000, 60000];
      while (true) {
        let fullurl = "";
        try {
          if (!this.token) await this.RestAPILogin();

          let apiUrl = this.apiUrl;
          let apiVersion = this.agentLogsAPIVersion;

          const apiPort = this.apiPort;

          if (apiPort != "") apiUrl += `:${apiPort}`;
          fullurl = `${apiUrl}/api/${apiVersion}/${url}`;

          const combinedHeaders: any = Object.assign(
            {
              Cookie: `Auth=${this.token};`,
              _teamId: this._teamId,
            },
            mergedOptions.headers
          );

          // this.logger.LogDebug(`RestAPICall`, {fullurl, method, combinedHeaders, data, token: this.token});
          // console.log('Agent RestAPICall -> url ', fullurl, ', method -> ', method, ', headers -> ', JSON.stringify(combinedHeaders, null, 4), ', data -> ', JSON.stringify(data, null, 4), ', token -> ', this.token);

          const response = await axios({
            url: fullurl,
            method: method,
            responseType: "text",
            headers: combinedHeaders,
            data: mergedOptions.data,
          });

          resolve(response.data.data);
          break;
        } catch (e) {
          if (
            e.response &&
            e.response.data &&
            e.response.data.errors &&
            _.isArray(e.response.data.errors) &&
            e.response.data.errors.length > 0 &&
            e.response.data.errors[0].description == "The access token expired"
          ) {
            await this.RefreshAPIToken();
            resolve(
              this.RestAPICall(url, method, {
                headers: mergedOptions.headers,
                data: mergedOptions.data,
                retryWithBackoff: mergedOptions.retryWithBackoff,
              })
            );
          } else {
            const errorContext: any = Object.assign(
              {
                http_method: method,
                url: fullurl,
                data: mergedOptions.data,
              },
              e
            );
            const status = e.response && e.response.status;
            if (mergedOptions.retryWithBackoff && !status) {
              const waitTime = waitTimesBackoff.shift() || 60000;
              this.LogError(
                `Error sending message to API - retrying`,
                e.stack,
                Object.assign({retry_wait_time: waitTime}, errorContext)
              );
              await SGUtils.sleep(waitTime);
            } else {
              // this.logger.LogError(`Error sending message to API`, e.stack, errorContext);
              reject(errorContext);
              break;
            }
          }
        }
      }
    });
  }

  getUserConfigValues = () => {
    let userConfig = {};
    try {
      if (fs.existsSync(this.userConfigPath)) {
        userConfig = JSON.parse(fs.readFileSync(this.userConfigPath).toString());
      }
    } catch (e) {
      console.log(`Error getting user config values: ${e}`);
    }

    return userConfig;
  };

  updateUserConfigValues = (values: any) => {
    if (this.env == "unittest") return;

    let userConfig: any = this.getUserConfigValues();
    if (values.propertyOverrides) {
      if (!userConfig.propertyOverrides) userConfig.propertyOverrides = {};
      for (let i = 0; i < Object.keys(values.propertyOverrides).length; i++) {
        const key = Object.keys(values.propertyOverrides)[i];
        if (values.propertyOverrides[key] == null) delete userConfig.propertyOverrides[key];
        else userConfig.propertyOverrides[key] = values.propertyOverrides[key];
      }
    }

    if (values.tags) {
      userConfig.tags = values.tags;
    }

    fs.writeFileSync(this.userConfigPath, JSON.stringify(userConfig, null, 4));
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
    ipc.disconnect("SGAgentLauncherProc");
  }

  async LogError(msg: string, stack: string, values: any) {
    if (this.logger) await this.logger.LogError(msg, stack, values);
    else console.log(msg, stack, util.inspect(values, false, null));
  }

  async LogWarning(msg: string, values: any) {
    if (this.logger) await this.logger.LogWarning(msg, values);
    else console.log(msg, util.inspect(values, false, null));
  }

  async LogInfo(msg: string, values: any) {
    if (this.logger) await this.logger.LogInfo(msg, values);
    else console.log(msg, util.inspect(values, false, null));
  }

  async LogDebug(msg: string, values: any) {
    if (this.logger) await this.logger.LogDebug(msg, values);
    else console.log(msg, util.inspect(values, false, null));
  }

  async SendMessageToAgentStub(params) {
    if (!this.runStandAlone) {
      return new Promise<void>(async (resolve, reject) => {
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
      const heartbeat_info: any = {
        machineId: this.MachineId(),
        ipAddress: SGUtils.getIpAddress(),
        offline: this.offline,
      };

      await this.RestAPICall(`agent/heartbeat/${this.instanceId}`, "PUT", {data: heartbeat_info});
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
        this.LogWarning(`Error removing folder`, {path, error: err.toString()});
      } else {
        setTimeout(() => {
          this.RemoveFolder(path, retryCount);
        }, 1000);
      }
    }
  }

  async SendHeartbeat(forceGetSysInfo: boolean = false, once: boolean = false) {
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
        heartbeat_info["sysInfo"] = sysInfo;
      }

      let cron: any;
      if (process.platform.indexOf("darwin") >= 0 || process.platform.indexOf("linux") >= 0) {
        cron = await this.GetCronTab();
        if (cron && cron.stdout) {
          heartbeat_info.cron = cron.stdout;
        }
      }

      try {
        let ret: any = await this.RestAPICall(`agent/heartbeat/${this.instanceId}`, "PUT", {data: heartbeat_info});

        if (ret.tasksToCancel) {
          this.LogDebug("Received tasks to cancel from heartbeat", {
            tasksToCancel: JSON.stringify(ret.tasksToCancel, null, 4),
          });
          for (let i = 0; i < ret.tasksToCancel.length; i++) {
            const taskToCancel = ret.tasksToCancel[i];
            const procToCancel = runningProcesses[taskToCancel];
            if (procToCancel && typeof procToCancel == "object" && procToCancel.pid) {
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
        this.LogError(`Error sending heartbeat`, "", SGUtils.errorToObj(e));
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
            this.LogDebug("Running inactive agent job", {inactiveAgentJob: this.inactiveAgentJob});

            let runtimeVars: any = {};
            if (this.inactiveAgentJob.runtimeVars) Object.assign(runtimeVars, this.inactiveAgentJob.runtimeVars);
            runtimeVars._agentId = {};
            runtimeVars._agentId["value"] = this.InstanceId();

            let data = {
              name: `Inactive agent job - ${this.MachineId()}`,
              runtimeVars,
              createdBy: this.MachineId(),
            };

            this.queueAPICall.push({
              url: `job`,
              method: "POST",
              headers: {_jobDefId: this.inactiveAgentJob.id},
              data,
            });
          } catch (e) {
            this.LogError("Error running inactive agent job", e.stack, {
              inactiveAgentJob: this.inactiveAgentJob,
              error: e.toString(),
            });
          }
        }
      }
      if (!this.stopped)
        setTimeout(() => {
          this.CheckInactiveTime();
        }, 1000);
    } catch (e) {
      if (!this.stopped) throw e;
    }
  }

  async SendMessageToAPIAsync() {
    // this.LogDebug('Checking message queue', {});
    let waitTimesBackoff = [1000, 5000, 10000, 20000, 30000, 60000];
    while (this.queueAPICall.length > 0) {
      const msg: any = this.queueAPICall.shift();
      try {
        // this.LogDebug('Sending queued message', { 'request': msg });
        await this.RestAPICall(msg.url, msg.method, {
          header: msg.headers,
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
                  method: "SendMessageToAPIAsync",
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
                  method: "SendMessageToAPIAsync",
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
      let rtVar = {};
      if (k.startsWith("<<") && k.endsWith(">>")) {
        k = k.substring(2, k.length - 2);
        rtVar[k] = {sensitive: true};
      } else if (k != "route") {
        rtVar[k] = {sensitive: false};
      } else {
        rtVar[k] = {};
      }
      rtVar[k]["value"] = v;

      return rtVar;
    }

    let runtimeVars: any = {};
    let arrParams: string[] = line.match(/@sgo(\{[^}]*\})/gi);
    if (arrParams) {
      for (let i = 0; i < arrParams.length; i++) {
        let rtVar;
        let rawValue;
        try {
          const newValJson = arrParams[i].substring(4);
          const newVal = JSON.parse(newValJson);
          let [key, value] = Object.entries(newVal)[0];
          rawValue = value;
          rtVar = fnRtVar(key, value);
          runtimeVars = Object.assign(runtimeVars, rtVar);
        } catch (e) {
          try {
            if (e.message.indexOf("Unexpected token \\") >= 0) {
              const newValJson = arrParams[i].substring(4).replace(/\\+"/g, '"');
              const newVal = JSON.parse(newValJson);
              let [key, value] = Object.entries(newVal)[0];
              rawValue = value;
              rtVar = fnRtVar(key, value);
              runtimeVars = Object.assign(runtimeVars, rtVar);
            } else {
              const re = /{['"]?([\w-]+)['"]?:[ '"]+([^,'"]+)['"]}/g;
              const s = arrParams[i].substring(4);
              let m;
              while ((m = re.exec(s)) != null) {
                let key = m[1].trim();
                const val = m[2].trim();
                rawValue = val;
                rtVar = fnRtVar(key, val);
                runtimeVars = Object.assign(runtimeVars, rtVar);
              }
            }
          } catch (se) {}
        }

        let [key, value] = Object.entries(rtVar)[0];
        if (value["sensitive"]) {
          const newVal = arrParams[i].replace(rawValue, `**${key}**`);
          line = line.replace(arrParams[i], newVal);
        }
      }
    }

    return [runtimeVars, line];
  }

  ReplaceSensitiveRuntimeVarValuesInString(line: string, rtVars: any) {
    let newLine: string = line;
    const keys = Object.keys(rtVars);
    for (let i = 0; i < keys.length; ++i) {
      const k = keys[i];
      const v = rtVars[k];
      if (v["sensitive"]) {
        newLine = newLine.replace(RegExp(v["value"], "g"), `**${k}**`);
      }
    }

    return newLine;
  }

  async ParseScriptStdout(
    filePath: string,
    task: any,
    saveOutput: boolean,
    stdoutBytesAlreadyProcessed: number = 0,
    stdoutTruncated: boolean = false
  ) {
    let appInst = this;
    return new Promise((resolve, reject) => {
      try {
        let lineCount = 0;
        let bytesRead: number = 0;

        let output: string = "";
        let runtimeVars: any = {};
        let lastXLines: string[] = [];
        let s = fs
          .createReadStream(filePath)
          .pipe(es.split())
          .pipe(
            es
              .mapSync(function (line) {
                // pause the readstream
                s.pause();

                lineCount += 1;

                let [rtv, newLine] = appInst.ExtractRuntimeVarsFromString(line);
                Object.assign(runtimeVars, rtv);

                if (saveOutput && newLine) {
                  newLine = appInst.ReplaceSensitiveRuntimeVarValuesInString(newLine, task.runtimeVars);
                  const strLenBytes = Buffer.byteLength(newLine, "utf8");
                  bytesRead += strLenBytes;
                  if (bytesRead > stdoutBytesAlreadyProcessed) {
                    if (!stdoutTruncated) {
                      if (strLenBytes + stdoutBytesAlreadyProcessed < appInst.maxStdoutSize) {
                        output += `${newLine}\n`;
                        stdoutBytesAlreadyProcessed += strLenBytes;
                      } else {
                        output = truncate(output, appInst.maxStdoutSize) + "\n(truncated)\n";
                        stdoutTruncated = true;
                      }
                    }

                    let lineForTail = newLine;
                    if (strLenBytes > appInst.maxSizeLineInTail)
                      lineForTail = truncate(newLine, appInst.maxSizeLineInTail) + " (truncated)";
                    lastXLines.push(lineForTail);
                    if (lastXLines.length > appInst.numLinesInTail) lastXLines.shift();
                  }
                }

                // resume the readstream
                s.resume();
              })
              .on("error", function (err) {
                reject(new Error(`Error reading stdout file '${filePath}' on line ${lineCount}: ${err}`));
              })
              .on("end", function () {
                if (stdoutTruncated) output += "\n" + lastXLines.join("\n");
                resolve({output: output, runtimeVars: runtimeVars, lastXLines: lastXLines});
              })
          );
      } catch (e) {
        reject(e);
      }
    });
  }

  async ParseScriptStderr(filePath: string, task: any) {
    let appInst = this;
    return new Promise((resolve, reject) => {
      try {
        let lineCount = 0;

        let output: string = "";
        let s = fs
          .createReadStream(filePath)
          .pipe(es.split())
          .pipe(
            es
              .mapSync(function (line) {
                // pause the readstream
                s.pause();

                lineCount += 1;
                if (line) {
                  line = appInst.ReplaceSensitiveRuntimeVarValuesInString(line, task.runtimeVars);
                  if (Buffer.byteLength(output, "utf8") < appInst.maxStderrSize) {
                    output += `${line}\n`;
                    if (Buffer.byteLength(output, "utf8") > appInst.maxStderrSize)
                      output = truncate(output, appInst.maxStderrSize) + " (truncated)";
                  }
                }

                // resume the readstream
                s.resume();
              })
              .on("error", function (err) {
                reject(new Error(`Error reading stderr file '${filePath}' on line ${lineCount}: ${err}`));
              })
              .on("end", function () {
                resolve({output: output});
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
    procs.list = procs.list
      .sort((a, b) => {
        return b.pcpu - a.pcpu;
      })
      .slice(0, 10);
    let osInfo = await sysinfo.osInfo();
    let cpuCurrentspeed = await sysinfo.cpuCurrentspeed();
    let cpuTemperature = await sysinfo.cpuTemperature();
    let currentLoad = await sysinfo.currentLoad();
    let fsSize = await sysinfo.fsSize();
    // let networkConnections = await sysinfo.networkConnections();
    // let users = await sysinfo.users();
    let mem = await sysinfo.mem();
    // let battery = await sysinfo.battery();
    let inetLatency = await sysinfo.inetLatency();
    let networkStats = await sysinfo.networkStats();

    let fsStats = null;
    let disksIO = null;
    if (process.platform.indexOf("darwin") >= 0 || process.platform.indexOf("linux") >= 0) {
      fsStats = await sysinfo.fsStats();
      disksIO = await sysinfo.disksIO();
    }

    Object.assign(
      sysInfo,
      {osInfo: osInfo},
      {time: sysinfo.time()},
      {cpuCurrentspeed: cpuCurrentspeed},
      {cpuTemperature: cpuTemperature},
      {currentLoad: currentLoad},
      {mem: mem},
      {fsSize: fsSize},
      {inetLatency: inetLatency},
      {networkStats: networkStats},
      {processes: procs}
      // { networkConnections: networkConnections },
      // { users: users },
      // { battery: battery }
    );

    if (fsStats) Object.assign(sysInfo, {fsStats: fsStats});
    if (disksIO) Object.assign(sysInfo, {disksIO: disksIO});

    return sysInfo;
  };

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
          if (params.procFinished) break;
        }
        continue;
      }

      let data: any[] = params.queueTail.splice(0);
      try {
        let dataStrings: string[] = data.map((m) => m.message);
        let dataAsString = dataStrings.join("");
        const [rtv, newLine] = params.appInst.ExtractRuntimeVarsFromString(dataAsString);
        let rtvUpdates = {};
        for (let indexRTV = 0; indexRTV < Object.keys(rtv).length; indexRTV++) {
          let key = Object.keys(rtv)[indexRTV];
          if (!params.rtvCumulative[key] || params.rtvCumulative[key] != rtv[key]) {
            rtvUpdates[key] = rtv[key];
            params.rtvCumulative[key] = rtv[key];
          }
        }

        for (let i = 0; i < data.length; i++) {
          const msg = data[i].message;
          if (msg.startsWith("REPORT ")) {
            const elems: string[] = msg.split("\t");
            for (let j = 0; j < elems.length; j++) {
              const elem: string = elems[j];
              if (elem.startsWith("Duration: ")) {
                try {
                  params.lambdaDuration = Number(elem.split(":").slice(1, 3).join(" ").trim().split(" ")[0]);
                } catch (err) {}
              } else if (elem.startsWith("Billed Duration: ")) {
                try {
                  params.lambdaBilledDuration = Number(elem.split(":").slice(1, 3).join(" ").trim().split(" ")[0]);
                } catch (err) {}
              } else if (elem.startsWith("Memory Size: ")) {
                try {
                  params.lambdaMemSize = Number(elem.split(":").slice(1, 3).join(" ").trim().split(" ")[0]);
                } catch (err) {}
              } else if (elem.startsWith("Max Memory Used: ")) {
                try {
                  params.lambdaMaxMemUsed = Number(elem.split(":").slice(1, 3).join(" ").trim().split(" ")[0]);
                } catch (err) {}
              } else if (elem.startsWith("Init Duration: ")) {
                try {
                  params.lambdaInitDuration = Number(elem.split(":").slice(1, 3).join(" ").trim().split(" ")[0]);
                } catch (err) {}
              }
            }
          }
        }

        if (Object.keys(rtvUpdates).length > 0) {
          // console.log(`****************** taskOutcomeId -> ${params.taskOutcomeId}, runtimeVars -> ${JSON.stringify(rtvUpdates)}`);
          params.appInst.queueAPICall.push({
            url: `taskOutcome/${params.taskOutcomeId}`,
            method: "PUT",
            headers: null,
            data: {_teamId: params._teamId, runtimeVars: rtvUpdates},
          });
        }

        params.lastXLines = params.lastXLines.concat(dataStrings).slice(-params.appInst.numLinesInTail);
        for (let i = 0; i < params.lastXLines.length; i++) {
          if (Buffer.byteLength(params.lastXLines[i], "utf8") > params.appInst.maxSizeLineInTail)
            params.lastXLines[i] = truncate(params.lastXLines[i], params.appInst.maxSizeLineInTail) + " (truncated)";
        }

        while (true) {
          if (dataStrings.length < 1) break;

          let stdoutToUpload: string = "";
          let countLinesToUpload: number = 0;
          if (!params.stdoutTruncated) {
            const maxStdoutUploadSize: number = 51200;
            let stdoutBytesProcessedLocal: number = 0;
            for (let i = 0; i < dataStrings.length; i++) {
              const strLenBytes = Buffer.byteLength(dataStrings[i], "utf8");
              if (params.stdoutBytesProcessed + strLenBytes > params.appInst.maxStdoutSize) {
                stdoutToUpload += "\n(max stdout size exceeded - results truncated)\n";
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
          const updates: any = {
            _teamId: params._teamId,
            tail: params.lastXLines,
            stdout: stdoutToUpload,
            status: StepStatus.RUNNING,
            lastUpdateId: params.updateId,
          };
          params.updateId += 1;
          await params.appInst.RestAPICall(`stepOutcome/${params.stepOutcomeId}`, "PUT", {data: updates});

          if (params.stdoutTruncated) break;
        }
      } catch (err) {
        this.LogError(`Error handling stdout tail`, err.stack, SGUtils.errorToObj(err));
        await SGUtils.sleep(1000);
      }
    }
    params.stdoutAnalysisFinished = true;
  };

  RunStepAsync_Lambda = async (
    step: StepSchema,
    workingDirectory: string,
    task: TaskSchema,
    stepOutcomeId: mongodb.ObjectId,
    lastUpdatedId: number,
    taskOutcomeId: mongodb.ObjectId
  ) => {
    const appInst = this;
    return new Promise(async (resolve, reject) => {
      let error = "";
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
        let lambdaDuration: string = undefined;
        let lambdaBilledDuration: string = undefined;
        let lambdaMemSize: string = undefined;
        let lambdaMaxMemUsed: string = undefined;
        let lambdaInitDuration: string = undefined;
        let runParams: any = {
          queueTail,
          procFinished,
          taskOutcomeId,
          appInst,
          rtvCumulative,
          lastXLines,
          stdoutTruncated,
          stdoutBytesProcessed,
          updateId,
          stepOutcomeId,
          stdoutAnalysisFinished,
          _teamId,
          runLambdaFinished,
          lambdaDuration,
          lambdaBilledDuration,
          lambdaMemSize,
          lambdaMaxMemUsed,
          lambdaInitDuration,
        };

        const stdoutFileName = workingDirectory + path.sep + SGUtils.makeid(10) + ".out";
        const out = fs.openSync(stdoutFileName, "w");

        let lambdaCode: any = {};
        let zipFilePath: string = "";
        let handler: string = "";
        if (!step.lambdaZipfile) {
          let msg: string = `${new Date().toISOString()} Creating AWS Lambda function\n`;
          runParams.lastXLines.push(msg);
          const updates: any = {
            _teamId: runParams._teamId,
            tail: runParams.lastXLines,
            stdout: msg,
            status: StepStatus.RUNNING,
            lastUpdateId: runParams.updateId,
          };
          await appInst.RestAPICall(`stepOutcome/${runParams.stepOutcomeId}`, "PUT", {data: updates});
          runParams.updateId += 1;

          if (step.lambdaRuntime.toLowerCase().startsWith("node")) {
            zipFilePath = <string>(
              await SGUtils.CreateAWSLambdaZipFile_NodeJS(
                workingDirectory,
                SGUtils.atob(step.script.code),
                step.lambdaDependencies,
                task.id
              )
            );
            const zipContents = fs.readFileSync(zipFilePath);
            lambdaCode.ZipFile = zipContents;
            handler = "index.handler";
          } else if (step.lambdaRuntime.toLowerCase().startsWith("python")) {
            zipFilePath = <string>(
              await SGUtils.CreateAWSLambdaZipFile_Python(
                workingDirectory,
                SGUtils.atob(step.script.code),
                step.lambdaDependencies,
                task.id
              )
            );
            const zipContents = fs.readFileSync(zipFilePath);
            lambdaCode.ZipFile = zipContents;
            handler = "lambda_function.lambda_handler";
          } else if (step.lambdaRuntime.toLowerCase().startsWith("ruby")) {
            zipFilePath = <string>(
              await SGUtils.CreateAWSLambdaZipFile_Ruby(
                workingDirectory,
                SGUtils.atob(step.script.code),
                step.lambdaDependencies,
                task.id
              )
            );
            const zipContents = fs.readFileSync(zipFilePath);
            lambdaCode.ZipFile = zipContents;
            handler = "lambda_function.lambda_handler";
          } else {
            appInst.LogError(`Unsupported lambda runtime`, "", {step});
            throw new Error("Unsupported lambda runtime");
          }
          const zipFileSizeMB: number = fs.statSync(zipFilePath).size / 1024.0 / 1024.0;
          if (zipFileSizeMB > 0) {
            let s3Path = `lambda/${task.id}`;
            let res: any = await SGUtils.RunCommand(`aws s3 cp ${zipFilePath} s3://${step.s3Bucket}/${s3Path}`, {});
            if (res.stderr != "" || res.code != 0) {
              appInst.LogError(`Error loading lambda function to S3`, "", {
                stderr: res.stderr,
                stdout: res.stdout,
                code: res.code,
              });
              throw new Error(`Error loading lambda function`);
            }
            lambdaCode.S3Bucket = step.s3Bucket;
            lambdaCode.S3Key = s3Path;
            delete lambdaCode.ZipFile;
            lambdaFileLoadedToSGAWS = true;
          }
        } else {
          let artifact: any = await this.RestAPICall(`artifact/${step.lambdaZipfile}`, "GET", {data: {_teamId}});
          lambdaCode.S3Bucket = step.s3Bucket;

          let s3Path = "";
          if (appInst.env != "production") {
            if (appInst.env == "unittest") s3Path += `debug/`;
            else s3Path += `${appInst.env}/`;
          }
          s3Path += `${_teamId}/`;

          if (artifact.prefix) s3Path += `${artifact.prefix}`;
          s3Path += artifact.name;

          lambdaCode.S3Key = s3Path;
          handler = step.lambdaFunctionHandler;
        }

        await SGUtils.CreateAWSLambda(
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

        if (zipFilePath) {
          try {
            if (fs.existsSync(zipFilePath)) fs.unlinkSync(zipFilePath);
          } catch (e) {}
        }

        let msg: string = `${new Date().toISOString()} Running AWS Lambda function\n`;
        runParams.lastXLines.push(msg);
        const updates: any = {
          _teamId: runParams._teamId,
          tail: runParams.lastXLines,
          stdout: msg,
          status: StepStatus.RUNNING,
          lastUpdateId: runParams.updateId,
        };
        await appInst.RestAPICall(`stepOutcome/${runParams.stepOutcomeId}`, "PUT", {data: updates});
        runParams.updateId += 1;

        let payload = {};
        if (step.variables) payload = Object.assign(payload, step.variables);
        runningProcesses[runParams.taskOutcomeId] = "no requestId yet";
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
            if (msgs[i].message.startsWith("START")) {
              const requestId = msgs[i].message.split(" ")[2];
              runningProcesses[runParams.taskOutcomeId] = `lambda ${requestId}`;
            } else {
              let msg = msgs[i].message.split("\t");
              if (msg.length > 2) {
                if (msg[2] == "ERROR") {
                  error = msg;
                  if (msg.length > 4) {
                    const jmsg = JSON.parse(msg[4]);
                    if ("stack" in jmsg) error += jmsg.stack + "\n";
                  }
                }
              }
            }
            runParams.queueTail.push(msgs[i]);
          }

          fs.writeSync(out, msgs.map((m) => m.message).join("\n"));
        });

        runParams.procFinished = true;

        await SGUtils.sleep(100);
        while (!runParams.stdoutAnalysisFinished) await SGUtils.sleep(100);

        fs.closeSync(out);

        if (runLambdaError) {
          appInst.LogError(runLambdaError.message, runLambdaError.stack, runLambdaError);
          error = "Unknown error occurred running lambda function";
        }
        if (runLambdaResult) {
          if (runLambdaResult.FunctionError && runLambdaResult.Payload) {
            let payload = JSON.parse(runLambdaResult.Payload);
            error = `errorType: ${payload.errorType} - errorMessage: ${payload.errorMessage} - stackTrace: ${payload.stackTrace}\n${error}`;
          }
        }

        let parseStdoutResult: any = {};
        if (fs.existsSync(stdoutFileName)) {
          parseStdoutResult = await this.ParseScriptStdout(
            stdoutFileName,
            task,
            true,
            runParams.stdoutBytesProcessed,
            runParams.stdoutTruncated
          );
          runParams.lastXLines = runParams.lastXLines
            .concat(parseStdoutResult.lastXLines)
            .slice(-appInst.numLinesInTail);
        } else {
          parseStdoutResult.output = "";
          parseStdoutResult.runtimeVars = {};
        }

        let runtimeVars: any = {};
        Object.assign(runtimeVars, parseStdoutResult.runtimeVars);

        let outParams: any = {
          lambdaDuration: runParams.lambdaDuration,
          lambdaBilledDuration: runParams.lambdaBilledDuration,
          lambdaMemSize: runParams.lambdaMemSize,
          lambdaMaxMemUsed: runParams.lambdaMaxMemUsed,
          lambdaInitDuration: runParams.lambdaInitDuration,
        };
        let code;
        if (error == "") {
          code = 0;
          outParams[SGStrings.status] = StepStatus.SUCCEEDED;
        } else {
          code = -1;
          runtimeVars["route"] = {value: "fail"};
          outParams[SGStrings.status] = StepStatus.FAILED;
          outParams["failureCode"] = TaskFailureCode.TASK_EXEC_ERROR;
        }

        outParams["runtimeVars"] = runtimeVars;
        outParams["dateCompleted"] = new Date().toISOString();
        outParams["stdout"] = parseStdoutResult.output;
        outParams["tail"] = runParams.lastXLines;
        outParams["stderr"] = error;
        outParams["exitCode"] = code;
        outParams["lastUpdateId"] = runParams.updateId + 1;
        outParams["_teamId"] = _teamId;

        await SGUtils.DeleteAWSLambda(task.id, step.lambdaAWSRegion);
        await SGUtils.DeleteCloudWatchLogsEvents(task.id);
        if (lambdaFileLoadedToSGAWS) {
          await SGUtils.RunCommand(`aws s3 rm s3://${lambdaCode.S3Bucket}/${lambdaCode.S3Key}`, {});
        }
        resolve(outParams);
      } catch (e) {
        let errMsg: string = e.message || e.toString();
        this.LogError("Error in RunStepAsync_Lambda", e.stack, SGUtils.errorToObj(e));
        await SGUtils.sleep(1000);
        error += errMsg + "\n";
        resolve({
          status: StepStatus.FAILED,
          code: -1,
          route: "fail",
          stderr: error,
          failureCode: TaskFailureCode.AGENT_EXEC_ERROR,
        });
      }
    });
  };

  RunStepAsync = async (
    step: StepSchema,
    workingDirectory: string,
    task: TaskSchema,
    stepOutcomeId: mongodb.ObjectId,
    lastUpdatedId: number,
    taskOutcomeId: mongodb.ObjectId
  ) => {
    const appInst = this;
    return new Promise(async (resolve, reject) => {
      try {
        let script = step.script;

        let scriptFileName = workingDirectory + path.sep + SGUtils.makeid(10);

        if (script.scriptType == ScriptType.NODE) {
          scriptFileName += ".js";
        } else if (script.scriptType == ScriptType.PYTHON) {
          scriptFileName += ".py";
        } else if (script.scriptType == ScriptType.SH) {
          scriptFileName += ".sh";
        } else if (script.scriptType == ScriptType.CMD) {
          scriptFileName += ".bat";
        } else if (script.scriptType == ScriptType.RUBY) {
          scriptFileName += ".rb";
        } else if (script.scriptType == ScriptType.LUA) {
          scriptFileName += ".lua";
        } else if (script.scriptType == ScriptType.PERL) {
          scriptFileName += ".pl";
        } else if (script.scriptType == ScriptType.PHP) {
          scriptFileName += ".php";
        } else if (script.scriptType == ScriptType.POWERSHELL) {
          scriptFileName += ".ps1";
        }

        // console.log('script -> ', JSON.stringify(script, null, 4));
        fs.writeFileSync(scriptFileName, SGUtils.atob(script.code));

        if (script.scriptType == ScriptType.SH) {
          await new Promise<null | any>(async (resolve, reject) => {
            fs.chmod(scriptFileName, 0o0755, (err) => {
              if (err) reject(err);
              resolve(null);
            });
          });
        }

        let commandString = "";
        if (step.command) {
          commandString = step.command.trim() + " ";
        } else {
          if (script.scriptType != ScriptType.CMD && script.scriptType != ScriptType.SH) {
            commandString += `${ScriptTypeDetails[ScriptType[script.scriptType.toString()]].cmd} `;
          }
        }
        commandString += scriptFileName;
        if (step.arguments) commandString += ` ${step.arguments}`;

        const stdoutFileName = workingDirectory + path.sep + SGUtils.makeid(10) + ".out";
        const stderrFileName = workingDirectory + path.sep + SGUtils.makeid(10) + ".err";

        const out = fs.openSync(stdoutFileName, "w");
        const err = fs.openSync(stderrFileName, "w");

        let updateId = lastUpdatedId + 1;
        let lastXLines: string[] = [];
        let rtvCumulative: any = {};
        let queueTail: any[] = [];
        let procFinished: boolean = false;
        let stdoutAnalysisFinished: boolean = false;
        let stdoutBytesProcessed: number = 0;
        let stdoutTruncated: boolean = false;

        /// tail the stdout
        let tail = new Tail(stdoutFileName, {useWatchFile: true, flushAtEOF: true});
        tail.on("line", async (data) => {
          if (process.platform.indexOf("win") != 0)
            try {
              if (fs.existsSync(scriptFileName)) fs.unlinkSync(scriptFileName);
            } catch (e) {}
          queueTail.push(data);
        });

        tail.on("error", function (error) {
          this.LogError("Error tailing stdout file", error.stack, {error: error.toString()});
        });

        let env: any = Object.assign({}, process.env);
        if (step.variables) env = Object.assign(env, step.variables);
        env.sgAgentId = this.InstanceId();
        env.teamId = task._teamId;
        env.jobId = task._jobId;
        env.taskId = task.id;
        env.stepId = step.id;

        let cmd = spawn(commandString, [], {
          stdio: ["ignore", out, err],
          shell: true,
          detached: false,
          env: env,
          cwd: workingDirectory,
        });

        runningProcesses[taskOutcomeId] = cmd;

        /// called if there is an error running the script
        cmd.on("error", (err) => {
          try {
            try {
              if (fs.existsSync(scriptFileName)) fs.unlinkSync(scriptFileName);
            } catch (e) {}

            // console.log('error: ' + err);
            this.LogError(`Error running script`, "", {error: err.toString()});
            resolve({
              status: StepStatus.FAILED,
              code: -1,
              route: "fail",
              stderr: err,
              failureCode: TaskFailureCode.AGENT_EXEC_ERROR,
            });
          } catch (e) {
            this.LogError("Error handling error event", e.stack, {error: e.message});
          }
        });

        /// called when external process completes
        cmd.on("exit", async (code, signal) => {
          try {
            try {
              if (fs.existsSync(scriptFileName)) fs.unlinkSync(scriptFileName);
            } catch (e) {}

            fs.closeSync(out);
            fs.closeSync(err);

            procFinished = true;
            tail.unwatch();

            await SGUtils.sleep(100);
            while (!stdoutAnalysisFinished) await SGUtils.sleep(100);

            let parseStdoutResult: any = {};
            if (fs.existsSync(stdoutFileName)) {
              parseStdoutResult = await this.ParseScriptStdout(
                stdoutFileName,
                task,
                true,
                stdoutBytesProcessed,
                stdoutTruncated
              );
              lastXLines = lastXLines.concat(parseStdoutResult.lastXLines).slice(-appInst.numLinesInTail);
            } else {
              parseStdoutResult.output = "";
              parseStdoutResult.runtimeVars = {};
            }

            let parseStderrResult: any = {};
            if (fs.existsSync(stderrFileName)) {
              parseStderrResult = await this.ParseScriptStderr(stderrFileName, task);
            } else {
              parseStderrResult.output = "";
            }

            let runtimeVars: any = {};
            let match: string[] = [];
            while ((match = regexStdoutRedirectFiles.exec(step.arguments)) !== null) {
              const fileName = match[1];
              let parseResult: any = {};
              parseResult = await this.ParseScriptStdout(workingDirectory + path.sep + fileName, task, false);
              Object.assign(runtimeVars, parseResult.runtimeVars);
            }

            Object.assign(runtimeVars, parseStdoutResult.runtimeVars);

            let outParams: any = {};
            if (code == 0) {
              outParams[SGStrings.status] = StepStatus.SUCCEEDED;
            } else {
              if (signal == "SIGTERM" || signal == "SIGINT" || this.mainProcessInterrupted) {
                runtimeVars["route"] = {value: "interrupt"};
                outParams[SGStrings.status] = StepStatus.INTERRUPTED;
              } else {
                runtimeVars["route"] = {value: "fail"};
                outParams[SGStrings.status] = StepStatus.FAILED;
                outParams["failureCode"] = TaskFailureCode.TASK_EXEC_ERROR;
              }
            }

            outParams["signal"] = signal;
            outParams["runtimeVars"] = runtimeVars;
            outParams["dateCompleted"] = new Date().toISOString();
            outParams["stdout"] = parseStdoutResult.output;
            outParams["tail"] = lastXLines;
            outParams["stderr"] = parseStderrResult.output;
            outParams["exitCode"] = code;
            outParams["lastUpdateId"] = updateId;

            resolve(outParams);
          } catch (e) {
            this.LogError("Error handling script exit", e.stack, {error: e.toString()});
            resolve({
              status: StepStatus.FAILED,
              code: -1,
              route: "fail",
              stderr: JSON.stringify(e),
              failureCode: TaskFailureCode.AGENT_EXEC_ERROR,
            });
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
              if (procFinished) break;
            }
            continue;
          }

          let data: string[] = queueTail.splice(0);
          try {
            let dataAsString = data.join("\n");
            if (!(task.target & (TaskDefTarget.ALL_AGENTS | TaskDefTarget.ALL_AGENTS_WITH_TAGS))) {
              const [rtv, newLine] = appInst.ExtractRuntimeVarsFromString(dataAsString);
              let rtvUpdates = {};
              for (let indexRTV = 0; indexRTV < Object.keys(rtv).length; indexRTV++) {
                let key = Object.keys(rtv)[indexRTV];
                if (!rtvCumulative[key] || rtvCumulative[key] != rtv[key]) {
                  rtvUpdates[key] = rtv[key];
                  rtvCumulative[key] = rtv[key];
                }
              }

              if (Object.keys(rtvUpdates).length > 0) {
                // console.log(`****************** taskOutcomeId -> ${taskOutcomeId}`);
                await appInst.RestAPICall(`taskOutcome/${taskOutcomeId}`, "PUT", {data: {runtimeVars: rtvUpdates}});
              }
            }

            lastXLines = lastXLines.concat(data).slice(-appInst.numLinesInTail);
            for (let i = 0; i < lastXLines.length; i++) {
              if (Buffer.byteLength(lastXLines[i], "utf8") > appInst.maxSizeLineInTail)
                lastXLines[i] = truncate(lastXLines[i], appInst.maxSizeLineInTail) + " (truncated)";
              lastXLines[i] = appInst.ReplaceSensitiveRuntimeVarValuesInString(lastXLines[i], task.runtimeVars);
            }

            while (true) {
              if (data.length < 1) break;

              let stdoutToUpload: string = "";
              let countLinesToUpload: number = 0;
              if (!stdoutTruncated) {
                const maxStdoutUploadSize: number = 51200;
                let stdoutBytesProcessedLocal: number = 0;
                for (let i = 0; i < data.length; i++) {
                  data[i] = appInst.ReplaceSensitiveRuntimeVarValuesInString(data[i], task.runtimeVars);
                  const strLenBytes = Buffer.byteLength(data[i], "utf8");
                  if (stdoutBytesProcessed + strLenBytes > appInst.maxStdoutSize) {
                    stdoutToUpload += "\n(max stdout size exceeded - results truncated)\n";
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
              const updates: any = {
                tail: lastXLines,
                stdout: stdoutToUpload,
                status: StepStatus.RUNNING,
                lastUpdateId: updateId,
              };
              updateId += 1;
              await appInst.RestAPICall(`stepOutcome/${stepOutcomeId}`, "PUT", {data: updates});

              if (stdoutTruncated) break;
            }
          } catch (err) {
            this.LogError(`Error handling stdout tail`, err.stack, SGUtils.errorToObj(err));
            await SGUtils.sleep(1000);
          }
        }
        stdoutAnalysisFinished = true;
      } catch (e) {
        this.LogError("Error in RunStepAsync", e.stack, SGUtils.errorToObj(e));
        await SGUtils.sleep(1000);
        resolve({
          status: StepStatus.FAILED,
          code: -1,
          route: "fail",
          stderr: e.message,
          failureCode: TaskFailureCode.AGENT_EXEC_ERROR,
        });
      }
    });
  };

  RunTask = async (task: TaskSchema) => {
    // this.LogDebug('Running task', { 'id': task.id });
    // console.log("Agent -> RunTask -> task -> ", util.inspect(task, false, null));
    let dateStarted = new Date().toISOString();

    let workingDirectory = process.cwd() + path.sep + SGUtils.makeid(10);

    if (!fs.existsSync(workingDirectory)) fs.mkdirSync(workingDirectory);

    try {
      let artifactsDownloadedSize: number = 0;
      if (task.artifacts) {
        for (let i = 0; i < task.artifacts.length; i++) {
          const getArtifactResult: any = await this.GetArtifact(task.artifacts[i], workingDirectory, this._teamId);
          if (!getArtifactResult.success) {
            this.logger.LogError(`Error downloading artifact`, "", {
              _artifactId: task.artifacts[i],
              error: getArtifactResult.error.toString(),
            });
            let execError;
            if (getArtifactResult.artifactName) {
              execError = "Error downloading artifact ";
              if (getArtifactResult.artifactPrefix) execError += `${getArtifactResult.artifactPrefix}/`;
              execError += `${getArtifactResult.artifactName}`;
            } else {
              execError = `Error downloading artifact - no artifact exists with id ${task.artifacts[i]}`;
            }
            let taskOutcome: any = {
              status: TaskStatus.FAILED,
              failureCode: TaskFailureCode.ARTIFACT_DOWNLOAD_ERROR,
              execError,
              ipAddress: this.ipAddress,
              machineId: this.MachineId(),
            };
            await this.RestAPICall(`taskOutcome/${task._taskOutcomeId}`, "PUT", {
              data: taskOutcome,
              retryWithBackoff: true,
            });
            throw {
              name: "ArtifactDownloadError",
            };
          }
          artifactsDownloadedSize += getArtifactResult.artifactSize;
        }
      }

      let allStepsCompleted = true;

      let stepsAsc: StepSchema[] = (<any>task).steps;
      // console.log('Agent -> RunTask -> stepsAsc -> beforesort -> ', util.inspect(stepsAsc, false, null));
      stepsAsc = stepsAsc.sort((a: StepSchema, b: StepSchema) => (a.order > b.order ? 1 : a.order < b.order ? -1 : 0));
      // console.log('Agent -> RunTask -> stepsAsc -> ', util.inspect(stepsAsc, false, null));

      let taskOutcome: any = {
        status: TaskStatus.RUNNING,
        dateStarted: dateStarted,
        ipAddress: this.ipAddress,
        machineId: this.MachineId(),
        artifactsDownloadedSize: artifactsDownloadedSize,
      };
      taskOutcome = await this.RestAPICall(`taskOutcome/${task._taskOutcomeId}`, "PUT", {
        data: taskOutcome,
        retryWithBackoff: true,
      });

      // console.log('taskOutcome -> POST -> ', util.inspect(taskOutcome, false, null));
      if (taskOutcome.status == TaskStatus.RUNNING) {
        let lastStepOutcome = undefined;
        for (let step of stepsAsc) {
          if (step.variables) {
            let newEnv: any = _.clone(step.variables);
            for (let e = 0; e < Object.keys(newEnv).length; e++) {
              let eKey = Object.keys(newEnv)[e];
              if (eKey in task.runtimeVars) {
                newEnv[eKey] = task.runtimeVars[eKey]["value"];
              }
            }
            step.variables = newEnv;
          }

          let newScript = await SGUtils.injectScripts(
            this._teamId,
            SGUtils.atob(step.script.code),
            task.scriptsToInject,
            this.LogError
          );
          step.script.code = SGUtils.btoa_(newScript);

          newScript = SGUtils.atob(step.script.code);
          let arrInjectVarsScript: string[] = newScript.match(/@sgg?(\([^)]*\))/gi);
          if (arrInjectVarsScript) {
            // replace runtime variables in script
            for (let i = 0; i < arrInjectVarsScript.length; i++) {
              let found: boolean = false;
              try {
                let injectVarKey = arrInjectVarsScript[i].substr(5, arrInjectVarsScript[i].length - 6);
                if (injectVarKey.substr(0, 1) === '"' && injectVarKey.substr(injectVarKey.length - 1, 1) === '"')
                  injectVarKey = injectVarKey.slice(1, -1);
                if (injectVarKey in task.runtimeVars) {
                  let injectVarVal = task.runtimeVars[injectVarKey].value;
                  newScript = newScript.replace(`${arrInjectVarsScript[i]}`, `${injectVarVal}`);
                  found = true;
                }

                if (!found) {
                  newScript = newScript.replace(`${arrInjectVarsScript[i]}`, "null");
                }
              } catch (e) {
                this.LogError(`Error replacing script @sgg capture `, e.stack, {
                  task,
                  capture: arrInjectVarsScript[i],
                  error: e.toString(),
                });
              }
            }
            step.script.code = SGUtils.btoa_(newScript);
          }

          let newArgs: string = step.arguments;
          let arrInjectVarsArgs: string[] = newArgs.match(/@sgg?(\([^)]*\))/gi);
          if (arrInjectVarsArgs) {
            // replace runtime variables in arguments
            for (let i = 0; i < arrInjectVarsArgs.length; i++) {
              let found: boolean = false;
              try {
                let injectVarKey = arrInjectVarsArgs[i].substr(5, arrInjectVarsArgs[i].length - 6);
                if (injectVarKey.substr(0, 1) === '"' && injectVarKey.substr(injectVarKey.length - 1, 1) === '"')
                  injectVarKey = injectVarKey.slice(1, -1);
                if (injectVarKey in task.runtimeVars) {
                  let injectVarVal = task.runtimeVars[injectVarKey].value;
                  if (injectVarVal) {
                    newArgs = newArgs.replace(`${arrInjectVarsArgs[i]}`, `${injectVarVal}`);
                    found = true;
                  }
                }

                if (!found) {
                  newArgs = newArgs.replace(`${arrInjectVarsArgs[i]}`, "null");
                }
              } catch (e) {
                this.LogError(`Error replacing arguments @sgg capture `, e.stack, {
                  task,
                  capture: arrInjectVarsScript[i],
                  error: e.toString(),
                });
              }
            }
            step.arguments = newArgs;
          }

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
            stepOutcome.ipAddress = "0.0.0.0";
            stepOutcome.machineId = "lambda-executor";
          }

          stepOutcome = <StepOutcomeSchema>(
            await this.RestAPICall(`stepOutcome`, "POST", {data: stepOutcome, retryWithBackoff: true})
          );

          // console.log('Agent -> RunTask -> RunStepAsync -> step -> ', util.inspect(step, false, null));
          let res: any;
          if (task.target == TaskDefTarget.AWS_LAMBDA) {
            res = await this.RunStepAsync_Lambda(
              step,
              workingDirectory,
              task,
              stepOutcome.id,
              stepOutcome.lastUpdateId,
              taskOutcome.id
            );
          } else {
            res = await this.RunStepAsync(
              step,
              workingDirectory,
              task,
              stepOutcome.id,
              stepOutcome.lastUpdateId,
              taskOutcome.id
            );
          }
          lastStepOutcome = res;
          if (task.target == TaskDefTarget.AWS_LAMBDA) {
            res._teamId = task._teamId;
          }
          // console.log("Agent -> RunTask -> RunStepAsync -> res -> ", util.inspect(res, false, null));

          this.queueAPICall.push({
            url: `stepOutcome/${stepOutcome.id}`,
            method: "PUT",
            headers: null,
            data: res,
          });

          Object.assign(task.runtimeVars, res.runtimeVars);
          Object.assign(taskOutcome.runtimeVars, res.runtimeVars);

          if (res.status === StepStatus.INTERRUPTED || res.status === StepStatus.FAILED) {
            allStepsCompleted = false;
            break;
          }
        }

        let dateCompleted = new Date().toISOString();

        if (allStepsCompleted) {
          taskOutcome.status = TaskStatus.SUCCEEDED;
        } else {
          if (lastStepOutcome) {
            taskOutcome.status = lastStepOutcome.status;
            if (lastStepOutcome.failureCode) taskOutcome.failureCode = lastStepOutcome.failureCode;
          } else {
            taskOutcome.status = TaskStatus.FAILED;
            taskOutcome.failureCode = TaskFailureCode.AGENT_EXEC_ERROR;
          }
        }

        let taskOutcomeUpdates: any = {};
        taskOutcomeUpdates.status = taskOutcome.status;
        if (taskOutcome.failureCode) taskOutcomeUpdates.failureCode = taskOutcome.failureCode;
        taskOutcomeUpdates.dateCompleted = dateCompleted;
        taskOutcomeUpdates.runtimeVars = taskOutcome.runtimeVars;

        if (task.target == TaskDefTarget.AWS_LAMBDA) taskOutcomeUpdates._teamId = task._teamId;
        // console.log(`???????????????????\n\ntaskOutcomeId -> ${taskOutcome.id}\n\ntaskOutcome -> ${JSON.stringify(taskOutcome)}\n\ntask -> ${JSON.stringify(task)}\n\ntaskOutcomeUpdates -> ${JSON.stringify(taskOutcomeUpdates)}`);
        this.queueAPICall.push({
          url: `taskOutcome/${taskOutcome.id}`,
          method: "PUT",
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
      const _teamId = params._teamId;
      const taskOutcomeId = params._taskOutcomeId;

      let taskOutcomeUpdates: any = {runtimeVars: {route: "fail"}};
      taskOutcomeUpdates.status = TaskStatus.FAILED;
      taskOutcomeUpdates.failureCode = TaskFailureCode.AGENT_EXEC_ERROR;
      taskOutcomeUpdates.dateCompleted = new Date().toISOString();
      this.queueAPICall.push({
        url: `taskOutcome/${taskOutcomeId.id}`,
        method: "PUT",
        headers: null,
        data: taskOutcomeUpdates,
      });

      delete runningProcesses[taskOutcomeId.id];
    } catch (e) {
      this.LogError("Error in CompleteTaskGeneralErrorHandler", e.stack, {error: e.toString()});
    }
  };

  CompleteTask = async (params: any, msgKey: string, cb: any) => {
    this.LogDebug("Task received", {msgKey, params});
    this.numActiveTasks += 1;
    try {
      if (this.numActiveTasks > this.maxActiveTasks) {
        cb(false, msgKey);
      } else {
        cb(true, msgKey);
        await this.RunTask(params);
      }
    } catch (e) {
      if (e.name && e.name == "ArtifactDownloadError") {
      } else {
        this.LogError("Error in CompleteTask", e.stack, {error: e.toString()});
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
      // await this.LogDebug('Update received', { msgKey, params });
      if (this.updating) {
        await this.LogWarning("Version update running - skipping this update", {});
        return;
      }

      if (this.stopping) {
        await this.LogWarning("Agent stopping - skipping this update", {});
        return;
      }

      if (params.targetVersion && params.reportedVersion) {
        if (params.targetVersion == params.reportedVersion || this.runStandAlone) {
          return;
        }

        this.updating = true;
        await this.LogDebug("Update Agent version message received", {msgKey, params});
        await SGUtils.sleep(2000);
        await this.StopConsuming();
        if (this.numActiveTasks > 0) await this.LogDebug("Updating Agent - waiting for current tasks to complete", {});
        while (this.numActiveTasks > 0) {
          await SGUtils.sleep(5000);
        }
        await this.LogWarning("Updating Agent - shutting down", {});
        process.exit(96);
      }

      if (params.tags) {
        await this.LogDebug("Update tags message received", {msgKey, params});
        this.tags = params.tags;
        this.updateUserConfigValues({tags: this.tags});
      }

      if (params.propertyOverrides) {
        await this.LogDebug("Update property overrides message received", {msgKey, params});

        // await cb(true, msgKey);
        await this.UpdatePropertyOverrides(params.propertyOverrides, "server");
        this.updateUserConfigValues({propertyOverrides: params.propertyOverrides});
        await this.SendHeartbeat(false, true);
        await this.SendMessageToAgentStub(params);
      }

      if (params.interruptTask) {
        await this.LogDebug("Interrupt task message received", {msgKey, params});
        const procToInterrupt = runningProcesses[params.interruptTask.id];
        if (procToInterrupt && typeof procToInterrupt == "object" && procToInterrupt.pid) {
          // console.log('Interrupting task');
          // procToInterrupt.stdin.pause();
          // console.log('stdin paused');
          procToInterrupt.kill();
          // console.log('Task interrupted');
        } else {
          const runtimeVars: any = {route: {value: "interrupt"}};
          let taskOutcomeUpdate: any = {
            status: TaskStatus.INTERRUPTED,
            runtimeVars: runtimeVars,
          };
          this.queueAPICall.push({
            url: `taskOutcome/${params.interruptTask.id}`,
            method: "PUT",
            headers: null,
            data: taskOutcomeUpdate,
          });
        }
      }

      if (params.stopAgent) {
        this.stopping = true;
        await this.LogDebug("Stop Agent message received", {msgKey, params});
        await SGUtils.sleep(2000);
        await this.StopConsuming();
        if (this.numActiveTasks > 0) await this.LogDebug("Stopping Agent - waiting for current tasks to complete", {});
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
      this.LogError(`Error in Update`, e.stack, {error: e.toString()});
    } finally {
      // this.lockUpdate.release();
    }
  };

  async UpdatePropertyOverrides(propertyOverrides: any, source: string) {
    if (!propertyOverrides) return;

    for (let i = 0; i < Object.keys(propertyOverrides).length; i++) {
      let key = Object.keys(propertyOverrides)[i];
      if (source == "debug" || this.userConfigurableProperties.indexOf(key) >= 0) {
        if (key == "logLevel") {
          if (propertyOverrides[key] != null) {
            this.logger.logLevel = propertyOverrides[key];
            let props = {};
            props[key] = propertyOverrides[key];
            await this.SendMessageToAgentStub({propertyOverrides: props});
          }
        } else {
          if (propertyOverrides[key] == null) {
            this[key] = undefined;
          } else {
            if (typeof this[key] === "number") this[key] = +propertyOverrides[key];
            else this[key] = propertyOverrides[key];
          }
        }
      }
    }
  }

  async CheckStompConnection() {
    if (this.stopped) return;

    // this.LogDebug('Starting CheckStompConnection', {});
    if (!(await this.stompConsumer.IsConnected(SGStrings.GetAgentQueue(this._teamId, this.instanceId.toHexString())))) {
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
          !(await this.stompConsumer.IsConnected(SGStrings.GetAgentQueue(this._teamId, this.instanceId.toHexString())))
        ) {
          this.LogError(`Not connected to RabbitMQ - attempting to connect`, "", {});
          await this.stompConsumer.Stop();
          await this.ConnectStomp();
        }
      },
      (err, ret) => {
        if (err) {
          this.LogError("Error in OnRabbitMQDisconnect", err.stack, {error: err.toString()});
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
      this.LogDebug("Connecting to stomp", {
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
        this.LogError("Error starting stomp - trying again in 30 seconds", e.stack, {error: e.toString()});
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
      this.LogError("Error in ConnectStomp", e.stack, {error: e.toString()});
      // setTimeout(() => { this.ConnectStomp(); }, 30000);
    }
  }

  async ConnectAgentWorkQueuesStomp() {
    let exchange = SGStrings.GetTeamExchangeName(this._teamId);
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
    let commandString: any = process.cwd() + "/sg-agent-launcher";
    try {
      spawn(commandString, [], {stdio: "pipe", shell: true});
      process.exit();
    } catch (e) {
      console.error(`Error starting agent launcher '${commandString}': ${e.message}`, e.stack);
    }
  }

  async GetCronTab() {
    const commandString: string = "crontab -l";
    const args = [];
    return new Promise<null | any>((resolve, reject) => {
      try {
        let stdout: string = "";
        // this.LogDebug('GetCronTab: ' + commandString + ' ' + args, {});
        let cmd: any = spawn(commandString, args, {stdio: "pipe", shell: true});

        cmd.stdout.on("data", (data) => {
          try {
            // this.LogDebug('GetCronTab on.stdout.data', { data: data.toString() });
            stdout = data.toString();
          } catch (e) {
            this.LogError("Error handling stdout in GetCronTab", e.stack, {error: e.toString()});
            resolve(null);
          }
        });

        cmd.on("exit", (code) => {
          try {
            resolve({code: code, stdout: stdout});
          } catch (e) {
            this.LogError("Error handling exit in GetCronTab", e.stack, {error: e.toString()});
            resolve(null);
          }
        });
      } catch (e) {
        this.LogError(`GetCronTab error`, e.stack, {commandString, error: e.toString()});
        resolve(null);
      }
    });
  }
}
