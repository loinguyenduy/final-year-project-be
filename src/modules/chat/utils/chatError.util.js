class ChatError extends Error {
  constructor(message, ec, code, dt = '') {
    super(message);
    this.name = 'ChatError';
    this.ec = ec;
    this.code = code;
    this.dt = dt;
  }
}

const chatError = (message, ec, code, dt = '') => new ChatError(message, ec, code, dt);

const toErrorEnvelope = (error) => {
  if (error instanceof ChatError) {
    return { EM: error.message, EC: error.ec, code: error.code, DT: error.dt };
  }

  return {
    EM: 'Internal chat server error.',
    EC: 500,
    code: 'INTERNAL_SERVER_ERROR',
    DT: ''
  };
};

export { ChatError, chatError, toErrorEnvelope };
