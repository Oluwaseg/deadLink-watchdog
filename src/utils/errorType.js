/**
 * Map crawler error type strings (e.g. "404_not_found") to Prisma ErrorType enum values.
 */
const ERROR_TYPE_MAP = {
  '404_not_found': 'e404_not_found',
  '403_forbidden': 'e403_forbidden',
  '500_server_error': 'e500_server_error',
  timeout: 'timeout',
  connection_refused: 'connection_refused',
  connection_error: 'connection_refused',
  dns_error: 'dns_error',
  ssl_error: 'ssl_error',
  redirect_loop: 'redirect_loop',
  too_many_redirects: 'too_many_redirects',
  other: 'other',
};

const ERROR_TYPE_REVERSE = Object.fromEntries(
  Object.entries(ERROR_TYPE_MAP).map(([k, v]) => [v, k])
);

function toPrismaErrorType(errorType) {
  return ERROR_TYPE_MAP[errorType] || 'other';
}

function fromPrismaErrorType(errorType) {
  return ERROR_TYPE_REVERSE[errorType] || errorType;
}

module.exports = {
  toPrismaErrorType,
  fromPrismaErrorType,
  ERROR_TYPE_MAP,
};
