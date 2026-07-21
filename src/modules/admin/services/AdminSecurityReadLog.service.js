const logSensitiveAdminRead = ({
  adminId,
  caseType = null,
  caseId = null,
  jobId = null,
  userId = null,
  transactionId = null,
  acceptanceCycle = null,
  resourceType,
  correlationId
}) => {
  console.info('[admin-security-read]', {
    admin_id: adminId,
    ...(caseType ? { case_type: caseType } : {}),
    ...(caseId ? { case_id: caseId } : {}),
    ...(jobId ? { job_id: jobId } : {}),
    ...(userId ? { user_id: userId } : {}),
    ...(transactionId ? { transaction_id: transactionId } : {}),
    ...(acceptanceCycle != null ? { acceptance_cycle: Number(acceptanceCycle) } : {}),
    resource_type: resourceType,
    correlation_id: correlationId,
    timestamp: new Date().toISOString()
  });
};

export { logSensitiveAdminRead };
