import * as _ from 'lodash';

import { zip } from 'zip-a-folder';
import { exec } from 'child_process';

import * as compressing from 'compressing';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { TaskSchema } from '../domain/Task';

export class SGUtils {
    static btoa_(str: string) {
        return Buffer.from(str).toString('base64');
    }

    static atob(b64Encoded: string) {
        return Buffer.from(b64Encoded, 'base64').toString('utf8');
    }

    static makeid(len = 5, lettersOnly = false) {
        let text = '';
        let possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
        if (!lettersOnly) possible += '0123456789';

        for (let i = 0; i < len; i++) text += possible.charAt(Math.floor(Math.random() * possible.length));

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

    static errorToObj(e: any) {
        if (e.constructor != Object) return { error: e.toString() };
        return e;
    }

    static FindClosingBracket(input: string, startIndex: number): number {
        const stack: number[] = [];
        let i: number;

        for (i = startIndex; i < input.length; i++) {
            const char = input[i];

            if (char === '{') {
                stack.push(i); // Save the index of the opening bracket
            } else if (char === '}') {
                if (stack.length === 0) {
                    // No matching opening bracket
                    return -1;
                } else {
                    stack.pop(); // Matched with a corresponding opening bracket
                    if (stack.length === 0) {
                        // Found the closing bracket for the initially provided opening bracket
                        return i;
                    }
                }
            }
        }

        // If the loop completes without finding a matching closing bracket
        return -1;
    }

    static FindNextSGO(line: string, startIndex: number): { sgoString: string; endIndex: number } | null {
        let sgoStartIndex = line.indexOf('@sgo{', startIndex);
        if (sgoStartIndex === -1) return null;
        sgoStartIndex += 4;
        const sgoEndIndex = SGUtils.FindClosingBracket(line, sgoStartIndex);
        if (sgoEndIndex === -1) return null;
        return { sgoString: line.slice(sgoStartIndex, sgoEndIndex + 1), endIndex: sgoEndIndex };
    }

    static ExtractRuntimeVarsFromString(line: string) {
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
        let findNextSGOResult = SGUtils.FindNextSGO(line, 0);
        while (findNextSGOResult) {
            const sgoString = findNextSGOResult['sgoString'];
            const sgoStringEndIndex = findNextSGOResult['endIndex'];
            const sgoObject = JSON.parse(sgoString);
            const [k, v] = Object.entries(sgoObject)[0];
            const sgoValueAsString: string = JSON.stringify(v);
            const rtVar = fnRtVar(k, sgoValueAsString);
            runtimeVars = Object.assign(runtimeVars, rtVar);

            const [key, value] = Object.entries(rtVar)[0];
            if (value['sensitive']) {
                const newVal = sgoString.replace(sgoValueAsString, `**${key}**`);
                line = line.replace(sgoString, newVal);
            }

            findNextSGOResult = SGUtils.FindNextSGO(line, sgoStringEndIndex);
        }

        return { runtimeVars, line };
    }

    static ReplaceSensitiveRuntimeVarValuesInString(line: string, rtVars: any) {
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

    static InjectScripts(_teamId: string, script: string, scriptsToInject: any, fnLogError: any): string {
        const arrScriptsToInject: string[] = script.match(/@sgs?(\([^)]*\))/gi);
        if (arrScriptsToInject) {
            // replace runtime variables in script
            for (let i = 0; i < arrScriptsToInject.length; i++) {
                let found = false;
                try {
                    let injectScriptKey = arrScriptsToInject[i].substr(5, arrScriptsToInject[i].length - 6);
                    if (
                        injectScriptKey.substr(0, 1) === '"' &&
                        injectScriptKey.substr(injectScriptKey.length - 1, 1) === '"'
                    )
                        injectScriptKey = injectScriptKey.slice(1, -1);
                    if (injectScriptKey in scriptsToInject) {
                        const injectScriptVal = SGUtils.atob(scriptsToInject[injectScriptKey]);
                        if (injectScriptVal) {
                            script = script.replace(`${arrScriptsToInject[i]}`, `${injectScriptVal}`);
                            script = SGUtils.InjectScripts(_teamId, script, scriptsToInject, fnLogError);
                            found = true;
                        }
                    }

                    if (!found) {
                        script = script.replace(`${arrScriptsToInject[i]}`, '');
                    }
                } catch (e) {
                    fnLogError(`Error replacing script @sgs capture for string`, e.stack, {
                        capture: arrScriptsToInject[i],
                        error: e.toString(),
                    });
                }
            }
        }

        return script;
    }

    static InjectRuntimeVarsInScript(task: TaskSchema, script: string, errorLogger: any): string {
        const arrInjectVarsScript: string[] = script.match(/@sgg?(\([^)]*\))/gi);
        if (arrInjectVarsScript) {
            // replace runtime variables in script
            for (let i = 0; i < arrInjectVarsScript.length; i++) {
                let found = false;
                try {
                    let injectVarKey = arrInjectVarsScript[i].substr(5, arrInjectVarsScript[i].length - 6);
                    if (injectVarKey.substr(0, 1) === '"' && injectVarKey.substr(injectVarKey.length - 1, 1) === '"')
                        injectVarKey = injectVarKey.slice(1, -1);
                    if (injectVarKey in task.runtimeVars) {
                        const injectVarVal = task.runtimeVars[injectVarKey].value;
                        script = script.replace(`${arrInjectVarsScript[i]}`, `${injectVarVal}`);
                        found = true;
                    }

                    if (!found) {
                        script = script.replace(`${arrInjectVarsScript[i]}`, 'null');
                    }
                } catch (e) {
                    errorLogger(`Error replacing script @sgg capture `, e.stack, {
                        task,
                        capture: arrInjectVarsScript[i],
                        error: e.toString(),
                    });
                }
            }
        }
        return script;
    }

