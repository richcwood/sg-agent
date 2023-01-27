import * as fs from "fs";
import * as os from "os";
import * as AsyncLock from "async-lock";
import * as FormData from "form-data";
import { LogLevel } from "./Enums.js";
import { SGUtils } from "./SGUtils";
import * as mongodb from "mongodb";
import util = require("util");
import * as compressing from "compressing";
import * as _ from "lodash";
import * as path from "path";

export class AgentLogger {
  public pruneLogsInterval = 65000; // 65 seconds
  public cycleCacheInterval = 30000; // 30 seconds
  public maxLogFileUploadSize = 39321600; // 30.75 MB (compresses about 10%, 1 megabit/second average)
  public maxAggregateLogSize = 524288000; // 500 MB

  private cacheFileName: string;
  private cacheFilePath: string;
  private cacheFileCreateTime: Date;
  private cacheFileSize: number;
  private cacheFileWriteStream: any;
  private lockCache: any = new AsyncLock();
  private lockCacheKey = "lock_cache_key";
  private readyToWrite = false;
  private stopped = false;
  public instanceId = "";

  constructor(
    public agent: any,
    public logLevel: LogLevel,
    public logsPath: string,
    public uploadURL: string,
    public uploadPort: string,
    public uploadAPIVersion: string
  ) {
    if (!fs.existsSync(this.logsPath)) fs.mkdirSync(this.logsPath);

    if (this.agent.env == "debug" || this.agent.env == "unittest") {
      this.cycleCacheInterval = 10000; // 10 seconds
      this.maxLogFileUploadSize = 10240; // 10 KB (compresses about 10%)
      this.maxAggregateLogSize = 51200; // 50 KB
    }

    this.CycleCacheFile();
  }

  async CycleCacheFile() {
    this.lockCache.acquire(
      this.lockCacheKey,
      async () => {
        this.readyToWrite = false;
        const currentTime = +new Date();
        if (
          this.cacheFileSize > 0 &&
          currentTime - +this.cacheFileCreateTime > this.cycleCacheInterval
        ) {
          this.CloseCacheFile();
        } else {
          this.readyToWrite = true;
        }
      },
      (err, ret) => {
        if (!this.agent.stopped)
          setTimeout(() => {
            this.CycleCacheFile();
          }, this.cycleCacheInterval);
      },
      {}
    );
  }

  async Log(values: any, logLevel: LogLevel) {
    if (logLevel < this.logLevel) return;

    values = Object.assign(
      {
        _logLevel: logLevel,
        _appName: this.agent.appName,
        _ipAddress: SGUtils.getIpAddress(),
        _sourceHost: this.agent.machineId
          ? this.agent.machineId
          : os.hostname(),
        _timeStamp: new Date().toISOString(),
      },
      values
    );
    if (this.agent.logDest == "console") {
      console.log(JSON.stringify(values, null, 4));
    } else {
      this.WriteLogEntry(JSON.stringify(values));
    }

    // let str: string;
    // str = 'LogLevel=' + '\"' + logLevel + '\", App=' + '\"' + this.appName + '\", IPAddress=' + '\"' + this.ipAddress + '\", MachineId=' + '\"' + this.machineId + '\", TimeStamp=' + '\"' + new Date().toISOString() + '\"';
    // for (let k in values) {
    //     str += (', ' + k + '=\"' + (values[k] ? values[k].toString().replace(/\r?\n|\r/g, ' ') : '') + '\"');
    // }

    // if (this.env == 'UnitTest')
    //     console.log(str + '\n');
    // else
    //     this.WriteLogEntry(str);
  }

  async LogError(msg: string, stackTrace: string, values: any) {
    await this.Log(
      Object.assign(
        {
          msg: msg,
          TeamId: this.agent.teamId,
          AgentId: this.instanceId,
          StackTrace: stackTrace,
        },
        values
      ),
      LogLevel.ERROR
    );
  }

  async LogWarning(msg: string, values: any) {
    await this.Log(
      Object.assign(
        { msg: msg, TeamId: this.agent.teamId, AgentId: this.instanceId },
        values
      ),
      LogLevel.WARNING
    );
  }

  async LogInfo(msg: string, values: any) {
    await this.Log(
      Object.assign(
        { msg: msg, TeamId: this.agent.teamId, AgentId: this.instanceId },
        values
      ),
      LogLevel.INFO
    );
  }

