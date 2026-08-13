const OPTIONAL = Symbol("optional-json-schema-property");

function schema(type, options = {}) {
  return { type, ...(options || {}) };
}

export const Type = Object.freeze({
  String: (options = {}) => schema("string", options),
  Number: (options = {}) => schema("number", options),
  Boolean: (options = {}) => schema("boolean", options),
  Any: (options = {}) => ({ ...(options || {}) }),
  Array: (items, options = {}) => schema("array", { items, ...(options || {}) }),
  Optional: (value) => {
    const result = { ...(value || {}) };
    Object.defineProperty(result, OPTIONAL, { value: true, enumerable: false });
    return result;
  },
  Object: (properties = {}, options = {}) => {
    const required = Object.entries(properties)
      .filter(([, value]) => !value?.[OPTIONAL])
      .map(([name]) => name);
    return schema("object", {
      properties,
      ...(required.length ? { required } : {}),
      additionalProperties: false,
      ...(options || {}),
    });
  },
});

export default Type;