    static InjectRuntimeVarsInArg(task: TaskSchema, args: string, errorLogger: any): string {
        const arrInjectVarsArgs: string[] = args.match(/@sgg?(\([^)]*\))/gi);
        if (arrInjectVarsArgs) {
            // replace runtime variables in arguments
            for (let i = 0; i < arrInjectVarsArgs.length; i++) {
                let found = false;
                try {
                    let injectVarKey = arrInjectVarsArgs[i].substr(5, arrInjectVarsArgs[i].length - 6);
                    if (injectVarKey.substr(0, 1) === '"' && injectVarKey.substr(injectVarKey.length - 1, 1) === '"')
                        injectVarKey = injectVarKey.slice(1, -1);
                    if (injectVarKey in task.runtimeVars) {
                        const injectVarVal = task.runtimeVars[injectVarKey].value;
                        if (injectVarVal) {
                            args = args.replace(`${arrInjectVarsArgs[i]}`, `${injectVarVal}`);
                            found = true;
                        }
                    }

                    if (!found) {
                        args = args.replace(`${arrInjectVarsArgs[i]}`, 'null');
                    }
                } catch (e) {
                    errorLogger(`Error replacing arguments @sgg capture `, e.stack, {
                        task,
                        capture: arrInjectVarsArgs[i],
                        error: e.toString(),
                    });
                }
            }
        }
        return args;
    }

    static getConfigFilePath() {
        let configPath = process.cwd();
        if (process.platform.indexOf('win') == 0) {
            if (configPath == 'C:\\Windows\\system32') configPath = path.dirname(process.execPath);
        } else if (process.platform.indexOf('darwin') >= 0) {
            if (!fs.existsSync(path.join(configPath, 'sg.cfg'))) {
                const daemonConfigPath = path.join(os.homedir(), '.saasglue');
                if (fs.existsSync(path.join(daemonConfigPath, 'sg.cfg'))) {
                    configPath = daemonConfigPath;
                }
            }
        } else if (process.platform.indexOf('linux') >= 0) {
            if (!fs.existsSync(path.join(configPath, 'sg.cfg'))) {
                const daemonConfigPath = '/etc/saasglue';
                if (fs.existsSync(path.join(daemonConfigPath, 'sg.cfg'))) {
                    configPath = daemonConfigPath;
                }
            }
        }

        return path.join(configPath, 'sg.cfg');
    }

    static getIpAddress() {
        const arrIPAddresses = [];
        const ifaces = os.networkInterfaces();

        Object.keys(ifaces).forEach(function (ifname) {
            ifaces[ifname].forEach(function (iface) {
                if ('IPv4' !== iface.family || iface.internal !== false) {
                    // skip over internal (i.e. 127.0.0.1) and non-ipv4 addresses
                    return;
                }

                arrIPAddresses.push(iface.address);
            });
        });

        if (arrIPAddresses.length === 0) return 'missing';
        return arrIPAddresses.toString();
    }

    static RunCommand(commandString: any, options: any): Promise<any> {
        return new Promise((resolve) => {
            let stdout = '';
            let stderr = '';

            const cmd: any = exec(commandString, options);

            cmd.stdout.on('data', (data) => {
                const str = data.toString();
                stdout += str;
            });

            cmd.stderr.on('data', (data) => {
                stderr += data.toString();
            });

            cmd.on('exit', (code) => {
                resolve({ code: code, stdout: stdout, stderr: stderr });
            });
        });
    }

    static GetFileExt = (filePath: string) => {
        const index = filePath.lastIndexOf('.');
        if (index < 0) {
            return '';
        } else {
            return filePath.substr(index + 1);
        }
    };

    static ChangeFileExt = (filePath: string, ext: string) => {
        const index = filePath.lastIndexOf('.');
        if (index < 0) {
            if (ext == '') return filePath;
            else return filePath + '.' + ext;
        }
        if (ext == '') return filePath.substr(0, index);
        return filePath.substr(0, index) + '.' + ext;
    };

    static GzipFile = async (filePath: string) => {
        const compressedFilePath = filePath + '.gz';
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
        const uncompressedFilePath = SGUtils.ChangeFileExt(filePath, '');
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
        const compressedFilePath: string = SGUtils.ChangeFileExt(path, 'zip');
        await zip(path, compressedFilePath);
        return compressedFilePath;
    };

    // try to convert a string in form key1=val1,key2=val2 etc. to a map
    static TagsStringToMap = (input: string): { [key: string]: string } => {
        const map = {};

        if (_.isString(input) && input.trim()) {
            const items = input.split(',');

            try {
                items.map((item: string) => {
                    const itemSplit = item.split('=');
                    if (itemSplit.length === 2 && itemSplit[0].trim() && itemSplit[1].trim()) {
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
