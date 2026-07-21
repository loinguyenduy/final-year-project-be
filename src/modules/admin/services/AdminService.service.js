import { Op, fn, col, where as sqlWhere } from 'sequelize';
import db from '../../../core/database/connection.js';
import Service from '../../matchmaking/models/Service.model.js';
import Job from '../../matchmaking/models/Job.model.js';
import HandymanService from '../../matchmaking/models/HandymanService.model.js';
import User from '../../identity/models/User.model.js';
import { createAdminAuditLog } from './AdminAudit.service.js';
import { ADMIN_AUDIT_ACTIONS, ADMIN_AUDIT_TARGETS } from '../constants/admin.constants.js';
import { AdminManagementError, assertUuid, normalizePlainText, normalizeSearch, parseBoolean, parsePositiveInteger } from '../utils/adminManagementValidation.util.js';

const SERVICE_CODE_PATTERN = /^[A-Z0-9_]{2,50}$/;
const SERVICE_SORTS = Object.freeze({
  NAME_ASC: [['name', 'ASC'], ['id', 'ASC']],
  NAME_DESC: [['name', 'DESC'], ['id', 'DESC']],
  CODE_ASC: [['service_code', 'ASC'], ['id', 'ASC']],
  CODE_DESC: [['service_code', 'DESC'], ['id', 'DESC']]
});
const ACTIVE_JOB_WHERE = { current_status: { [Op.notIn]: ['CLOSED', 'CANCELLED'] } };

const normalizeCode = (value) => {
  const code = String(value || '').trim().normalize('NFC').toUpperCase();
  if (!SERVICE_CODE_PATTERN.test(code)) {
    throw new AdminManagementError('service_code must contain 2–50 uppercase letters, digits or underscores.');
  }
  return code;
};

const normalizeIconUrl = (value) => {
  if (value === undefined) return undefined;
  if (value === null || String(value).trim() === '') return null;
  const normalized = String(value).trim();
  if (normalized.length > 2048) throw new AdminManagementError('icon_url must not exceed 2048 characters.');
  try {
    const parsed = new URL(normalized);
    if (parsed.protocol !== 'https:') throw new Error();
  } catch {
    throw new AdminManagementError('icon_url must be a valid HTTPS URL.');
  }
  return normalized;
};

const validateBodyKeys = (payload, allowed) => {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new AdminManagementError('Request body must be an object.');
  }
  const unknown = Object.keys(payload).filter((key) => !allowed.includes(key));
  if (unknown.length) throw new AdminManagementError(`Unknown field(s): ${unknown.join(', ')}.`);
};

const usageForServices = async (serviceIds) => {
  if (!serviceIds.length) return new Map();
  const [totalJobs, activeJobs, associations, activeAssociations] = await Promise.all([
    Job.findAll({ where: { service_id: { [Op.in]: serviceIds } }, attributes: ['service_id', [fn('COUNT', col('id')), 'count']], group: ['service_id'], raw: true }),
    Job.findAll({ where: { service_id: { [Op.in]: serviceIds }, ...ACTIVE_JOB_WHERE }, attributes: ['service_id', [fn('COUNT', col('id')), 'count']], group: ['service_id'], raw: true }),
    HandymanService.findAll({ where: { service_id: { [Op.in]: serviceIds } }, attributes: ['service_id', [fn('COUNT', col('id')), 'count']], group: ['service_id'], raw: true }),
    HandymanService.findAll({
      where: { service_id: { [Op.in]: serviceIds } },
      include: [{ model: User, attributes: [], required: true, where: { role: 'HANDYMAN', is_active: true } }],
      attributes: ['service_id', [fn('COUNT', col('Handyman_Service.id')), 'count']],
      group: ['Handyman_Service.service_id'], raw: true
    })
  ]);
  const map = new Map(serviceIds.map((id) => [id, { total_jobs: 0, active_jobs: 0, total_handyman_associations: 0, active_handyman_associations: 0 }]));
  const apply = (rows, key) => rows.forEach((row) => { if (map.has(row.service_id)) map.get(row.service_id)[key] = Number(row.count || 0); });
  apply(totalJobs, 'total_jobs'); apply(activeJobs, 'active_jobs'); apply(associations, 'total_handyman_associations'); apply(activeAssociations, 'active_handyman_associations');
  return map;
};

