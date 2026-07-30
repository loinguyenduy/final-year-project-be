import 'dotenv/config';

const CONFIRMATION = 'CREATE_PRODUCTION_SERVICES';
const hasValidateOnly = process.argv.includes('--validate-only')
  || String(process.env.npm_config_validate_only || '').toLowerCase() === 'true';

const SERVICE_CATALOGUE = Object.freeze([
  { service_code: 'AIR_CONDITIONER_REPAIR', name: 'Air Conditioner Repair', icon_url: null, is_active: true },
  { service_code: 'ELECTRICAL_REPAIR', name: 'Electrical Repair', icon_url: null, is_active: true },
  { service_code: 'PLUMBING_REPAIR', name: 'Plumbing Repair', icon_url: null, is_active: true },
  { service_code: 'WATER_HEATER_REPAIR', name: 'Water Heater Repair', icon_url: null, is_active: true },
  { service_code: 'WASHING_MACHINE_REPAIR', name: 'Washing Machine Repair', icon_url: null, is_active: true },
  { service_code: 'DOOR_LOCK_REPAIR', name: 'Door Lock Repair', icon_url: null, is_active: true },
  { service_code: 'LIGHTING_INSTALLATION', name: 'Lighting Installation', icon_url: null, is_active: true },
  { service_code: 'CEILING_FAN_INSTALLATION', name: 'Ceiling Fan Installation', icon_url: null, is_active: true },
  { service_code: 'FURNITURE_ASSEMBLY', name: 'Furniture Assembly', icon_url: null, is_active: true },
  { service_code: 'INTERIOR_PAINTING', name: 'Interior Painting', icon_url: null, is_active: true },
  { service_code: 'TV_WALL_MOUNTING', name: 'TV Wall Mounting', icon_url: null, is_active: true },
  { service_code: 'ROOF_REPAIR', name: 'Roof Repair', icon_url: null, is_active: true },
  { service_code: 'WINDOW_REPAIR', name: 'Window Repair', icon_url: null, is_active: true },
  { service_code: 'HOME_CLEANING', name: 'Home Cleaning', icon_url: null, is_active: true },
  { service_code: 'GARDEN_MAINTENANCE', name: 'Garden Maintenance', icon_url: null, is_active: true },
]);

const validateInputs = () => {
  if (process.env.BOOTSTRAP_SERVICES_CONFIRM !== CONFIRMATION) {
    throw new Error(`BOOTSTRAP_SERVICES_CONFIRM must equal ${CONFIRMATION}.`);
  }
  if (String(process.env.DB_SYNC_ALTER || '').trim().toLowerCase() !== 'false') {
    throw new Error('DB_SYNC_ALTER must be false.');
  }
  const codes = new Set(SERVICE_CATALOGUE.map((service) => service.service_code));
  const names = new Set(SERVICE_CATALOGUE.map((service) => service.name));
  if (codes.size !== SERVICE_CATALOGUE.length || names.size !== SERVICE_CATALOGUE.length) {
    throw new Error('The built-in Service catalogue contains duplicate identifiers.');
  }
};

const run = async () => {
  validateInputs();
  if (hasValidateOnly) {
    console.log(`Service bootstrap configuration is valid for ${SERVICE_CATALOGUE.length} Services; no database connection was made.`);
    return;
  }

  const [{ Op }, { default: db }, { default: Service }] = await Promise.all([
    import('sequelize'),
    import('../../src/core/database/connection.js'),
    import('../../src/modules/matchmaking/models/Service.model.js'),
  ]);
  await db.authenticate();
  const transaction = await db.transaction();
  try {
    await db.query(
      "SELECT pg_advisory_xact_lock(hashtext('trusted-handyman-bootstrap-services'))",
      { transaction },
    );
    const existingRows = await Service.findAll({
      where: {
        [Op.or]: [
          { service_code: { [Op.in]: SERVICE_CATALOGUE.map((service) => service.service_code) } },
          { name: { [Op.in]: SERVICE_CATALOGUE.map((service) => service.name) } },
        ],
      },
      transaction,
    });
    const byCode = new Map(existingRows.map((service) => [service.service_code, service]));
    const byName = new Map(existingRows.map((service) => [service.name, service]));
    const toCreate = [];

    for (const expected of SERVICE_CATALOGUE) {
      const existing = byCode.get(expected.service_code) || byName.get(expected.name);
      if (!existing) {
        toCreate.push(expected);
        continue;
      }
      if (
        existing.service_code !== expected.service_code
        || existing.name !== expected.name
        || existing.is_active !== true
        || existing.icon_url !== null
      ) {
        throw new Error(`Service catalogue conflict for ${expected.service_code}; no existing row was modified.`);
      }
    }

    if (toCreate.length) {
      await Service.bulkCreate(toCreate, { transaction, validate: true });
    }
    await transaction.commit();
    console.log(
      `Service bootstrap completed: created=${toCreate.length}, existing=${SERVICE_CATALOGUE.length - toCreate.length}.`,
    );
  } catch (error) {
    if (!transaction.finished) await transaction.rollback();
    throw error;
  } finally {
    await db.close();
  }
};

run().catch((error) => {
  console.error(`Service bootstrap failed: ${error?.message || 'unknown error'}`);
  process.exitCode = 1;
});

export { SERVICE_CATALOGUE };
