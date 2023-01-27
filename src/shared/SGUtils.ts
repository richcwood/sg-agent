import * as _ from "lodash";

import { zip } from "zip-a-folder";
import { exec } from "child_process";

import * as AWS from "aws-sdk";
import * as compressing from "compressing";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { AgentLogger } from "./SGAgentLogger";

AWS.config.apiVersions = {
  lambda: "2015-03-31",
  cloudwatchlogs: "2014-03-28",
};

export class SGUtils {
  static btoa_(str: string) {
    return Buffer.from(str).toString("base64");
  }

  static atob(b64Encoded: string) {
    return Buffer.from(b64Encoded, "base64").toString("utf8");
  }

  static makeid(len = 5, lettersOnly = false) {
    let text = "";
    let possible = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
    if (!lettersOnly) possible += "0123456789";

    for (let i = 0; i < len; i++)
      text += possible.charAt(Math.floor(Math.random() * possible.length));

    return text;
  }

  static removeItemFromArray(array: any[], item: any) {
    const index = array.indexOf(item);
    if (index > -1) array.splice(index, 1);
  }

  static async sleep(ms: number) {
    return new Promise((resolve) => {
      setTimeout(resolve, ms);
    });
  }

  static async injectScripts(
    _teamId: string,
    script_code: string,
    scriptsToInject: any,
    fnLogError: any
  ) {
    let newScript: string = script_code;
    const arrScriptsToInject: string[] = newScript.match(/@sgs?(\([^)]*\))/gi);
    if (arrScriptsToInject) {
      // replace runtime variables in script
      for (let i = 0; i < arrScriptsToInject.length; i++) {
        let found = false;
        try {
          let injectScriptKey = arrScriptsToInject[i].substr(
            5,
            arrScriptsToInject[i].length - 6
          );
          if (
            injectScriptKey.substr(0, 1) === '"' &&
            injectScriptKey.substr(injectScriptKey.length - 1, 1) === '"'
          )
            injectScriptKey = injectScriptKey.slice(1, -1);
          if (injectScriptKey in scriptsToInject) {
            const injectScriptVal = SGUtils.atob(
              scriptsToInject[injectScriptKey]
            );
            if (injectScriptVal) {
              newScript = newScript.replace(
                `${arrScriptsToInject[i]}`,
                `${injectScriptVal}`
              );
              newScript = await SGUtils.injectScripts(
                _teamId,
                newScript,
                scriptsToInject,
                fnLogError
              );
              found = true;
            }
          }

          if (!found) {
            newScript = newScript.replace(`${arrScriptsToInject[i]}`, "");
          }
        } catch (e) {
          fnLogError(
            `Error replacing script @sgs capture for string`,
            e.stack,
            {
              capture: arrScriptsToInject[i],
              error: e.toString(),
            }
          );
        }
      }
    }