const toDto = (service, usage) => ({
  id: service.id,
  service_code: service.service_code,
  name: service.name,
  icon_url: service.icon_url,
  is_active: service.is_active,
  usage
});

const getAdminServices = async (query = {}) => {
  const page = parsePositiveInteger(query.page, 'page', 1, Number.MAX_SAFE_INTEGER);
  const pageSize = parsePositiveInteger(query.page_size, 'page_size', 20, 100);
  const search = normalizeSearch(query.search);
  const isActive = parseBoolean(query.is_active, 'is_active');
  const sort = String(query.sort || 'NAME_ASC').toUpperCase();
  if (!SERVICE_SORTS[sort]) throw new AdminManagementError('sort is invalid.');
  const where = {};
  if (isActive !== null) where.is_active = isActive;
  if (search) where[Op.or] = [
    { service_code: { [Op.iLike]: `%${search}%` } },
    { name: { [Op.iLike]: `%${search}%` } }
  ];
  const { rows, count } = await Service.findAndCountAll({ where, order: SERVICE_SORTS[sort], limit: pageSize, offset: (page - 1) * pageSize });
  const usage = await usageForServices(rows.map((row) => row.id));
  return {
    items: rows.map((row) => toDto(row, usage.get(row.id))),
    pagination: { page, page_size: pageSize, total_items: count, total_pages: Math.ceil(count / pageSize) }
  };
};

const getAdminService = async (serviceId) => {
  assertUuid(serviceId, 'serviceId');
  const service = await Service.findByPk(serviceId);
  if (!service) throw new AdminManagementError('Service not found.', 404, 'SERVICE_NOT_FOUND');
  const usage = await usageForServices([service.id]);
  return toDto(service, usage.get(service.id));
};

const ensureUniqueService = async ({ serviceCode, name, excludeId = null, transaction }) => {
  const conditions = [];
  if (serviceCode) conditions.push({ service_code: serviceCode });
  if (name) conditions.push(sqlWhere(fn('LOWER', col('name')), name.toLocaleLowerCase('en-US')));
  const where = { [Op.or]: conditions };
  if (excludeId) where.id = { [Op.ne]: excludeId };
  const duplicate = await Service.findOne({ where, transaction });
  if (duplicate?.service_code === serviceCode) throw new AdminManagementError('service_code already exists.', 409, 'SERVICE_CODE_ALREADY_EXISTS');
  if (duplicate) throw new AdminManagementError('Service name already exists.', 409, 'SERVICE_NAME_ALREADY_EXISTS');
};

const auditMeta = (requestMeta) => ({
  correlationId: requestMeta.correlationId,
  ipAddress: requestMeta.ipAddress,
  userAgent: requestMeta.userAgent
});

const createAdminService = async ({ payload = {}, admin, requestMeta }) => {
  validateBodyKeys(payload, ['service_code', 'name', 'icon_url', 'is_active']);
  const serviceCode = normalizeCode(payload.service_code);
  const name = normalizePlainText(payload.name, 'name', 100, { required: true });
  if (name.length < 2) throw new AdminManagementError('name must contain at least 2 characters.');
  const iconUrl = normalizeIconUrl(payload.icon_url);
  if (payload.is_active !== undefined && typeof payload.is_active !== 'boolean') throw new AdminManagementError('is_active must be boolean.');

  return db.transaction(async (transaction) => {
    await db.query('SELECT pg_advisory_xact_lock(731003)', { transaction });
    await ensureUniqueService({ serviceCode, name, transaction });
    const service = await Service.create({ service_code: serviceCode, name, icon_url: iconUrl ?? null, is_active: payload.is_active ?? true }, { transaction });
    await createAdminAuditLog({
      adminId: admin.id, action: ADMIN_AUDIT_ACTIONS.SERVICE_CREATED, targetType: ADMIN_AUDIT_TARGETS.SERVICE, targetId: service.id,
      beforeState: {}, afterState: { service_code: service.service_code, service_name: service.name, is_active: service.is_active, icon_configured: Boolean(service.icon_url) },
      ...auditMeta(requestMeta), transaction
    });
    return toDto(service, { total_jobs: 0, active_jobs: 0, total_handyman_associations: 0, active_handyman_associations: 0 });
  });
};

