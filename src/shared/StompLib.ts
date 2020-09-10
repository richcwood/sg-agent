import { SGUtils } from './SGUtils';
import * as util from 'util';
import { RabbitMQAdmin } from "./RabbitMQAdmin";
import { Client } from '@stomp/stompjs';
import * as AsyncLock from 'async-lock';


Object.assign(global, { WebSocket: require('websocket').w3cwebsocket });

// These have been added in NodeJS v11, so good idea is to check first
if (typeof TextEncoder !== 'function') {
    const TextEncodingPolyfill = require('text-encoding');
    Object.assign(global, { TextEncoder: TextEncodingPolyfill.TextEncoder });
    Object.assign(global, { TextDecoder: TextEncodingPolyfill.TextDecoder });
}


export class StompConnector {
    stompClient: any;
    rmqAdmin: RabbitMQAdmin;
    activeMessages: any = [];
    lock = new AsyncLock();

    constructor(public appName: string, public clientId: string, public url: string, public userName: string, public password: string, public rmqAdminUrl: string, public vhost: string, public prefetchCount: number, public fnOnDisconnect: any, private logger: any) {
        this.activeMessages = [];
        this.rmqAdmin = new RabbitMQAdmin(rmqAdminUrl, vhost, this.logger);
    }

    LogError(msg: string, stackTrace: string, values: any) {
        this.logger.LogError(msg, Object.assign({ 'StackTrace': stackTrace, 'ClientId': this.clientId }, values));
    }

    LogWarning(msg: string, values: any) {
        this.logger.LogWarning(msg, values);
    }

    LogInfo(content: string, consumerTag: string, redelivered: boolean, destination: string, values: any) {
        this.logger.LogInfo(content, Object.assign({ 'ClientId': this.clientId, 'ConsumerTag': consumerTag, 'Redelivered': redelivered, 'Destination': destination }, values));
    }

    LogDebug(msg: string, values: any) {
        this.logger.LogDebug(msg, Object.assign({ 'ClientId': this.clientId }, values));
    }


    Start() {
        return new Promise(async (resolve, reject) => {
            try {
                this.stompClient = new Client({
                    brokerURL: this.url,
                    connectHeaders: {
                        login: this.userName,
                        passcode: this.password,
                        host: this.vhost
                    },
                    heartbeatIncoming: 10000,
                    heartbeatOutgoing: 10000
                });

                this.stompClient.onConnect = this.OnConnect.bind(this);
                this.stompClient.onStompError = this.OnStompError.bind(this);

                this.stompClient.activate();

                this.LogDebug('Completed request to start Stomp connection to RabbitMQ', {
                    'RmqUrl': this.url,
                    'Vhost': this.vhost,
                    'UserName': this.userName
                });
            } catch (e) {
                this.LogError('Error connecting to RabbitMQ: ' + e.message, e.stack, {});
                reject(e);
            }
        });
    }

    async Stop() {
        return new Promise((resolve, reject) => {
            this.LogDebug('Received request to stop Stomp connection to RabbitMQ', {});
            try {
                this.activeMessages.length = 0;
                if (this.stompClient) {
                    this.stompClient.deactivate();
                    this.LogDebug('Completed request to stop Stomp connection to RabbitMQ', {});
                    resolve();
                }
            } catch (e) {
                resolve(e);
            }
        });
    }

    OnConnect() {
        this.LogDebug('Connected to Stomp', {});
    }

    OnStompError = (err) => {
        this.LogError(`Stomp error occurred: ${err}`, '', {});
        this.fnOnDisconnect();
    };

    IsConnected = () => {
        if (this.stompClient && this.stompClient.webSocket)
            return this.stompClient.webSocket.readyState != WebSocket.CLOSED;
        return false;
    }

