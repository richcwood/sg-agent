import * as ipc from 'node-ipc';

class IPCServer {
    public ipcPath: string;

    constructor(ipcId: string, appId: string, channel: string, cb: any) {
        ipc.config.id = ipcId;
        this.ipcPath = `/tmp/app.${appId}.${ipc.config.id}`;
        ipc.config.retry = 1500;
        ipc.config.silent = true;
        ipc.serve(this.ipcPath, () => ipc.server.on(channel, cb));
        ipc.server.start();
    }

    Stop() {
        ipc.server.stop();
    }
}

class IPCClient {
    private serverIPCId: string;
    private channel: string;
    private ipcPath: string;
    private fnOnError: any;
    private fnOnDestroy: any;
    private fnOnDisconnect: any;

    constructor(
        serverIPCId: string,
        channel: string,
        ipcPath: string,
        fnOnError: any,
        fnOnDestroy: any,
        fnOnDisconnect: any
    ) {
        this.serverIPCId = serverIPCId;
        this.channel = channel;
        this.ipcPath = ipcPath;
        this.fnOnError = fnOnError;
        this.fnOnDestroy = fnOnDestroy;
        this.fnOnDisconnect = fnOnDisconnect;
    }

    async ConnectIPC() {
        return new Promise<void>((resolve, reject) => {
            try {
                ipc.config.id = this.channel;
                ipc.config.retry = 1000;
                ipc.config.silent = true;
                ipc.config.maxRetries = 10;
                ipc.connectTo(this.serverIPCId, this.ipcPath, () => {
                    ipc.of[this.serverIPCId].on('connect', async () => {
                        resolve();
                    });
                    ipc.of[this.serverIPCId].on('error', async () => {
                        this.fnOnError();
                    });
                    ipc.of[this.serverIPCId].on('destroy', async () => {
                        this.fnOnDestroy();
                    });
                    ipc.of[this.serverIPCId].on('disconnect', async () => {
                        this.fnOnDisconnect();
                    });
                });
            } catch (e) {
                reject(e);
            }
        });
    }
}

export { IPCServer };
export { IPCClient };
