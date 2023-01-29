import * as mongodb from 'mongodb';
import { MongoDbSettings } from 'aws-sdk/clients/dms';

export class TaskSchema {
    id?: mongodb.ObjectId;

    _teamId: mongodb.ObjectId;

    _jobId: mongodb.ObjectId;

    _taskOutcomeId: mongodb.ObjectId;

    name: string;

    source: number;

    target: number;

    targetAgentId: string;

    requiredTags?: any[];

    fromRoutes?: string[][];

    artifacts?: mongodb.ObjectId[];

    createdBy?: string;

    sourceTaskRoute: any;

    correlationId?: string;

    status?: number;

    error?: string;

    failureCode?: number;

    runtimeVars: any;

    route?: string;

    down_dep?: string[][];

    up_dep?: any;

    scriptsToInject?: any;

    autoRestart: boolean;
}
