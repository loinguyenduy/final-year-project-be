class AiError extends Error {
  constructor(message, httpStatus = 400, code = 'VALIDATION_ERROR', details = '') {
    super(message);
    this.name = 'AiError';
    this.httpStatus = httpStatus;
    this.code = code;
    this.details = details;
  }
}

export default AiError;