    async ConsumeQueue(queueName: string, exclusive: boolean, durable: boolean, autoDelete: boolean, noAck: boolean, fnHandleMessage: any, exchange: string, expires: number = 0) {
        return new Promise(async (resolve, reject) => {
            if (!queueName || (queueName == ''))
                reject('Missing or blank route parameter');

            let sub: any;
            try {
                if (exchange != '')
                    await this.rmqAdmin.createExchange(exchange, 'topic', false, true);

                let headers: any = { exclusive: exclusive, durable: durable, 'auto-delete': autoDelete, 'prefetch-count': this.prefetchCount };
                if (!noAck)
                    headers['ack'] = 'client';
                if (expires > 0)
                    headers['x-expires'] = expires;
                headers['x-queue-name'] = queueName;
                let routingKey = `/queue/${queueName}`;
                if (exchange && (exchange != ''))
                    routingKey = `/exchange/${exchange}/${queueName}`;
                sub = await this.stompClient.subscribe(routingKey, (msg) => {
                    if (msg != null) {
                        let msgKey = null;
                        try {
                            // this.LogDebug('Message received', { 'Command': msg.command, 'Headers': util.inspect(msg.headers) });
                            msgKey = msg.headers['message-id'];
                            this.activeMessages.push(msgKey);

                            fnHandleMessage(JSON.parse(msg.body), msgKey, (ok, msgKey) => {
                                if (!noAck) {
                                    if (this.activeMessages.indexOf(msgKey) > -1) {
                                        try {
                                            if (ok)
                                                msg.ack();
                                            else
                                                msg.nack(headers = { requeue: false });
                                            SGUtils.removeItemFromArray(this.activeMessages, msgKey);
                                        } catch (e) {
                                            this.LogError('Error occurred acking Stomp message: ' + e.message, e.stack, { 'EventArgs': util.inspect(msg, false, null) });
                                        }
                                    }
                                }
                            });
                        } catch (e) {
                            this.LogError('Error receiving message', e.stack, { 'QueueName': queueName });
                            if (!noAck) {
                                msg.ack();
                                if (msgKey != null)
                                    SGUtils.removeItemFromArray(this.activeMessages, msgKey);
                            }
                        }
                    }
                }, headers);
                this.LogDebug('Consuming queue', { 'QueueName': queueName });
            } catch (e) {
                this.LogError('Error consuming Stomp queue', e.stack, { 'QueueName': queueName });
                reject(e);
            }
            resolve(sub);
        });
    }

    async ConsumeRoute(id: any, exclusive: boolean, durable: boolean, autoDelete: boolean, noAck: boolean, fnHandleMessage: any, exchange: string, route: string, queueName: string, expires: number = 0) {
        return new Promise(async (resolve, reject) => {
            if (!route || (route == ''))
                reject('Missing or blank route parameter');

            let sub: any;
            try {
                let headers: any = { exclusive: exclusive, durable: durable, 'auto-delete': autoDelete, 'prefetch-count': this.prefetchCount };
                if (!noAck)
                    headers['ack'] = 'client';
                headers['id'] = 0;
                if (id != '')
                    headers['id'] = id;
                if (expires > 0)
                    headers['x-expires'] = expires;
                if (queueName && (queueName != ''))
                    headers['x-queue-name'] = queueName;
                let routingKey = `/exchange/${exchange}/${route}`;
                sub = await this.stompClient.subscribe(routingKey, (msg) => {
                    if (msg != null) {
                        let msgKey = null;
                        try {
                            this.LogDebug('Message received', { 'Command': msg.command, 'Headers': util.inspect(msg.headers) });
                            msgKey = msg.headers['message-id'];
                            this.activeMessages.push(msgKey);

                            fnHandleMessage(JSON.parse(msg.body), msgKey, (ok, msgKey) => {
                                if (!noAck) {
                                    if (this.activeMessages.indexOf(msgKey) > -1) {
                                        try {
                                            if (ok)
                                                msg.ack();
                                            else
                                                msg.nack();
                                            SGUtils.removeItemFromArray(this.activeMessages, msgKey);
                                        } catch (e) {
                                            this.LogError('Error occurred acking Stomp message: ' + e.message, e.stack, { 'EventArgs': util.inspect(msg, false, null) });
                                        }
                                    }
                                }
                            });
                        } catch (e) {
                            this.LogError('Error receiving message', e.stack, { 'QueueName': id });
                            if (!noAck) {
                                msg.ack();
                                if (msgKey != null)
                                    SGUtils.removeItemFromArray(this.activeMessages, msgKey);
                            }
                        }
                    }
                }, headers);
                this.LogDebug('Consuming route', { 'QueueName': id, 'Exchange': exchange, 'Route': route });
            } catch (e) {
                this.LogError('Error consuming Stomp route', e.stack, { 'QueueName': id, 'Exchange': exchange, 'Route': route });
                reject(e);
            }
            resolve(sub);
        });
    }

    async StopConsumingQueue(sub: any) {
        this.LogDebug('Unsubscribing', { 'Subscription': util.inspect(sub, false, null) });
        await sub.unsubscribe();
    }
}