    return newScript;
  }

  static getConfigFilePath() {
    let configPath = process.cwd();
    if (process.platform.indexOf("win") == 0) {
      if (configPath == "C:\\Windows\\system32")
        configPath = path.dirname(process.execPath);
    } else if (process.platform.indexOf("darwin") >= 0) {
      if (!fs.existsSync(path.join(configPath, "sg.cfg"))) {
        const daemonConfigPath = path.join(os.homedir(), ".saasglue");
        if (fs.existsSync(path.join(daemonConfigPath, "sg.cfg"))) {
          configPath = daemonConfigPath;
        }
      }
    } else if (process.platform.indexOf("linux") >= 0) {
      if (!fs.existsSync(path.join(configPath, "sg.cfg"))) {
        const daemonConfigPath = "/etc/saasglue";
        if (fs.existsSync(path.join(daemonConfigPath, "sg.cfg"))) {
          configPath = daemonConfigPath;
        }
      }
    }

    return path.join(configPath, "sg.cfg");
  }

  static getIpAddress() {
    const arrIPAddresses = [];
    const ifaces = os.networkInterfaces();

    Object.keys(ifaces).forEach(function (ifname) {
      ifaces[ifname].forEach(function (iface) {
        if ("IPv4" !== iface.family || iface.internal !== false) {
          // skip over internal (i.e. 127.0.0.1) and non-ipv4 addresses
          return;
        }

        arrIPAddresses.push(iface.address);
      });
    });

    if (arrIPAddresses.length === 0) return "missing";
    return arrIPAddresses.toString();
  }

  static async RunCommand(commandString: any, options: any) {
    return new Promise((resolve, reject) => {
      try {
        let stdout = "";
        let stderr = "";

        const cmd: any = exec(commandString, options);

        cmd.stdout.on("data", (data) => {
          try {
            const str = data.toString();
            stdout += str;
          } catch (e) {
            throw e;
          }
        });

        cmd.stderr.on("data", (data) => {
          try {
            stderr += data.toString();
          } catch (e) {
            throw e;
          }
        });

        cmd.on("exit", (code) => {
          try {
            resolve({ code: code, stdout: stdout, stderr: stderr });
          } catch (e) {
            throw e;
          }
        });
      } catch (e) {
        throw e;
      }
    });
  }

  static GetFileExt = (filePath: string) => {
    const index = filePath.lastIndexOf(".");
    if (index < 0) {
      return "";
    } else {
      return filePath.substr(index + 1);
    }
  };

  static ChangeFileExt = (filePath: string, ext: string) => {
    const index = filePath.lastIndexOf(".");
    if (index < 0) {
      if (ext == "") return filePath;
      else return filePath + "." + ext;
    }
    if (ext == "") return filePath.substr(0, index);
    return filePath.substr(0, index) + "." + ext;
  };

  static GzipFile = async (filePath: string) => {
    const compressedFilePath = filePath + ".gz";
    await new Promise<null | any>((resolve, reject) => {
      compressing.gzip
        .compressFile(filePath, compressedFilePath)
        .then(() => {
          resolve(null);
        })
        .catch((err) => {
          reject(err);
        });
    });

    return compressedFilePath;
  };

  static GunzipFile = async (filePath: string) => {
    const uncompressedFilePath = SGUtils.ChangeFileExt(filePath, "");
    await new Promise<void>((resolve, reject) => {
      compressing.gzip
        .uncompress(filePath, uncompressedFilePath)
        .then(() => {
          resolve();
        })
        .catch((err) => {
          reject(err);
        });
    });

    return uncompressedFilePath;
  };

  static ZipFolder = async (path: string) => {
    const compressedFilePath: string = SGUtils.ChangeFileExt(path, "zip");
    await zip(path, compressedFilePath);
    return compressedFilePath;
  };

  static GetCloudWatchLogsEvents = async (
    lambdaFnName: string,
    runParams: any,
    logger: AgentLogger,
    fnOnLogEvents: any
  ) => {
    return new Promise(async (resolve, reject) => {
      const cwl = new AWS.CloudWatchLogs();

      const logGroupName = `/aws/lambda/${lambdaFnName}`;

      const describeLogParams: any = {
        logGroupName,
        descending: true,
        orderBy: "LastEventTime",
      };

      const maxTries = 10;
      let numTries = 0;
      let logStreamName = "";
      while (numTries < maxTries && !runParams.runLambdaFinished) {
        logStreamName = await new Promise((resolve, reject) => {
          cwl.describeLogStreams(describeLogParams, function (err, data) {
            if (err) {
              if (err.message != "The specified log group does not exist.")
                logger.LogError(
                  "Error in GetCloudWatchLogsEvents.describeLogStreams",
                  err.stack,
                  {
                    error: err.toString(),
                  }
                );
              return resolve("");
            }

            // console.log('******** GetCloudWatchLogsEvents -> data -> ', data);

            if (data && "logStreams" in data && data.logStreams.length > 0) {
              resolve(data.logStreams[0].logStreamName);
            } else {
              resolve("");
            }
          });
        });

        if (logStreamName != "") break;

        if (runParams.runLambdaFinished) break;

        numTries += 1;
        // console.log('******** GetCloudWatchLogsEvents -> sleeping');
        await SGUtils.sleep(6000);
        // console.log('******** GetCloudWatchLogsEvents -> trying again -> numTries -> ', numTries, ', runParams.runLambdaFinished -> ', runParams.runLambdaFinished);
      }

      if (logStreamName == "") return resolve("Timeout retrieving logs");

      // console.log('******** GetCloudWatchLogsEvents -> logStreamName -> ', logStreamName);

      const nextToken = undefined;
      const getLogEventsParams: any = {
        logGroupName,
        logStreamName,
        startFromHead: true,
        limit: 10,
        nextToken,
      };

      while (true) {
        const res: any = await new Promise<null | any>((resolve, reject) => {
          cwl.getLogEvents(getLogEventsParams, async function (err, data) {
            if (err) {
              logger.LogError(
                "Error in GetCloudWatchLogsEvents.getLogEvents",
                err.stack,
                { error: err.toString() }
              );
              if (err.message == "Rate exceeded") await SGUtils.sleep(5000);
              return resolve(null);
            }
            if (data.events)
              return resolve({
                events: data.events,
                nextToken: data.nextForwardToken,
              });
            return resolve(null);
          });
        });

        if (res && res.events.length > 0) {
          fnOnLogEvents(res.events);
          let reachedLogEnd = false;
          for (let i = 0; i < res.events.length; i++) {
            if (res.events[i].message.startsWith("REPORT RequestId:")) {
              reachedLogEnd = true;
              break;
            }
          }

          if (reachedLogEnd) break;
        }

        if (res && res.nextToken) getLogEventsParams.nextToken = res.nextToken;

        await SGUtils.sleep(1000);
      }

      resolve("done");
    });
  };

  static CreateAWSLambdaZipFile_NodeJS = async (
    workingDir: string,
    script: string,
    lambdaDependencies: string,
    lambdaFnName: string
  ) => {
    return new Promise(async (resolve, reject) => {
      try {
        const indexFilePath = workingDir + path.sep + "index.js";
        const runFilePath = workingDir + path.sep + lambdaFnName + ".js";

        const lstLambdaDependencies = lambdaDependencies
          .split(";")
          .filter((li) => li.trim());
        if (lstLambdaDependencies.length > 0) {
          const res: any = await SGUtils.RunCommand(`npm init -y`, {
            cwd: workingDir,
          });
          if (res.code != 0)
            throw new Error(
              `Error installing dependencies: [stderr = ${res.stderr}, stdout = ${res.stdout}]`
            );

          for (let i = 0; i < lstLambdaDependencies.length; i++) {
            const res: any = await SGUtils.RunCommand(
              `npm i --save ${lstLambdaDependencies[i]}`,
              { cwd: workingDir }
            );
            if (res.code != 0) {
              throw new Error(
                `Error installing dependency "${lstLambdaDependencies[i]}": [stderr = ${res.stderr}, stdout = ${res.stdout}]`
              );
            }
          }
        }

        const code = `
const child_process_1 = require("child_process");


let RunCommand = async (commandString, options={}) => {
    return new Promise((resolve, reject) => {
        try {
            let stdout = '';
            let stderr = '';
            let cmd = child_process_1.exec(commandString, options);
            cmd.stdout.on('data', (data) => {
                console.log(data.toString());
            });
            cmd.stderr.on('data', (data) => {
                console.error(data.toString());
            });
            cmd.on('exit', (code) => {
                try {
                    resolve({ 'code': code, 'stderr': stderr });
                }
                catch (e) {
                    throw e;
                }
            });
        }
        catch (e) {
            throw e;
        }
    });
};


exports.handler = async (event, context) => {
    let res = await RunCommand('node ${lambdaFnName}.js');

    return res;
};
                `;

        fs.writeFileSync(indexFilePath, code);

        fs.writeFileSync(runFilePath, script);

        const compressedFilePath: string = await SGUtils.ZipFolder(
          path.dirname(indexFilePath)
        );
        resolve(compressedFilePath);
      } catch (e) {
        reject(e);
      }
    });
  };

  static CreateAWSLambdaZipFile_Python = async (
    workingDir: string,
    script: string,
    lambdaDependencies: string,
    lambdaFnName: string
  ) => {
    return new Promise(async (resolve, reject) => {
      try {
        const indexFilePath = workingDir + path.sep + "lambda_function.py";
        const runFilePath = workingDir + path.sep + lambdaFnName + ".py";

        const lstLambdaDependencies = lambdaDependencies
          .split(";")
          .filter((li) => li.trim());
        if (lstLambdaDependencies.length > 0) {
          for (let i = 0; i < lstLambdaDependencies.length; i++) {
            const res: any = await SGUtils.RunCommand(
              `pip install ${lstLambdaDependencies[i]} -t .`,
              { cwd: workingDir }
            );
            if (res.code != 0) {
              throw new Error(
                `Error installing dependency "${lstLambdaDependencies[i]}": [stderr = ${res.stderr}, stdout = ${res.stdout}]`
              );
            }
          }
        }

        const code = `
import json

def lambda_handler(event, context):
    __import__('${lambdaFnName}')
    return {
        'statusCode': 200
    }
`;
        fs.writeFileSync(indexFilePath, code);

        fs.writeFileSync(runFilePath, script);

        const compressedFilePath: string = await SGUtils.ZipFolder(
          path.dirname(indexFilePath)
        );
        resolve(compressedFilePath);
      } catch (e) {
        reject(e);
      }
    });
  };

  static CreateAWSLambdaZipFile_Ruby = async (
    workingDir: string,
    script: string,
    lambdaDependencies: string,
    lambdaFnName: string
  ) => {
    return new Promise(async (resolve, reject) => {
      try {
        const indexFilePath = workingDir + path.sep + "lambda_function.rb";
        const runFilePath = workingDir + path.sep + lambdaFnName + ".rb";

        const lstLambdaDependencies = lambdaDependencies
          .split(";")
          .filter((li) => li.trim());
        if (lstLambdaDependencies.length > 0) {
          let res: any = await SGUtils.RunCommand(`bundle init`, {
            cwd: workingDir,
          });
          if (res.code != 0)
            throw new Error(
              `Error installing dependencies: [stderr = ${res.stderr}, stdout = ${res.stdout}]`
            );

          for (let i = 0; i < lstLambdaDependencies.length; i++) {
            const res: any = await SGUtils.RunCommand(
              `bundle add ${lstLambdaDependencies[i]} --skip-install`,
              {
                cwd: workingDir,
              }
            );
            if (res.code != 0) {
              throw new Error(
                `Error installing dependency "${lstLambdaDependencies[i]}": [stderr = ${res.stderr}, stdout = ${res.stdout}]`
              );
            }
          }

          res = await SGUtils.RunCommand(`bundle install --path ./`, {
            cwd: workingDir,
          });
          if (res.code != 0)
            throw new Error(
              `Error installing dependencies: [stderr = ${res.stderr}, stdout = ${res.stdout}]`
            );
        }

        const code = `
def lambda_handler(event:, context:)

    success = system("ruby", "${lambdaFnName}.rb")

{ statusCode: 200 }
end
`;
        fs.writeFileSync(indexFilePath, code);

        fs.writeFileSync(runFilePath, script);

        const compressedFilePath: string = await SGUtils.ZipFolder(
          path.dirname(indexFilePath)
        );
        resolve(compressedFilePath);
      } catch (e) {
        reject(e);
      }
    });
  };

  static DeleteCloudWatchLogsEvents = async (lambdaFnName: string) => {
    return new Promise(async (resolve, reject) => {
      const cwl = new AWS.CloudWatchLogs();

      const logGroupName = `/aws/lambda/${lambdaFnName}`;

      const deleteLogParams: any = {
        logGroupName,
      };

      cwl.deleteLogGroup(deleteLogParams, function (err, data) {
        // if (err) {
        //     if (err.message != 'The specified log group does not exist.')
        //         reject(err);
        // }
        resolve("");
      });
    });
  };

  static CreateAWSLambda = async (
    teamId: string,
    jobId: string,
    taskId: string,
    stepId: string,
    lambdaRole: string,
    lambdaFnName: string,
    code: any,
    runtime: string,
    memorySize: number,
    timeout: number,
    awsRegion: string,
    handler: string
  ) => {
    return new Promise(async (resolve, reject) => {
      const params: any = {
        Description: `Lambda function ${lambdaFnName}`,
        FunctionName: lambdaFnName,
        Handler: handler,
        MemorySize: memorySize,
        Publish: true,
        Role: lambdaRole,
        Runtime: runtime,
        Tags: {
          TeamId: teamId,
          JobId: jobId,
        },
        Environment: {
          Variables: {
            teamId: teamId,
            jobId: jobId,
            taskId: taskId,
            stepId: stepId,
          },
        },
        Timeout: timeout,
        Code: code,
      };

      AWS.config.region = awsRegion;

      const lambda = new AWS.Lambda({ maxRetries: 10 });
      lambda.createFunction(params, async function (err, data) {
        if (err) {
          reject(err);
        }
        const maxTries = 10;
        let tryCount = 0;
        while (true) {
          tryCount += 1;
          const lambdaFn = await new Promise(async (resolve, reject) => {
            lambda.getFunction({ FunctionName: lambdaFnName }, function (e, d) {
              if (e) reject(e);
              resolve(d);
            });
          });
          if (lambdaFn["Configuration"]["State"] == "Active") {
            break;
          } else if (tryCount < maxTries) {
            await SGUtils.sleep(5000);
          } else {
            reject("Timeout waiting for lambda function to be active");
            break;
          }
        }
        resolve(data);
      });
    });
  };

  static RunAWSLambda = async (
    lambdaFnName: string,
    awsRegion: string,
    payload: any,
    cb: any
  ) => {
    const params = {
      FunctionName: lambdaFnName,
      Payload: JSON.stringify(payload),
    };

    AWS.config.region = awsRegion;

    const lambda = new AWS.Lambda();
    lambda.invoke(params, cb);
  };

  static DeleteAWSLambda = async (lambdaFnName: string, awsRegion: string) => {
    return new Promise(async (resolve, reject) => {
      const params: any = {
        FunctionName: lambdaFnName,
      };

      AWS.config.region = awsRegion;

      const lambda = new AWS.Lambda();
      lambda.deleteFunction(params, function (err, data) {
        // if (err) {
        //     if (err.message != 'The specified log group does not exist.')
        //         reject(err);
        // }
        resolve(data);
      });
    });
  };

  // try to convert a string in form key1=val1,key2=val2 etc. to a map
  static TagsStringToMap = (input: string): { [key: string]: string } => {
    const map = {};

    if (_.isString(input) && input.trim()) {
      const items = input.split(",");

      try {
        items.map((item: string) => {
          const itemSplit = item.split("=");
          if (
            itemSplit.length === 2 &&
            itemSplit[0].trim() &&
            itemSplit[1].trim()
          ) {
            map[itemSplit[0].trim()] = itemSplit[1].trim();
          } else {
            throw `Item entry not correct: ${item}`;
          }
        });
      } catch (err) {
        throw `Badly formed map string: ${input}, ${err}`;
      }
    }

    return map;
  };
}
