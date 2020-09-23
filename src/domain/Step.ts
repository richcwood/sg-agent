import * as mongodb from 'mongodb';


export class StepSchema {

  _id?: mongodb.ObjectId;

  id?: mongodb.ObjectId;

  _teamId: mongodb.ObjectId;

  _jobId: mongodb.ObjectId;

  _taskId: mongodb.ObjectId;

  name: string;

  order: number;

  script: any;

  command?: string;

  arguments: string;

  variables: any;

  lastUpdateId: number;

  lambdaRuntime?: string;

  lambdaMemorySize?: number;

  lambdaTimeout?: number;

  lambdaZipfile?: string;
  
  lambdaRole?: string;

  s3Bucket?: string;

  lambdaAWSRegion?: string;
};
