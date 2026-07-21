const logSensitiveAdminRead = ({
  adminId,
  caseType = null,
  caseId = null,
  jobId = null,
  acceptanceCycle = null,
  resourceType,
  correlationId
}) => {
  console.info('[admin-security-read]', {
    admin_id: adminId,
    ...(caseType ? { case_type: caseType } : {}),
    ...(caseId ? { case_id: caseId } : {}),
    ...(jobId ? { job_id: jobId } : {}),
    ...(acceptanceCycle != null ? { acceptance_cycle: Number(acceptanceCycle) } : {}),
    resource_type: resourceType,
    correlation_id: correlationId,
    timestamp: new Date().toISOString()
  });
};

export { logSensitiveAdminRead };
