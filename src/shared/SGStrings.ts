/**
 * Created by richwood on 3/8/18.
 */

export class SGStrings {
  static status = "status";
  static route = "route";
  static skipped = "skipped";
  static exitCode = "exitCode";
  static stdout = "stdout";
  static stderr = "stderr";
  static dateStarted = "dateStarted";
  static dateCompleted = "dateCompleted";
  static result = "result";
  static title = "title";
  static failed = "failed";
  static fromRoutes = "fromRoutes";
  static failureCode = "failureCode";

  static GetTaskKey(teamId: string, jobId: string | null, taskName: string) {
    let taskKey = `team-${teamId}.`;
    if (jobId) taskKey += `job-${jobId}.`;
    taskKey += `task-${taskName}`;
    return taskKey;
  }

  static GetJobKey(teamId: string, jobId: string) {
    return `team-${teamId}.job-${jobId}`;
  }

  static GetTeamExchangeName(teamId: string) {
    return `${this.GetTeamRoutingPrefix(teamId)}`;
  }

  static GetTeamLogExchangeName(teamId: string) {
    return `${this.GetTeamRoutingPrefix(teamId)}`;
  }

  static GetTeamRoutingPrefix(teamId: string) {
    return `team-${teamId}`;
  }

  static GetAgentQueue(teamId: string, agentId: string) {
    return `${this.GetTeamRoutingPrefix(teamId)}.agent-${agentId}`;
  }

  static GetAgentUpdaterQueue(teamId: string, agentId: string) {
    return `${this.GetAgentQueue(teamId, agentId)}.updater`;
  }

  static GetAgentStatusQueue(teamId: string) {
    return `${this.GetTeamRoutingPrefix(teamId)}.agent_status`;
  }

  static GetAnyAgentQueue(teamId: string) {
    return `${this.GetTeamRoutingPrefix(teamId)}.agent`;
  }

  static GetAllAgentsQueue(teamId: string) {
    return `${this.GetTeamRoutingPrefix(teamId)}.agent.all`;
  }

  // static GetAnyAgentTagQueue(teamId: string, tag: string) {
  //     return `${this.GetAnyAgentQueue(teamId)}.${tag}`;
  // };

  static GetHeartbeatQueue(teamId: string) {
    return `${this.GetTeamRoutingPrefix(teamId)}.agent.heartbeat`;
  }
}