const updateAdminService = async ({ serviceId, payload = {}, admin, requestMeta }) => {
  assertUuid(serviceId, 'serviceId');
  validateBodyKeys(payload, ['name', 'icon_url']);
  if (!Object.keys(payload).length) throw new AdminManagementError('At least one editable field is required.');
  return db.transaction(async (transaction) => {
    const service = await Service.findByPk(serviceId, { transaction, lock: transaction.LOCK.UPDATE });
    if (!service) throw new AdminManagementError('Service not found.', 404, 'SERVICE_NOT_FOUND');
    const name = payload.name === undefined ? service.name : normalizePlainText(payload.name, 'name', 100, { required: true });
    if (name.length < 2) throw new AdminManagementError('name must contain at least 2 characters.');
    const iconUrl = payload.icon_url === undefined ? service.icon_url : normalizeIconUrl(payload.icon_url);
    await db.query('SELECT pg_advisory_xact_lock(731003)', { transaction });
    await ensureUniqueService({ name, excludeId: service.id, transaction });
    const before = { service_code: service.service_code, service_name: service.name, is_active: service.is_active, icon_configured: Boolean(service.icon_url) };
    if (service.name === name && service.icon_url === iconUrl) throw new AdminManagementError('Service already has the requested values.', 409, 'SERVICE_UPDATE_ALREADY_APPLIED');
    await service.update({ name, icon_url: iconUrl }, { transaction });
    await createAdminAuditLog({
      adminId: admin.id, action: ADMIN_AUDIT_ACTIONS.SERVICE_UPDATED, targetType: ADMIN_AUDIT_TARGETS.SERVICE, targetId: service.id,
      beforeState: before, afterState: { service_code: service.service_code, service_name: service.name, is_active: service.is_active, icon_configured: Boolean(service.icon_url) },
      ...auditMeta(requestMeta), transaction
    });
    return toDto(service, null);
  });
};

const setAdminServiceActive = async ({ serviceId, activate, admin, requestMeta }) => {
  assertUuid(serviceId, 'serviceId');
  return db.transaction(async (transaction) => {
    const service = await Service.findByPk(serviceId, { transaction, lock: transaction.LOCK.UPDATE });
    if (!service) throw new AdminManagementError('Service not found.', 404, 'SERVICE_NOT_FOUND');
    if (service.is_active === activate) throw new AdminManagementError('Service status is already set.', 409, 'SERVICE_STATUS_ALREADY_SET');
    const before = { service_code: service.service_code, service_name: service.name, is_active: service.is_active, icon_configured: Boolean(service.icon_url) };
    service.is_active = activate;
    await service.save({ transaction });
    await createAdminAuditLog({
      adminId: admin.id, action: activate ? ADMIN_AUDIT_ACTIONS.SERVICE_ACTIVATED : ADMIN_AUDIT_ACTIONS.SERVICE_DEACTIVATED,
      targetType: ADMIN_AUDIT_TARGETS.SERVICE, targetId: service.id, beforeState: before,
      afterState: { service_code: service.service_code, service_name: service.name, is_active: service.is_active, icon_configured: Boolean(service.icon_url) },
      ...auditMeta(requestMeta), transaction
    });
    return toDto(service, null);
  });
};

export { createAdminService, getAdminService, getAdminServices, setAdminServiceActive, updateAdminService };
