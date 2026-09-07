import 'dotenv/config';
import { inspectEnvironment, STAGES } from '../../src/core/config/environmentValidation.js';

const stageArgument = process.argv.find((argument) => argument.startsWith('--stage='));
const stage = stageArgument?.slice('--stage='.length)
  || process.env.npm_config_stage
  || 'full';

if (!STAGES.includes(stage)) {
  console.error(`Configuration check failed: --stage must be one of ${STAGES.join(', ')}.`);
  process.exitCode = 1;
} else {
  const result = inspectEnvironment({ stage });
  const featureEntries = Object.entries(result.featureMissing);
  if (result.errors.length || result.missing.length || featureEntries.length) {
    console.error(`Configuration check failed for stage "${stage}".`);
    result.errors.forEach((error) => console.error(`- ${error}`));
    if (result.missing.length) {
      console.error(`- Missing required variables: ${result.missing.join(', ')}`);
    }
    featureEntries.forEach(([feature, names]) => {
      console.error(`- Missing ${feature} variables: ${names.join(', ')}`);
    });
    process.exitCode = 1;
  } else {
    console.log(`Configuration check passed for stage "${stage}".`);
  }
}
