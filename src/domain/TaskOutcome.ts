import * as mongodb from 'mongodb';

export class TaskOutcomeSchema {
    _id?: mongodb.ObjectId;

    id?: mongodb.ObjectId;

    _teamId: mongodb.ObjectId;

    _jobId?: mongodb.ObjectId;

    _taskId: mongodb.ObjectId;

    _agentId: mongodb.ObjectId;

    target: number;

    status?: number;

    source: number;

    correlationId?: string;

    failureCode?: number;

    dateStarted: Date;

    dateCompleted?: Date;

    ipAddress: string;

    machineId: string;

    artifactsDownloadedSize: number;

    autoRestart: boolean;
}
