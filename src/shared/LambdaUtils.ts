import * as _ from 'lodash';

import * as AWS from 'aws-sdk';
import * as fs from 'fs';
import * as path from 'path';

import { AgentLogger } from './SGAgentLogger';
import { StepSchema } from '../domain/Step';
import { TaskSchema } from '../domain/Task';
import { SGUtils } from './SGUtils';
import { StepStatus } from './Enums';

AWS.config.apiVersions = {
    lambda: '2015-03-31',
    cloudwatchlogs: '2014-03-28',
};

export class LambdaUtils {
    static GetCloudWatchLogsEvents = async (
        lambdaFnName: string,
        stateVars: any,
        logger: AgentLogger,
        fnOnLogEvents: any
    ): Promise<string> => {
        const cwl = new AWS.CloudWatchLogs();

        const logGroupName = `/aws/lambda/${lambdaFnName}`;

        const describeLogParams: any = {
            logGroupName,
            descending: true,
            orderBy: 'LastEventTime',
        };

        const maxTries = 10;
        let numTries = 0;
        let logStreamName = '';
        while (numTries < maxTries && !stateVars.runLambdaFinished) {
            logStreamName = await new Promise((resolve) => {
                cwl.describeLogStreams(describeLogParams, function (err, data) {
                    if (err) {
                        if (err.message != 'The specified log group does not exist.')
                            logger.LogError('Error in GetCloudWatchLogsEvents.describeLogStreams', err.stack, {
                                error: err.toString(),
                            });
                        return resolve('');
                    }

                    if (data && 'logStreams' in data && data.logStreams.length > 0) {
                        resolve(data.logStreams[0].logStreamName);
                    } else {
                        resolve('');
                    }
                });
            });

            if (logStreamName != '') break;

            if (stateVars.runLambdaFinished) break;

            numTries += 1;
            await SGUtils.sleep(6000);
        }

        if (logStreamName == '') return 'Timeout retrieving logs';

        const nextToken = undefined;
        const getLogEventsParams: any = {
            logGroupName,
            logStreamName,
            startFromHead: true,
            limit: 10,
            nextToken,
        };

        while (true) {
            const res: any = await new Promise<null | any>((resolve) => {
                cwl.getLogEvents(getLogEventsParams, async function (err, data) {
                    if (err) {
                        logger.LogError('Error in GetCloudWatchLogsEvents.getLogEvents', err.stack, {
                            error: err.toString(),
                        });
                        if (err.message == 'Rate exceeded') await SGUtils.sleep(5000);
                        resolve(null);
                    }
                    if (data.events) {
                        resolve({
                            events: data.events,
                            nextToken: data.nextForwardToken,
                        });
                    }
                    resolve(null);
                });
            });

            if (res && res.events.length > 0) {
                fnOnLogEvents(res.events);
                let reachedLogEnd = false;
                for (let i = 0; i < res.events.length; i++) {
                    if (res.events[i].message.startsWith('REPORT RequestId:')) {
                        reachedLogEnd = true;
                        break;
                    }
                }

                if (reachedLogEnd) break;
            }

            if (res && res.nextToken) getLogEventsParams.nextToken = res.nextToken;

            await SGUtils.sleep(1000);
        }

        return 'done';
    };