  async LogDebug(msg: string, values: any) {
    await this.Log(
      Object.assign(
        { msg: msg, TeamId: this.agent.teamId, AgentId: this.instanceId },
        values
      ),
      LogLevel.DEBUG
    );
  }

  CloseCacheFile() {
    if (this.cacheFileWriteStream) this.cacheFileWriteStream.end();
  }

  GenerateNewCacheFile() {
    if (!fs.existsSync(this.logsPath)) fs.mkdirSync(this.logsPath);

    this.cacheFileCreateTime = new Date();
    this.cacheFileName = `${this.agent.appName}_${this.cacheFileCreateTime
      .toISOString()
      .replace(/T/, "")
      .replace(/-/g, "")
      .replace(/:/g, "")
      .substr(0, 14)}.log`;
    this.cacheFilePath = `${this.logsPath}/${this.cacheFileName}`;
    this.cacheFileSize = 0;
    this.cacheFileWriteStream = fs.createWriteStream(this.cacheFilePath, {
      flags: "a",
    });
    this.readyToWrite = true;

    this.cacheFileWriteStream.on("finish", async () => {
      this.GenerateNewCacheFile();
    });
  }

  async Start() {
    if (this.agent.logDest == "console") return;
    this.GenerateNewCacheFile();
    this.PruneLogFiles();
  }

  Stop() {
    this.stopped = true;
  }

  OnLogEntryWritten() {
    const currentTime = +new Date();
    if (
      this.cacheFileSize > 0 &&
      currentTime - +this.cacheFileCreateTime > this.cycleCacheInterval
    )
      this.CloseCacheFile();
    else this.readyToWrite = true;
  }

  async WriteLogEntry(message: string) {
    this.lockCache.acquire(
      this.lockCacheKey,
      async () => {
        this.readyToWrite = false;
        this.cacheFileSize += Buffer.byteLength(message, "utf8");
        if (!this.cacheFileWriteStream.write(message + "\n")) {
          this.cacheFileWriteStream.once(
            "drain",
            this.OnLogEntryWritten.bind(this)
          );
        } else {
          process.nextTick(this.OnLogEntryWritten.bind(this));
        }
        while (!this.readyToWrite) await SGUtils.sleep(100);
      },
      (err, ret) => {
        if (err) {
          console.trace(
            `Error writing error '${message}" to log file "${this.cacheFilePath}': ${err}`
          );
          process.exitCode = 1;
        }
      },
      {}
    );
  }

  async PruneLogFiles() {
    fs.readdir(this.logsPath, async (err, files) => {
      if (err) {
        const msg = `Error getting contents of folder '${this.logsPath}': ${err}`;
        this.LogError(msg, "PruneLogFiles", {});
        // setTimeout(this.PruneLogFiles, this.pruneLogsInterval);
        if (!this.stopped)
          setTimeout(() => {
            this.PruneLogFiles();
          }, this.pruneLogsInterval);
      } else {
        const files_extended = await files
          .filter((fileName) => {
            const filePath = `${this.logsPath}/${fileName}`;
            return (
              fileName.startsWith(this.agent.appName) &&
              (path.extname(filePath) == ".log" ||
                path.extname(filePath) == ".gz") &&
              filePath != this.cacheFilePath &&
              !fs.statSync(filePath).isDirectory()
            );
          })
          .map((fileName) => {
            const filePath = `${this.logsPath}/${fileName}`;
            if (filePath == this.cacheFilePath) return;
            return {
              path: filePath,
              time: fs.statSync(filePath).mtime.getTime(),
              size: fs.statSync(filePath).size,
            };
          })
          .sort((a, b) => {
            return a.time - b.time;
          })
          .map((v) => {
            if (!v) return;
            return {
              path: v.path,
              size: v.size,
            };
          })
          .filter((v) => {
            return v;
          });

        if (files_extended.length > 0) {
          await this.UploadLogFiles(files_extended);

          const files_not_uploaded: any[] = [];
          let aggregateLogSize = 0;
          for (let i = 0; i < files_extended.length; i++) {
            if (fs.existsSync(files_extended[i].path)) {
              files_not_uploaded.push(files_extended[i]);
              aggregateLogSize += files_extended[i].size;
            }
          }

          for (let i = 0; i < files_not_uploaded.length; i++) {
            if (aggregateLogSize <= this.maxAggregateLogSize) break;

            if (fs.existsSync(files_not_uploaded[i].path)) {
              fs.unlinkSync(files_not_uploaded[i].path);
              aggregateLogSize -= files_not_uploaded[i].size;
              const msg = "Max aggregate log size exceeded - deleting log file";
              this.LogError(msg, "PruneLogFiles", {
                Path: files_not_uploaded[i].path,
              });
            }
          }
        }

        if (!this.stopped)
          setTimeout(() => {
            this.PruneLogFiles();
          }, this.pruneLogsInterval);
      }
    });
  }

