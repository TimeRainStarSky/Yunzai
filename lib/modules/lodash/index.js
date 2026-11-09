import _ from "es-toolkit/compat"
import isIterateeCall from "../../../node_modules/es-toolkit/dist/compat/_internal/isIterateeCall.js"
_.defaults = (object, ...sources) => {
  object = Object(object)
  const objectProto = Object.prototype
  let length = sources.length
  const guard = length > 2 ? sources[2] : undefined
  if (guard && isIterateeCall.isIterateeCall(sources[0], sources[1], guard)) length = 1
  for (let i = 0; i < length; i++) {
    const source = sources[i] ?? {}
    for (const key in source) {
      const value = object[key]
      if (value === undefined || (!Object.hasOwn(object, key) && _.eq(value, objectProto[key])))
        object[key] = source[key]
    }
  }
  return object
}
export default _
