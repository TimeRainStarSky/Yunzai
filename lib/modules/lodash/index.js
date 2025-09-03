import _ from "es-toolkit/compat"
const isIterateeCall = await import ('../../../node_modules/es-toolkit/dist/compat/_internal/isIterateeCall.js').default
const eq =await import ('../../../node_modules/es-toolkit/dist/compat/util/eq.js').default
_.defaults = (object, ...sources) => {
  object = Object(object);
    const objectProto = Object.prototype;
    let length = sources.length;
    const guard = length > 2 ? sources[2] : undefined;
    if (guard && isIterateeCall.isIterateeCall(sources[0], sources[1], guard)) {
        length = 1;
    }
    for (let i = 0; i < length; i++) {
        const source = sources[i] != null ? sources[i] : [];
        const keys = Object.keys(source);
        for (let j = 0; j < keys.length; j++) {
            const key = keys[j];
            const value = object[key];
            if (value === undefined ||
                (!Object.hasOwn(object, key) && eq.eq(value, objectProto[key]))) {
                object[key] = source[key];
            }
        }
    }
    return object;
}

export default _