  async UploadLogFiles(files: any) {
    return new Promise<void>(async (resolve, reject) => {
      try {
        for (let i = 0; i < files.length; i++) {
          if (files[i].size < 1) {
            if (fs.existsSync(files[i].path)) {
              fs.unlinkSync(files[i].path);
            }
          } else {
            await this.UploadLogFile(files[i].path, files[i].size);
          }
        }
      } finally {
        resolve();
      }
    });
  }

  async UploadLogFile(filePath: string, fileSize: number) {
    if (!fs.existsSync(filePath)) {
      return;
    }

    let success = true;
    try {
      let compressedFilePath: string = filePath;
      const fileExtension: string = path.extname(filePath);
      if (fileExtension == ".log") {
        if (fileSize > this.maxLogFileUploadSize)
          fs.truncateSync(filePath, this.maxLogFileUploadSize);
        compressedFilePath =
          filePath.substr(0, filePath.lastIndexOf(".")) + ".gz";
        await new Promise<void>((resolve, reject) => {
          compressing.gzip
            .compressFile(filePath, compressedFilePath)
            .then(() => {
              resolve();
            })
            .catch((err) => {
              reject(err);
            });
        });

        if (fs.existsSync(filePath)) {
          fs.unlinkSync(filePath);
        }
      }

      const file = fs.createReadStream(compressedFilePath);

      const config = {
        headers: {
          "Content-Type": "multipart/form-data",
        },
      };

      const form = new FormData();
      form.append("buffer", Buffer.alloc(10));
      form.append("logFile", file);

      await this.agent.RestAPICall("agentlog", "POST", form.getHeaders(), form);

      if (fs.existsSync(compressedFilePath)) {
        fs.unlinkSync(compressedFilePath);
      }
    } catch (e) {
      success = false;
      this.LogError(`Error uploading log file`, e.stack, {
        filePath,
        error: e.message,
      });
    }

    if (!success) await SGUtils.sleep(30000);

    // const archivePath = `${this.logsPath}/archive`;
    // if (!fs.existsSync(archivePath))
    //     fs.mkdirSync(archivePath);

    // await new Promise( async (resolve, reject) => {
    //     try {
    //         const outPath = filePath.replace(this.logsPath, archivePath);
    //         this.LogInfo('Uploading log file', { LogFilePath: filePath, LogFileName: path.basename(filePath)});

    //         if (this.maxLogFileUploadSize > fileSize)
    //             this.LogWarning('Truncated log file', {LogFileName: path.basename(filePath), LogFileSize: fileSize, MaxLogFileSize: this.maxLogFileUploadSize});

    //         var bufferSize=this.maxLogFileUploadSize,
    //             chunkSize=512,
    //             bytesRead = 0;

    //         const writeStream = fs.createWriteStream(outPath);
    //         writeStream.on('finish', () => {
    //             if (fs.existsSync(filePath))
    //                 fs.unlinkSync(filePath);
    //             resolve();
    //         });
    //         await new Promise( (resolve, reject) => {
    //             fs.open(filePath, 'r', async (err, fd) => {
    //                 if (err) throw err;

    //                 while (bytesRead < bufferSize) {
    //                     if ((bytesRead + chunkSize) > bufferSize) {
    //                         chunkSize = (bufferSize - bytesRead);
    //                     }

    //                     await new Promise( (resolve, reject) => {
    //                         fs.read(fd, Buffer.alloc(chunkSize), 0, chunkSize, bytesRead, async (err, bytesRead, buffer) => {
    //                             if (err) throw 'Error reading file: ' + err;
    //                             if (!writeStream.write(buffer)) {
    //                                 writeStream.once('drain', () => { resolve(); });
    //                             } else {
    //                                 process.nextTick( () => { resolve(); });
    //                             }
    //                         });
    //                     });

    //                     bytesRead += chunkSize;
    //                 }
    //                 resolve();
    //             });
    //         });

    //         writeStream.end();
    //     } catch (e) {
    //         const msg = `Error uploading log file '${path}': ${e}`;
    //         console.log(msg);
    //         this.LogError(msg, e.stackTrace, {});
    //     }
    // })
  }
}
