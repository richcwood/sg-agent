import * as mongodb from 'mongodb';


export class StepOutcomeSchema {

    _id?: mongodb.ObjectId;

    id?: mongodb.ObjectId;

    _teamId: mongodb.ObjectId;

    _jobId?: mongodb.ObjectId;

    _stepId: mongodb.ObjectId;

    _taskOutcomeId: mongodb.ObjectId;

    _invoiceId?: mongodb.ObjectId;

    machineId: string;

    ipAddress: string;    

    name: string;

    source: number;

    runCode: string;

    runtimeVars?: any;

    stdout?: string;

    stderr?: string;

    exitCode?: number;

    signal?: number;

    status?: number;

    dateStarted?: Date;

    dateCompleted?: Date;

    tail?: string[];

    lastUpdateId?: number;

    archived?: boolean;

    lambdaDuration?: string;

    lambdaBilledDuration?: string;

    lambdaMemSize?: string;

    lambdaMaxMemUsed?: string;

    lambdaInitDuration?: string;
};
