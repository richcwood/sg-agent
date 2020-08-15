import * as os from 'os';
import { exec } from 'child_process';
import * as compressing from 'compressing';


export class SGUtils {
    static btoa_(str: string) {
        return Buffer.from(str).toString('base64');
    }


    static atob(b64Encoded: string) {
        return Buffer.from(b64Encoded, 'base64').toString('utf8');
    }


    static makeid(len: number = 5, lettersOnly: boolean = false) {
        var text = "";
        let possible = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
        if (!lettersOnly)
            possible += "0123456789";

        for (let i = 0; i < len; i++)
            text += possible.charAt(Math.floor(Math.random() * possible.length));

        return text;
    }

    static removeItemFromArray(array: any[], item: any) {
        const index = array.indexOf(item);
        if (index > -1)
            array.splice(index, 1);
    }

    static async sleep(ms: number) {
        return new Promise(resolve => {
            setTimeout(resolve, ms);
        })
    }

    static async injectScripts(_teamId: string, script_code: string, scriptsToInject: any, fnLogError: any) {
        let newScript: string = script_code;
        let arrScriptsToInject: string[] = newScript.match(/@kps?(\([^)]*\))/g);
        if (arrScriptsToInject) {
            // replace runtime variables in script
            for (let i = 0; i < arrScriptsToInject.length; i++) {
                let found: boolean = false;
                try {
                    let injectScriptKey = arrScriptsToInject[i].substr(5, arrScriptsToInject[i].length - 6);
                    if (injectScriptKey.substr(0, 1) === '"' && injectScriptKey.substr(injectScriptKey.length - 1, 1) === '"')
                        injectScriptKey = injectScriptKey.slice(1, -1);
                    if (injectScriptKey in scriptsToInject) {
                        let injectScriptVal = SGUtils.atob(scriptsToInject[injectScriptKey]);
                        if (injectScriptVal) {
                            newScript = newScript.replace(`${arrScriptsToInject[i]}`, `${injectScriptVal}`);
                            newScript = await SGUtils.injectScripts(_teamId, newScript, scriptsToInject, fnLogError);
                            found = true;
                        }
                    }

                    if (!found) {
                        newScript = newScript.replace(`${arrScriptsToInject[i]}`, '');
                    }
                } catch (e) {
                    fnLogError(`Error replacing script @kps capture for string \"${arrScriptsToInject[i]}\": ${e.message}`, e.stack);
                }
            }
        }

        return newScript;

        // // find dynamically injected scripts
        // let arrFindScriptsToInject: string[] = script_code.match(/@kps?(\([^)]*\))/g);
        // let scriptsToInject: any = {};
        // if (arrFindScriptsToInject) {
        //     for (let i = 0; i < arrFindScriptsToInject.length; i++) {
        //         try {
        //             let scriptKey = arrFindScriptsToInject[i].substr(5, arrFindScriptsToInject[i].length - 6);
        //             if (scriptKey.substr(0, 1) === '"' && scriptKey.substr(scriptKey.length - 1, 1) === '"')
        //                 scriptKey = scriptKey.slice(1, -1);
        //             let scriptQuery: ScriptSchema[] = await scriptService.findScript(_teamId, new mongodb.ObjectId(scriptKey), 'code')
        //             if (!scriptQuery || (_.isArray(scriptQuery) && scriptQuery.length === 0))
        //                 throw new MissingObjectError(`Script ${scriptKey} not found.`);
        //             const injectedScriptCode = SGUtils.atob(scriptQuery[0].code);
        //             let subScriptsToInject = await SGUtils.getInjectedScripts(_teamId, injectedScriptCode);
        //             scriptsToInject[scriptKey] = scriptQuery[0].code;
        //             scriptsToInject = Object.assign(scriptsToInject, subScriptsToInject);
        //         } catch (e) {
        //             throw new Error(`Error in script @kps capture for string \"${arrFindScriptsToInject[i]}\": ${e.message}`);
        //         }
        //     }
        // }

        // return scriptsToInject;
    }

    static getIpAddress() {
        let arrIPAddresses = [];
        let ifaces = os.networkInterfaces();

        Object.keys(ifaces).forEach(function (ifname) {
            ifaces[ifname].forEach(function (iface) {
                if ('IPv4' !== iface.family || iface.internal !== false) {
                    // skip over internal (i.e. 127.0.0.1) and non-ipv4 addresses
                    return;
                }

                arrIPAddresses.push(iface.address);
            });
        });

        if (arrIPAddresses.length === 0)
            return 'missing';
        return arrIPAddresses.toString();
    };


    static async RunCommand(commandString: any, options: any) {
        return new Promise((resolve, reject) => {
            try {
                let stdout: string = '';
                let stderr: string = '';

                let cmd: any = exec(commandString, options);

                cmd.stdout.on('data', (data) => {
                    try {
                        let str = data.toString();
                        stdout += str;
                    } catch (e) {
                        throw e;
                    }
                });

                cmd.stderr.on('data', (data) => {
                    try {
                        stderr += data.toString();
                    } catch (e) {
                        throw e;
                    }
                });

                cmd.on('exit', (code) => {
                    try {
                        resolve({ 'code': code, 'stdout': stdout, 'stderr': stderr });
                    } catch (e) {
                        throw e;
                    }
                });
            } catch (e) {
                throw e;
            }
        })
    };


    static GetFileExt = (filePath: string) => {
        const index = filePath.lastIndexOf(".");
        if (index < 0) {
            return '';
        } else {
            return filePath.substr(index+1);
        }
    }


    static ChangeFileExt = (filePath: string, ext: string) => {
        const index = filePath.lastIndexOf(".");
        if (index < 0) {
            if (ext == '')
                return filePath;
            else
                return filePath + "." + ext;
        }
        if (ext == '')
            return filePath.substr(0, index);
        return filePath.substr(0, index) + "." + ext;
    }


    static GzipFile = async (filePath: string) => {
        const compressedFilePath = filePath + ".gz";
        await new Promise((resolve, reject) => {
            compressing.gzip.compressFile(filePath, compressedFilePath)
                .then(() => { resolve(); })
                .catch((err) => { reject(err); })
        });

        return compressedFilePath;
    }


    static GunzipFile = async (filePath: string) => {
        const uncompressedFilePath = SGUtils.ChangeFileExt(filePath, "");
        await new Promise((resolve, reject) => {
          compressing.gzip.uncompress(filePath, uncompressedFilePath)
            .then(() => { resolve(); })
            .catch((err) => { reject(err); })
        });

        return uncompressedFilePath;
    }
}

