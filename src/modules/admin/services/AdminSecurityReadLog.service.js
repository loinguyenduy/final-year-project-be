const logSensitiveAdminRead = ({ adminId, caseType, caseId, resourceType, correlationId }) => {
  console.info('[admin-security-read]', {
    admin_id: adminId,
    case_type: caseType,
    case_id: caseId,
    resource_type: resourceType,
    correlation_id: correlationId,
    timestamp: new Date().toISOString()
  });
};

export { logSensitiveAdminRead };
