const PASSWORD_ACTION_PURPOSES = Object.freeze({
  RESET: 'RESET_PASSWORD',
  SET: 'SET_PASSWORD'
});

const PASSWORD_ACTION_TTL_MS = (() => {
  const minutes = Number.parseInt(process.env.PASSWORD_ACTION_TOKEN_TTL_MINUTES || '15', 10);
  return (Number.isInteger(minutes) && minutes > 0 ? minutes : 15) * 60 * 1000;
})();

const PASSWORD_ACTION_RESEND_COOLDOWN_MS = (() => {
  const seconds = Number.parseInt(process.env.PASSWORD_ACTION_RESEND_COOLDOWN_SECONDS || '60', 10);
  return (Number.isInteger(seconds) && seconds > 0 ? seconds : 60) * 1000;
})();

const validatePassword = (value) => {
  if (typeof value !== 'string' || value.length < 6 || value.length > 128) {
    return 'Password must contain between 6 and 128 characters.';
  }
  if (/\p{Cc}/u.test(value)) return 'Password contains unsupported control characters.';
  return null;
};

export {
  PASSWORD_ACTION_PURPOSES,
  PASSWORD_ACTION_RESEND_COOLDOWN_MS,
  PASSWORD_ACTION_TTL_MS,
  validatePassword
};
