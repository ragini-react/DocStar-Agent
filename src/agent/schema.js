// JSON schema helpers for strict AI answers. No I/O, so modules using them stay unit-testable.
// Strict mode needs every property required and no extras.
export const obj = properties => ({ type: 'object', additionalProperties: false, required: Object.keys(properties), properties })
export const str = description => ({ type: 'string', description })
export const int = description => ({ type: 'integer', description })
export const bool = description => ({ type: 'boolean', description })
export const arr = (items, description) => ({ type: 'array', items, description })
export const oneOf = (values, description) => ({ type: 'string', enum: values, description })
