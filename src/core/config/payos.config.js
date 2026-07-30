import { PayOS } from '@payos/node';

const PAYOS_VARIABLES = ['PAYOS_CLIENT_ID', 'PAYOS_API_KEY', 'PAYOS_CHECKSUM_KEY'];
let payOSInstance;

class PayOSConfigurationError extends Error {
  constructor() {
    super('PayOS is not configured.');
    this.name = 'PayOSConfigurationError';
    this.code = 'PAYOS_NOT_CONFIGURED';
  }
}

const getMissingPayOSVariables = () => (
  PAYOS_VARIABLES.filter((name) => !String(process.env[name] || '').trim())
);

const getPayOSInstance = () => {
  if (getMissingPayOSVariables().length > 0) {
    throw new PayOSConfigurationError();
  }
  if (!payOSInstance) {
    payOSInstance = new PayOS({
      clientId: process.env.PAYOS_CLIENT_ID,
      apiKey: process.env.PAYOS_API_KEY,
      checksumKey: process.env.PAYOS_CHECKSUM_KEY,
    });
  }
  return payOSInstance;
};

export {
  PAYOS_VARIABLES,
  PayOSConfigurationError,
  getMissingPayOSVariables,
  getPayOSInstance,
};
