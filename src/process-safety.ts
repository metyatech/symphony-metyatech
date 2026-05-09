const SECRET_NAME_PATTERN = /(api[_-]?key|token|secret|password|credential|authorization)/i;
const SECRET_VALUE_PATTERN = /(lin_api_[A-Za-z0-9_-]+|sk-[A-Za-z0-9_-]+|Bearer\s+[A-Za-z0-9._-]+)/g;
const URL_CREDENTIAL_PATTERN = /(https?:\/\/)[^/\s:@]+:[^/\s@]+@/g;

export function sanitizedProcessEnv(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined || SECRET_NAME_PATTERN.test(key)) continue;
    result[key] = value;
  }
  return result;
}

export function redactSecrets(value: string): string {
  return value
    .replace(URL_CREDENTIAL_PATTERN, "$1[REDACTED]@")
    .replace(SECRET_VALUE_PATTERN, "[REDACTED]");
}

export function isSecretEnvName(name: string): boolean {
  return SECRET_NAME_PATTERN.test(name);
}