    static CreateAWSLambdaZipFile_NodeJS = async (
        workingDir: string,
        script: string,
        lambdaDependencies: string,
        lambdaFnName: string
    ): Promise<string> => {
        const indexFilePath = workingDir + path.sep + 'index.js';
        const runFilePath = workingDir + path.sep + lambdaFnName + '.js';

        const lstLambdaDependencies = lambdaDependencies.split(';').filter((li) => li.trim());
        if (lstLambdaDependencies.length > 0) {
            const res: any = await SGUtils.RunCommand(`npm init -y`, {
                cwd: workingDir,
            });
            if (res.code != 0)
                throw new Error(`Error installing dependencies: [stderr = ${res.stderr}, stdout = ${res.stdout}]`);

            for (let i = 0; i < lstLambdaDependencies.length; i++) {
                const res: any = await SGUtils.RunCommand(`npm i --save ${lstLambdaDependencies[i]}`, {
                    cwd: workingDir,
                });
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
        const compressedFilePath: string = await SGUtils.ZipFolder(path.dirname(indexFilePath));

        return compressedFilePath;
    };

    static CreateAWSLambdaZipFile_Python = async (
        workingDir: string,
        script: string,
        lambdaDependencies: string,
        lambdaFnName: string
    ): Promise<string> => {
        const indexFilePath = workingDir + path.sep + 'lambda_function.py';
        const runFilePath = workingDir + path.sep + lambdaFnName + '.py';

        const lstLambdaDependencies = lambdaDependencies.split(';').filter((li) => li.trim());
        if (lstLambdaDependencies.length > 0) {
            for (let i = 0; i < lstLambdaDependencies.length; i++) {
                const res: any = await SGUtils.RunCommand(`pip install ${lstLambdaDependencies[i]} -t .`, {
                    cwd: workingDir,
                });
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

        const compressedFilePath: string = await SGUtils.ZipFolder(path.dirname(indexFilePath));
        return compressedFilePath;
    };

    static CreateAWSLambdaZipFile_Ruby = async (
        workingDir: string,
        script: string,
        lambdaDependencies: string,
        lambdaFnName: string
    ): Promise<string> => {
        const indexFilePath = workingDir + path.sep + 'lambda_function.rb';
        const runFilePath = workingDir + path.sep + lambdaFnName + '.rb';

        const lstLambdaDependencies = lambdaDependencies.split(';').filter((li) => li.trim());
        if (lstLambdaDependencies.length > 0) {
            let res: any = await SGUtils.RunCommand(`bundle init`, {
                cwd: workingDir,
            });
            if (res.code != 0)
                throw new Error(`Error installing dependencies: [stderr = ${res.stderr}, stdout = ${res.stdout}]`);

            for (let i = 0; i < lstLambdaDependencies.length; i++) {
                const res: any = await SGUtils.RunCommand(`bundle add ${lstLambdaDependencies[i]} --skip-install`, {
                    cwd: workingDir,
                });
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
                throw new Error(`Error installing dependencies: [stderr = ${res.stderr}, stdout = ${res.stdout}]`);
        }

        const code = `
def lambda_handler(event:, context:)

    success = system("ruby", "${lambdaFnName}.rb")

{ statusCode: 200 }
end
`;
        fs.writeFileSync(indexFilePath, code);
        fs.writeFileSync(runFilePath, script);
        const compressedFilePath: string = await SGUtils.ZipFolder(path.dirname(indexFilePath));

        return compressedFilePath;
    };

    static DeleteCloudWatchLogsEvents = async (lambdaFnName: string) => {
        const cwl = new AWS.CloudWatchLogs();

        const logGroupName = `/aws/lambda/${lambdaFnName}`;

        const deleteLogParams: any = {
            logGroupName,
        };

        cwl.deleteLogGroup(deleteLogParams, function () {
            // if (err) {
            //     if (err.message != 'The specified log group does not exist.')
            //         reject(err);
            // }
        });
    };

    static ExtractUsageDataFromLambdaLog(data: any[]): any {
        const usageData: any = {};
        for (let i = 0; i < data.length; i++) {
            const msg = data[i];
            if (msg.startsWith('REPORT ')) {
                const elems: string[] = msg.split('\t');
                for (let j = 0; j < elems.length; j++) {
                    const elem: string = elems[j];
                    if (elem.startsWith('Duration: ')) {
                        try {
                            usageData.lambdaDuration = Number(
                                elem.split(':').slice(1, 3).join(' ').trim().split(' ')[0]
                            );
                        } catch (err) {
                            // continue regardless of error
                        }
                    } else if (elem.startsWith('Billed Duration: ')) {
                        try {
                            usageData.lambdaBilledDuration = Number(
                                elem.split(':').slice(1, 3).join(' ').trim().split(' ')[0]
                            );
                        } catch (err) {
                            // continue regardless of error
                        }
                    } else if (elem.startsWith('Memory Size: ')) {
                        try {
                            usageData.lambdaMemSize = Number(
                                elem.split(':').slice(1, 3).join(' ').trim().split(' ')[0]
                            );
                        } catch (err) {
                            // continue regardless of error
                        }
                    } else if (elem.startsWith('Max Memory Used: ')) {
                        try {
                            usageData.lambdaMaxMemUsed = Number(
                                elem.split(':').slice(1, 3).join(' ').trim().split(' ')[0]
                            );
                        } catch (err) {
                            // continue regardless of error
                        }
                    } else if (elem.startsWith('Init Duration: ')) {
                        try {
                            usageData.lambdaInitDuration = Number(
                                elem.split(':').slice(1, 3).join(' ').trim().split(' ')[0]
                            );
                        } catch (err) {
                            // continue regardless of error
                        }
                    }
                }
            }
        }

        return usageData;
    }

    static CreateAWSLambdaZipFile = async (
        step: StepSchema,
        task: TaskSchema,
        stateVars,
        workingDirectory: any,
        LogError: any
    ): Promise<any> => {
        let lambdaFileLoadedToSGAWS = false;
        let handler = '';
        const lambdaCode: any = {};
        if (step.lambdaRuntime.toLowerCase().startsWith('node')) {
            stateVars.zipFilePath = <string>(
                await LambdaUtils.CreateAWSLambdaZipFile_NodeJS(
                    workingDirectory,
                    SGUtils.atob(step.script.code),
                    step.lambdaDependencies,
                    task.id
                )
            );
            const zipContents = fs.readFileSync(stateVars.zipFilePath);
            lambdaCode.ZipFile = zipContents;
            handler = 'index.handler';
        } else if (step.lambdaRuntime.toLowerCase().startsWith('python')) {
            stateVars.zipFilePath = <string>(
                await LambdaUtils.CreateAWSLambdaZipFile_Python(
                    workingDirectory,
                    SGUtils.atob(step.script.code),
                    step.lambdaDependencies,
                    task.id
                )
            );
            const zipContents = fs.readFileSync(stateVars.zipFilePath);
            lambdaCode.ZipFile = zipContents;
            handler = 'lambda_function.lambda_handler';
        } else if (step.lambdaRuntime.toLowerCase().startsWith('ruby')) {
            stateVars.zipFilePath = <string>(
                await LambdaUtils.CreateAWSLambdaZipFile_Ruby(
                    workingDirectory,
                    SGUtils.atob(step.script.code),
                    step.lambdaDependencies,
                    task.id
                )
            );
            const zipContents = fs.readFileSync(stateVars.zipFilePath);
            lambdaCode.ZipFile = zipContents;
            handler = 'lambda_function.lambda_handler';
        } else {
            LogError(`Unsupported lambda runtime`, '', { step });
            throw new Error('Unsupported lambda runtime');
        }
        const zipFileSizeMB: number = fs.statSync(stateVars.zipFilePath).size / 1024.0 / 1024.0;
        if (zipFileSizeMB > 0) {
            const s3Path = `lambda/${task.id}`;
            const res = await SGUtils.RunCommand(
                `aws s3 cp ${stateVars.zipFilePath} s3://${step.s3Bucket}/${s3Path}`,
                {}
            );
            if (res.stderr != '' || res.code != 0) {
                LogError(`Error loading lambda function to S3`, '', {
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

        return { handler, lambdaCode, lambdaFileLoadedToSGAWS };
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
    ): Promise<any> => {
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
        return new Promise((resolve, reject) => {
            lambda.createFunction(params, async function (err, data) {
                if (err) {
                    return reject(err);
                }
                const maxTries = 10;
                let tryCount = 0;
                while (true) {
                    tryCount += 1;
                    try {
                        const lambdaFn = await new Promise((resolve, reject) => {
                            lambda.getFunction({ FunctionName: lambdaFnName }, function (e, d) {
                                if (e) {
                                    return reject(e);
                                }
                                return resolve(d);
                            });
                        });
                        if (
                            lambdaFn &&
                            lambdaFn['Configuration'] &&
                            lambdaFn['Configuration']['State'] &&
                            lambdaFn['Configuration']['State'] == 'Active'
                        )
                            break;
                    } catch (e) {
                        if (tryCount < maxTries) {
                            await SGUtils.sleep(5000);
                        } else {
                            throw new Error('Timeout waiting for lambda function to be active');
                        }
                    }
                }
                return resolve(data);
            });
        });
    };

    static RunAWSLambda = async (lambdaFnName: string, awsRegion: string, payload: any, cb: any) => {
        const params = {
            FunctionName: lambdaFnName,
            Payload: JSON.stringify(payload),
        };

        AWS.config.region = awsRegion;

        const lambda = new AWS.Lambda();
        lambda.invoke(params, cb);
    };

    static DeleteAWSLambda = async (lambdaFnName: string, awsRegion: string): Promise<any> => {
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
            return data;
        });
    };
}
