import 'dotenv/config';
import db from '../../src/core/database/connection.js';

const enabled = process.env.ALLOW_MANUAL_PARTICIPANT_READ_TEST === 'true';
if (process.env.NODE_ENV === 'production' || !enabled) {
  console.error('Refusing to run. Set ALLOW_MANUAL_PARTICIPANT_READ_TEST=true in a non-production environment.');
  process.exitCode = 1;
} else {
  try {
    await db.authenticate();
    const [schemaRows] = await db.query(`
      SELECT table_name, column_name FROM information_schema.columns
      WHERE table_schema = current_schema() AND (
        (table_name = 'Password_Action_Tokens' AND column_name IN
          ('id','user_id','purpose','token_hash','issued_auth_version','expires_at','consumed_at','revoked_at'))
        OR (table_name = 'Reviews' AND column_name IN
          ('acceptance_cycle','reviewer_role','reviewee_role'))
      ) ORDER BY table_name, column_name
    `);
    const reviewColumns = new Set(schemaRows.filter((entry) => entry.table_name === 'Reviews').map((entry) => entry.column_name));
    const hasCanonicalColumns = ['acceptance_cycle', 'reviewer_role', 'reviewee_role'].every((column) => reviewColumns.has(column));
    const [reviewRows] = await db.query(hasCanonicalColumns ? `
      SELECT COUNT(*)::integer AS total,
        COUNT(*) FILTER (WHERE acceptance_cycle IS NULL)::integer AS missing_cycle,
        COUNT(*) FILTER (WHERE reviewer_role IS NULL OR reviewee_role IS NULL)::integer AS missing_role,
        COUNT(*) FILTER (WHERE rating_stars NOT BETWEEN 1 AND 5)::integer AS invalid_rating,
        COUNT(*) FILTER (WHERE acceptance_cycle >= 1
          AND reviewer_role IN ('CUSTOMER','HANDYMAN')
          AND reviewee_role IN ('CUSTOMER','HANDYMAN')
          AND reviewer_role <> reviewee_role AND reviewer_id <> reviewee_id
          AND rating_stars BETWEEN 1 AND 5)::integer AS canonical
      FROM "Reviews"
    ` : 'SELECT COUNT(*)::integer AS total FROM "Reviews"');
    const counts = hasCanonicalColumns
      ? reviewRows[0]
      : { ...reviewRows[0], canonical: 0, missing_cycle: reviewRows[0].total, missing_role: reviewRows[0].total, invalid_rating: null, note: 'Additive Review columns are not deployed yet.' };
    console.log(JSON.stringify({ schema_columns: schemaRows, review_counts: counts }, null, 2));
    const token = process.env.PARTICIPANT_ACCESS_TOKEN;
    const baseUrl = process.env.API_BASE_URL || 'http://localhost:5000/api/v1';
    if (token) {
      for (const path of ['/identity/profile', '/fintech/wallets/me']) {
        const response = await fetch(`${baseUrl}${path}`, { headers: { Authorization: `Bearer ${token}` } });
        const body = await response.json();
        console.log(`${path}: HTTP ${response.status} code=${body.code || body.EC}`);
      }
    } else console.log('PARTICIPANT_ACCESS_TOKEN is unset; authenticated HTTP smoke was skipped.');
  } catch (error) {
    console.error('Manual read test failed:', error.message);
    process.exitCode = 1;
  } finally {
    await db.close();
  }
}
