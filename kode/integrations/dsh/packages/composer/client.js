// Generated from pinned dsh 0.2.1-rc.5 (MIT). npm run build:composer
window.__ModuleLoader__.load({id:'@kode/dsh-composer',factory(require){const module={exports:{}};const exports=module.exports;
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to2, from2, except, desc) => {
  if (from2 && typeof from2 === "object" || typeof from2 === "function") {
    for (let key of __getOwnPropNames(from2))
      if (!__hasOwnProp.call(to2, key) && key !== except)
        __defProp(to2, key, { get: () => from2[key], enumerable: !(desc = __getOwnPropDesc(from2, key)) || desc.enumerable });
  }
  return to2;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// node_modules/@deepseek-ai/dsh-client-ui-conversation/native-composer.js
var native_composer_exports = {};
__export(native_composer_exports, {
  PortableTextComposer: () => PortableTextComposer,
  apply: () => applyPortableComposer,
  portableComposerCapabilities: () => portableComposerCapabilities
});
module.exports = __toCommonJS(native_composer_exports);
var _deepseek_ai_dsh_client_ui_primitives = __toESM(require("@deepseek-ai/dsh-client-ui-primitives"));
var _deepseek_ai_dsh_client_store = __toESM(require("@deepseek-ai/dsh-client-store"));
var _deepseek_ai_dsh_client_ui_slots = __toESM(require("@deepseek-ai/dsh-client-ui-slots"));
var _deepseek_ai_cordis = __toESM(require("@deepseek-ai/cordis"));
var react_jsx_runtime = __toESM(require("react/jsx-runtime"));
var react = __toESM(require("react"));
var zod = __toESM(require("zod"));
var react_dom = __toESM(require("react-dom"));
function isNullable(value) {
  return value === null || value === void 0;
}
function isPlainObject(data) {
  return data && typeof data === "object" && !Array.isArray(data);
}
function filterKeys(object, filter) {
  return Object.fromEntries(Object.entries(object).filter(([key, value]) => filter(key, value)));
}
function mapValues(object, transform) {
  return Object.fromEntries(Object.entries(object).map(([key, value]) => [key, transform(value, key)]));
}
function pick(source, keys, forced) {
  if (!keys) return { ...source };
  const result = {};
  for (const key of keys) if (forced || source[key] !== void 0) result[key] = source[key];
  return result;
}
var write = Symbol.for("cosmokit.volatile.write");
function snapshot(value, ancestors = /* @__PURE__ */ new Set()) {
  if (typeof value === "function") throw new TypeError("volatile config cannot contain functions");
  if (value === null || typeof value !== "object") return value;
  if (ancestors.has(value)) throw new TypeError("volatile config cannot contain cycles");
  ancestors.add(value);
  try {
    if (Array.isArray(value)) return Object.freeze(value.map((item) => snapshot(item, ancestors)));
    if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) throw new TypeError("volatile config objects must be plain objects or arrays");
    return Object.freeze(Object.fromEntries(Object.entries(value).map(([key, item]) => [key, snapshot(item, ancestors)])));
  } finally {
    ancestors.delete(value);
  }
}
function createVolatile(value) {
  let current = snapshot(value);
  return Object.freeze({
    get: () => current,
    [write]: (value2) => {
      current = value2;
    }
  });
}
function isVolatile(value) {
  return typeof value === "object" && value !== null && write in value;
}
function is$1(type, value) {
  if (arguments.length === 1) return (value2) => is$1(type, value2);
  return type in globalThis && value instanceof globalThis[type] || Object.prototype.toString.call(value).slice(8, -1) === type;
}
function isArrayBufferLike(value) {
  return is$1("ArrayBuffer", value) || is$1("SharedArrayBuffer", value);
}
function isArrayBufferSource(value) {
  return isArrayBufferLike(value) || ArrayBuffer.isView(value);
}
var Binary;
(function(Binary2) {
  Binary2.is = isArrayBufferLike;
  Binary2.isSource = isArrayBufferSource;
  function fromSource(source) {
    if (ArrayBuffer.isView(source)) return source.buffer.slice(source.byteOffset, source.byteOffset + source.byteLength);
    else return source;
  }
  Binary2.fromSource = fromSource;
  function toBase64(source) {
    source = fromSource(source);
    if (typeof Buffer !== "undefined") return Buffer.from(source).toString("base64");
    let binary = "";
    const bytes = new Uint8Array(source);
    for (let i2 = 0; i2 < bytes.byteLength; i2++) binary += String.fromCharCode(bytes[i2]);
    return btoa(binary);
  }
  Binary2.toBase64 = toBase64;
  function fromBase64(source) {
    if (typeof Buffer !== "undefined") return fromSource(Buffer.from(source, "base64"));
    return Uint8Array.from(atob(source), (c2) => c2.charCodeAt(0));
  }
  Binary2.fromBase64 = fromBase64;
  function toHex(source) {
    source = fromSource(source);
    if (typeof Buffer !== "undefined") return Buffer.from(source).toString("hex");
    return Array.from(new Uint8Array(source), (byte) => byte.toString(16).padStart(2, "0")).join("");
  }
  Binary2.toHex = toHex;
  function fromHex(source) {
    if (typeof Buffer !== "undefined") return fromSource(Buffer.from(source, "hex"));
    const hex = source.length % 2 === 0 ? source : source.slice(0, source.length - 1);
    const buffer = [];
    for (let i2 = 0; i2 < hex.length; i2 += 2) buffer.push(parseInt(`${hex[i2]}${hex[i2 + 1]}`, 16));
    return Uint8Array.from(buffer).buffer;
  }
  Binary2.fromHex = fromHex;
})(Binary || (Binary = {}));
Binary.fromBase64;
Binary.toBase64;
Binary.fromHex;
Binary.toHex;
function clone(source, refs = /* @__PURE__ */ new Map()) {
  if (!source || typeof source !== "object") return source;
  if (is$1("Date", source)) return new Date(source.valueOf());
  if (is$1("RegExp", source)) return new RegExp(source.source, source.flags);
  if (isArrayBufferLike(source)) return source.slice(0);
  if (ArrayBuffer.isView(source)) return source.buffer.slice(source.byteOffset, source.byteOffset + source.byteLength);
  const cached = refs.get(source);
  if (cached) return cached;
  if (Array.isArray(source)) {
    const result2 = [];
    refs.set(source, result2);
    source.forEach((value, index) => {
      result2[index] = Reflect.apply(clone, null, [value, refs]);
    });
    return result2;
  }
  const result = Object.create(Object.getPrototypeOf(source));
  refs.set(source, result);
  for (const key of Reflect.ownKeys(source)) {
    const descriptor = { ...Reflect.getOwnPropertyDescriptor(source, key) };
    if ("value" in descriptor) descriptor.value = Reflect.apply(clone, null, [descriptor.value, refs]);
    Reflect.defineProperty(result, key, descriptor);
  }
  return result;
}
function deepEqual(a2, b2, strict) {
  const ancestors = /* @__PURE__ */ new Set();
  function compare(a3, b3) {
    if (a3 === b3) return true;
    if (isVolatile(a3) || isVolatile(b3)) return isVolatile(a3) && isVolatile(b3);
    if (!strict && isNullable(a3) && isNullable(b3)) return true;
    if (typeof a3 !== typeof b3 || typeof a3 !== "object" || !a3 || !b3) return false;
    if (ancestors.has(a3)) return false;
    function check(test, then) {
      return test(a3) ? test(b3) ? then(a3, b3) : false : test(b3) ? false : void 0;
    }
    ancestors.add(a3);
    try {
      return check(Array.isArray, (a4, b4) => {
        if (a4.length !== b4.length) return false;
        for (let index = 0; index < a4.length; index++) if (!compare(a4[index], b4[index])) return false;
        return true;
      }) ?? check(is$1("Date"), (a4, b4) => a4.valueOf() === b4.valueOf()) ?? check(is$1("URL"), (a4, b4) => a4.href === b4.href) ?? check(is$1("RegExp"), (a4, b4) => a4.source === b4.source && a4.flags === b4.flags) ?? check(isArrayBufferLike, (a4, b4) => {
        if (a4.byteLength !== b4.byteLength) return false;
        const viewA = new Uint8Array(a4);
        const viewB = new Uint8Array(b4);
        for (let i2 = 0; i2 < viewA.length; i2++) if (viewA[i2] !== viewB[i2]) return false;
        return true;
      }) ?? ((!strict || [a3, b3].every((value) => Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)) && Object.keys({
        ...a3,
        ...b3
      }).every((key) => compare(a3[key], b3[key])));
    } finally {
      ancestors.delete(a3);
    }
  }
  return compare(a2, b2);
}
var Time;
(function(Time2) {
  Time2.millisecond = 1;
  Time2.second = 1e3;
  Time2.minute = Time2.second * 60;
  Time2.hour = Time2.minute * 60;
  Time2.day = Time2.hour * 24;
  Time2.week = Time2.day * 7;
  let timezoneOffset = (/* @__PURE__ */ new Date()).getTimezoneOffset();
  function setTimezoneOffset(offset) {
    timezoneOffset = offset;
  }
  Time2.setTimezoneOffset = setTimezoneOffset;
  function getTimezoneOffset() {
    return timezoneOffset;
  }
  Time2.getTimezoneOffset = getTimezoneOffset;
  function getDateNumber(date2 = /* @__PURE__ */ new Date(), offset) {
    if (typeof date2 === "number") date2 = new Date(date2);
    if (offset === void 0) offset = timezoneOffset;
    return Math.floor((date2.valueOf() / Time2.minute - offset) / 1440);
  }
  Time2.getDateNumber = getDateNumber;
  function fromDateNumber(value, offset) {
    const date2 = new Date(value * Time2.day);
    if (offset === void 0) offset = timezoneOffset;
    return new Date(+date2 + offset * Time2.minute);
  }
  Time2.fromDateNumber = fromDateNumber;
  const numeric = /\d+(?:\.\d+)?/.source;
  const timeRegExp = new RegExp(`^${[
    "w(?:eek(?:s)?)?",
    "d(?:ay(?:s)?)?",
    "h(?:our(?:s)?)?",
    "m(?:in(?:ute)?(?:s)?)?",
    "s(?:ec(?:ond)?(?:s)?)?"
  ].map((unit) => `(${numeric}${unit})?`).join("")}$`);
  function parseTime(source) {
    const capture = timeRegExp.exec(source);
    if (!capture) return 0;
    return (parseFloat(capture[1]) * Time2.week || 0) + (parseFloat(capture[2]) * Time2.day || 0) + (parseFloat(capture[3]) * Time2.hour || 0) + (parseFloat(capture[4]) * Time2.minute || 0) + (parseFloat(capture[5]) * Time2.second || 0);
  }
  Time2.parseTime = parseTime;
  function parseDate(date2) {
    const parsed = parseTime(date2);
    if (parsed) date2 = Date.now() + parsed;
    else if (/^\d{1,2}(:\d{1,2}){1,2}$/.test(date2)) date2 = `${(/* @__PURE__ */ new Date()).toLocaleDateString()}-${date2}`;
    else if (/^\d{1,2}-\d{1,2}-\d{1,2}(:\d{1,2}){1,2}$/.test(date2)) date2 = `${(/* @__PURE__ */ new Date()).getFullYear()}-${date2}`;
    return date2 ? new Date(date2) : /* @__PURE__ */ new Date();
  }
  Time2.parseDate = parseDate;
  function format(ms2) {
    const abs = Math.abs(ms2);
    if (abs >= Time2.day - Time2.hour / 2) return Math.round(ms2 / Time2.day) + "d";
    else if (abs >= Time2.hour - Time2.minute / 2) return Math.round(ms2 / Time2.hour) + "h";
    else if (abs >= Time2.minute - Time2.second / 2) return Math.round(ms2 / Time2.minute) + "m";
    else if (abs >= Time2.second) return Math.round(ms2 / Time2.second) + "s";
    return ms2 + "ms";
  }
  Time2.format = format;
  function toDigits(source, length = 2) {
    return source.toString().padStart(length, "0");
  }
  Time2.toDigits = toDigits;
  function template(template2, time = /* @__PURE__ */ new Date()) {
    return template2.replace("yyyy", time.getFullYear().toString()).replace("yy", time.getFullYear().toString().slice(2)).replace("MM", toDigits(time.getMonth() + 1)).replace("dd", toDigits(time.getDate())).replace("hh", toDigits(time.getHours())).replace("mm", toDigits(time.getMinutes())).replace("ss", toDigits(time.getSeconds())).replace("SSS", toDigits(time.getMilliseconds(), 3));
  }
  Time2.template = template;
})(Time || (Time = {}));
var kSchema = Symbol.for("schemastery");
var kValidationError = Symbol.for("ValidationError");
globalThis.__schemastery_index__ ??= 0;
globalThis.__schemastery_refs__ = void 0;
var ValidationError = class extends TypeError {
  options;
  name = "ValidationError";
  constructor(message, options) {
    let prefix = "$";
    for (const segment of options.path || []) if (typeof segment === "string") prefix += "." + segment;
    else if (typeof segment === "number") prefix += "[" + segment + "]";
    else if (typeof segment === "symbol") prefix += `[Symbol(${segment.toString()})]`;
    if (prefix.startsWith(".")) prefix = prefix.slice(1);
    super((prefix === "$" ? "" : `${prefix} `) + message);
    this.options = options;
  }
  static is(error) {
    return !!error?.[kValidationError];
  }
};
Object.defineProperty(ValidationError.prototype, kValidationError, { value: true });
var Schema = function(options) {
  const schema = function(data, options2 = {}) {
    return Schema.resolve(data, schema, options2)[0];
  };
  if (options.refs) {
    const refs = mapValues(options.refs, (options2) => new Schema(options2));
    const getRef = (uid) => refs[uid];
    for (const key in refs) {
      const options2 = refs[key];
      options2.sKey = getRef(options2.sKey);
      options2.inner = getRef(options2.inner);
      options2.list = options2.list && options2.list.map(getRef);
      options2.dict = options2.dict && mapValues(options2.dict, getRef);
    }
    return refs[options.uid];
  }
  Object.assign(schema, options);
  if (typeof schema.callback === "string") try {
    schema.callback = new Function("return " + schema.callback)();
  } catch {
  }
  Object.defineProperty(schema, "uid", { value: globalThis.__schemastery_index__++ });
  Object.setPrototypeOf(schema, Schema.prototype);
  schema.meta ||= {};
  schema.toString = schema.toString.bind(schema);
  return schema;
};
Schema.prototype = Object.create(Function.prototype);
Schema.prototype[kSchema] = true;
Object.defineProperty(Schema.prototype, "~standard", { get() {
  return {
    version: 1,
    vendor: "schemastery",
    validate: (value) => {
      try {
        return { value: Schema.resolve(value, this, {})[0] };
      } catch (error) {
        if (ValidationError.is(error)) return { issues: [{
          message: error.message,
          path: error.options.path
        }] };
        throw error;
      }
    }
  };
} });
Schema.ValidationError = ValidationError;
Schema.prototype.toJSON = function toJSON() {
  if (globalThis.__schemastery_refs__) {
    globalThis.__schemastery_refs__[this.uid] ??= JSON.parse(JSON.stringify({ ...this }));
    return this.uid;
  }
  globalThis.__schemastery_refs__ = { [this.uid]: { ...this } };
  globalThis.__schemastery_refs__[this.uid] = JSON.parse(JSON.stringify({ ...this }));
  const result = {
    uid: this.uid,
    refs: globalThis.__schemastery_refs__
  };
  globalThis.__schemastery_refs__ = void 0;
  return result;
};
Schema.prototype.set = function set(key, value) {
  this.dict[key] = value;
  return this;
};
Schema.prototype.push = function push(value) {
  this.list.push(value);
  return this;
};
function mergeDesc(original, messages) {
  const result = typeof original === "string" ? { "": original } : { ...original };
  for (const locale in messages) {
    const value = messages[locale];
    if (value?.$description || value?.$desc) result[locale] = value.$description || value.$desc;
    else if (typeof value === "string") result[locale] = value;
  }
  return result;
}
function getInner(value) {
  return value?.$value ?? value?.$inner;
}
function extractKeys(data) {
  return filterKeys(data ?? {}, (key) => !key.startsWith("$"));
}
Schema.prototype.i18n = function i18n(messages) {
  const schema = Schema(this);
  const desc = mergeDesc(schema.meta.description, messages);
  if (Object.keys(desc).length) schema.meta.description = desc;
  if (schema.dict) schema.dict = mapValues(schema.dict, (inner, key) => {
    return inner.i18n(mapValues(messages, (data) => getInner(data)?.[key] ?? data?.[key]));
  });
  if (schema.list) schema.list = schema.list.map((inner, index) => {
    return inner.i18n(mapValues(messages, (data = {}) => {
      if (Array.isArray(getInner(data))) return getInner(data)[index];
      if (Array.isArray(data)) return data[index];
      return extractKeys(data);
    }));
  });
  if (schema.inner) schema.inner = schema.inner.i18n(mapValues(messages, (data) => {
    if (getInner(data)) return getInner(data);
    return extractKeys(data);
  }));
  if (schema.sKey) schema.sKey = schema.sKey.i18n(mapValues(messages, (data) => data?.$key));
  return schema;
};
Schema.prototype.extra = function extra(key, value) {
  const schema = Schema(this);
  schema.meta = {
    ...schema.meta,
    [key]: value
  };
  return schema;
};
for (const key of [
  "required",
  "disabled",
  "collapse",
  "hidden",
  "loose"
]) Object.assign(Schema.prototype, { [key](value = true) {
  const schema = Schema(this);
  schema.meta = {
    ...schema.meta,
    [key]: value
  };
  return schema;
} });
Schema.prototype.deprecated = function deprecated() {
  const schema = Schema(this);
  schema.meta.badges ||= [];
  schema.meta.badges.push({
    text: "deprecated",
    type: "danger"
  });
  return schema;
};
Schema.prototype.experimental = function experimental() {
  const schema = Schema(this);
  schema.meta.badges ||= [];
  schema.meta.badges.push({
    text: "experimental",
    type: "warning"
  });
  return schema;
};
Schema.prototype.pattern = function pattern(regexp) {
  const schema = Schema(this);
  const pattern2 = pick(regexp, ["source", "flags"]);
  schema.meta = {
    ...schema.meta,
    pattern: pattern2
  };
  return schema;
};
Schema.prototype.simplify = function simplify(value) {
  if (isVolatile(value)) value = value.get();
  if (deepEqual(value, this.meta.default, this.type === "dict")) return null;
  if (isNullable(value)) return value;
  if (this.type === "object" || this.type === "dict") {
    const result = {};
    for (const key in value) {
      const item = (this.type === "object" ? this.dict[key] : this.inner)?.simplify(value[key]);
      if (this.type === "dict" || !isNullable(item)) result[key] = item;
    }
    if (deepEqual(result, this.meta.default, this.type === "dict")) return null;
    return result;
  } else if (this.type === "array" || this.type === "tuple") {
    const result = [];
    value.forEach((value2, index) => {
      const schema = this.type === "array" ? this.inner : this.list[index];
      const item = schema ? schema.simplify(value2) : value2;
      result.push(item);
    });
    return result;
  } else if (this.type === "intersect") {
    const result = {};
    for (const item of this.list) Object.assign(result, item.simplify(value));
    return result;
  } else if (this.type === "union") for (const schema of this.list) try {
    Schema.resolve(value, schema, {});
    return schema.simplify(value);
  } catch {
  }
  return value;
};
Schema.prototype.toString = function toString(inline) {
  return formatters[this.type]?.(this, inline) ?? `Schema<${this.type}>`;
};
Schema.prototype.role = function role(role, extra2) {
  const schema = Schema(this);
  schema.meta = {
    ...schema.meta,
    role,
    extra: extra2
  };
  return schema;
};
for (const key of [
  "default",
  "link",
  "comment",
  "description",
  "max",
  "min",
  "step"
]) Object.assign(Schema.prototype, { [key](value) {
  const schema = Schema(this);
  schema.meta = {
    ...schema.meta,
    [key]: value
  };
  return schema;
} });
Schema.prototype.volatile = function volatile() {
  if (this.meta.volatile) throw new TypeError("volatile schema is already wrapped");
  return this.extra("volatile", true);
};
var resolvers = {};
var checkedVolatile = Symbol("checked-volatile-schema");
function validateVolatileSchema(schema, path = [], blocked = false, seen = /* @__PURE__ */ new Map()) {
  const states = seen.get(schema) ?? /* @__PURE__ */ new Set();
  if (states.has(blocked)) return;
  states.add(blocked);
  seen.set(schema, states);
  if (schema.meta?.volatile && blocked) throw new ValidationError("volatile fields require a fixed object path without an enclosing volatile field", { path });
  const nested = blocked || !!schema.meta?.volatile;
  if (schema.dict) for (const [key, child] of Object.entries(schema.dict)) validateVolatileSchema(child, [...path, key], nested, seen);
  if (schema.sKey) validateVolatileSchema(schema.sKey, [...path, "<key>"], true, seen);
  if (schema.inner && (schema.type !== "lazy" || schema.inner[kSchema])) validateVolatileSchema(schema.inner, [...path, "*"], true, seen);
  if (schema.list) for (let index = 0; index < schema.list.length; index++) validateVolatileSchema(schema.list[index], [...path, String(index)], true, seen);
}
Schema.extend = function extend(type, resolve2) {
  resolvers[type] = resolve2;
};
Schema.resolve = function resolve(data, schema, options = {}, strict = false) {
  if (!schema) return [data];
  if (!options[checkedVolatile]) {
    validateVolatileSchema(schema, options.path);
    options = {
      ...options,
      [checkedVolatile]: true
    };
  }
  if (schema.meta?.volatile) {
    const inner = Schema(schema);
    inner.meta = {
      ...schema.meta,
      volatile: false
    };
    const [value, adapted] = Schema.resolve(data, inner, options, strict);
    try {
      return [createVolatile(value), adapted];
    } catch (error) {
      throw new ValidationError(error instanceof Error ? error.message : String(error), options);
    }
  }
  if (options.ignore?.(data, schema)) return [data];
  if (isNullable(data) && schema.type !== "lazy") {
    if (schema.meta.required) throw new ValidationError(`missing required value`, options);
    let current = schema;
    let fallback = schema.meta.default;
    while (current?.type === "intersect" && isNullable(fallback)) {
      current = current.list[0];
      fallback = current?.meta.default;
    }
    if (isNullable(fallback)) return [data];
    data = clone(fallback);
  }
  const callback = resolvers[schema.type];
  if (!callback) throw new ValidationError(`unsupported type "${schema.type}"`, options);
  try {
    return callback(data, schema, options, strict);
  } catch (error) {
    if (!schema.meta.loose) throw error;
    return [schema.meta.default];
  }
};
Schema.from = function from(source) {
  if (isNullable(source)) return Schema.any();
  else if ([
    "string",
    "number",
    "boolean"
  ].includes(typeof source)) return Schema.const(source).required();
  else if (source[kSchema]) return source;
  else if (typeof source === "function") switch (source) {
    case String:
      return Schema.string().required();
    case Number:
      return Schema.number().required();
    case Boolean:
      return Schema.boolean().required();
    case Function:
      return Schema.function().required();
    default:
      return Schema.is(source).required();
  }
  else throw new TypeError(`cannot infer schema from ${source}`);
};
Schema.lazy = function lazy(builder) {
  const toJSON2 = () => {
    if (!schema.inner[kSchema]) {
      schema.inner = schema.builder();
      schema.inner.meta = {
        ...schema.meta,
        ...schema.inner.meta
      };
    }
    return schema.inner.toJSON();
  };
  const schema = new Schema({
    type: "lazy",
    builder,
    inner: { toJSON: toJSON2 }
  });
  return schema;
};
Schema.natural = function natural() {
  return Schema.number().step(1).min(0);
};
Schema.percent = function percent() {
  return Schema.number().step(0.01).min(0).max(1).role("slider");
};
Schema.date = function date() {
  return Schema.union([Schema.is(Date), Schema.transform(Schema.string().role("datetime"), (value, options) => {
    const date2 = new Date(value);
    if (isNaN(+date2)) throw new ValidationError(`invalid date "${value}"`, options);
    return date2;
  }, true)]);
};
Schema.regExp = function regExp(flag = "") {
  return Schema.union([Schema.is(RegExp), Schema.transform(Schema.string().role("regexp", { flag }), (value, options) => {
    try {
      return new RegExp(value, flag);
    } catch (e2) {
      throw new ValidationError(e2.message, options);
    }
  }, true)]);
};
Schema.arrayBuffer = function arrayBuffer(encoding) {
  return Schema.union([
    Schema.is(ArrayBuffer),
    Schema.is(SharedArrayBuffer),
    Schema.transform(Schema.any(), (value, options) => {
      if (Binary.isSource(value)) return Binary.fromSource(value);
      throw new ValidationError(`expected ArrayBufferSource but got ${value}`, options);
    }, true),
    ...encoding ? [Schema.transform(Schema.string(), (value, options) => {
      try {
        return encoding === "base64" ? Binary.fromBase64(value) : Binary.fromHex(value);
      } catch (e2) {
        throw new ValidationError(e2.message, options);
      }
    }, true)] : []
  ]);
};
Schema.extend("lazy", (data, schema, options, strict) => {
  if (!schema.inner[kSchema]) {
    schema.inner = schema.builder();
    schema.inner.meta = {
      ...schema.meta,
      ...schema.inner.meta
    };
    validateVolatileSchema(schema.inner, options.path, true);
  }
  return Schema.resolve(data, schema.inner, options, strict);
});
Schema.extend("any", (data) => {
  return [data];
});
Schema.extend("never", (data, _2, options) => {
  throw new ValidationError(`expected nullable but got ${data}`, options);
});
Schema.extend("const", (data, { value }, options) => {
  if (deepEqual(data, value)) return [value];
  throw new ValidationError(`expected ${value} but got ${data}`, options);
});
function checkWithinRange(data, meta, description, options, skipMin = false) {
  const { max = Infinity, min = -Infinity } = meta;
  if (data > max) throw new ValidationError(`expected ${description} <= ${max} but got ${data}`, options);
  if (data < min && !skipMin) throw new ValidationError(`expected ${description} >= ${min} but got ${data}`, options);
}
Schema.extend("string", (data, { meta }, options) => {
  if (typeof data !== "string") throw new ValidationError(`expected string but got ${data}`, options);
  if (meta.pattern) {
    const regexp = new RegExp(meta.pattern.source, meta.pattern.flags);
    if (!regexp.test(data)) throw new ValidationError(`expect string to match regexp ${regexp}`, options);
  }
  checkWithinRange(data.length, meta, "string length", options);
  return [data];
});
function decimalShift(data, digits) {
  const str = data.toString();
  if (str.includes("e")) return data * Math.pow(10, digits);
  const index = str.indexOf(".");
  if (index === -1) return data * Math.pow(10, digits);
  const frac = str.slice(index + 1);
  const integer = str.slice(0, index);
  if (frac.length <= digits) return +(integer + frac.padEnd(digits, "0"));
  return +(integer + frac.slice(0, digits) + "." + frac.slice(digits));
}
function isMultipleOf(data, min, step) {
  step = Math.abs(step);
  if (!/^\d+\.\d+$/.test(step.toString())) return (data - min) % step === 0;
  const index = step.toString().indexOf(".");
  const digits = step.toString().slice(index + 1).length;
  return Math.abs(decimalShift(data, digits) - decimalShift(min, digits)) % decimalShift(step, digits) === 0;
}
Schema.extend("number", (data, { meta }, options) => {
  if (typeof data !== "number") throw new ValidationError(`expected number but got ${data}`, options);
  checkWithinRange(data, meta, "number", options);
  const { step } = meta;
  if (step && !isMultipleOf(data, meta.min ?? 0, step)) throw new ValidationError(`expected number multiple of ${step} but got ${data}`, options);
  return [data];
});
Schema.extend("boolean", (data, _2, options) => {
  if (typeof data === "boolean") return [data];
  throw new ValidationError(`expected boolean but got ${data}`, options);
});
Schema.extend("bitset", (data, { bits, meta }, options) => {
  let value = 0, keys = [];
  if (typeof data === "number") {
    value = data;
    for (const key in bits) if (data & bits[key]) keys.push(key);
  } else if (Array.isArray(data)) {
    keys = data;
    for (const key of keys) {
      if (typeof key !== "string") throw new ValidationError(`expected string but got ${key}`, options);
      if (key in bits) value |= bits[key];
    }
  } else throw new ValidationError(`expected number or array but got ${data}`, options);
  if (value === meta.default) return [value];
  return [value, keys];
});
Schema.extend("function", (data, _2, options) => {
  if (typeof data === "function") return [data];
  throw new ValidationError(`expected function but got ${data}`, options);
});
Schema.extend("is", (data, { constructor }, options) => {
  if (typeof constructor === "function") {
    if (data instanceof constructor) return [data];
    throw new ValidationError(`expected ${constructor.name} but got ${data}`, options);
  } else {
    if (isNullable(data)) throw new ValidationError(`expected ${constructor} but got ${data}`, options);
    let prototype = Object.getPrototypeOf(data);
    while (prototype) {
      if (prototype.constructor?.name === constructor) return [data];
      prototype = Object.getPrototypeOf(prototype);
    }
    throw new ValidationError(`expected ${constructor} but got ${data}`, options);
  }
});
function property(data, key, schema, options) {
  try {
    const [value, adapted] = Schema.resolve(data[key], schema, {
      ...options,
      path: [...options.path || [], key]
    });
    if (adapted !== void 0) data[key] = adapted;
    return value;
  } catch (e2) {
    if (!options?.autofix) throw e2;
    delete data[key];
    return schema.meta.volatile ? createVolatile(schema.meta.default) : schema.meta.default;
  }
}
Schema.extend("array", (data, { inner, meta }, options) => {
  if (!Array.isArray(data)) throw new ValidationError(`expected array but got ${data}`, options);
  checkWithinRange(data.length, meta, "array length", options, !isNullable(inner.meta.default));
  return [data.map((_2, index) => property(data, index, inner, options))];
});
Schema.extend("dict", (data, { inner, sKey }, options, strict) => {
  if (!isPlainObject(data)) throw new ValidationError(`expected object but got ${data}`, options);
  const result = {};
  for (const key in data) {
    let rKey;
    try {
      rKey = Schema.resolve(key, sKey, options)[0];
    } catch (error) {
      if (strict) continue;
      throw error;
    }
    result[rKey] = property(data, key, inner, options);
    data[rKey] = data[key];
    if (key !== rKey) delete data[key];
  }
  return [result];
});
Schema.extend("tuple", (data, { list }, options, strict) => {
  if (!Array.isArray(data)) throw new ValidationError(`expected array but got ${data}`, options);
  const result = list.map((inner, index) => property(data, index, inner, options));
  if (strict) return [result];
  result.push(...data.slice(list.length));
  return [result];
});
function merge(result, data) {
  for (const key in data) {
    if (key in result) continue;
    result[key] = data[key];
  }
}
Schema.extend("object", (data, { dict }, options, strict) => {
  if (!isPlainObject(data)) throw new ValidationError(`expected object but got ${data}`, options);
  const result = {};
  for (const key in dict) {
    const value = property(data, key, dict[key], options);
    if (!isNullable(value) || key in data) result[key] = value;
  }
  if (!strict) merge(result, data);
  return [result];
});
Schema.extend("union", (data, { list, toString: toString2 }, options, strict) => {
  const messages = [];
  for (const inner of list) try {
    return Schema.resolve(data, inner, options, strict);
  } catch (error) {
    messages.push(error);
  }
  throw new ValidationError(`expected ${toString2()} but got ${JSON.stringify(data)}`, options);
});
Schema.extend("intersect", (data, { list, toString: toString2 }, options, strict) => {
  if (!list.length) return [data];
  let result;
  for (const inner of list) {
    const value = Schema.resolve(data, inner, options, true)[0];
    if (isNullable(value)) continue;
    if (isNullable(result)) result = value;
    else if (typeof result !== typeof value) throw new ValidationError(`expected ${toString2()} but got ${JSON.stringify(data)}`, options);
    else if (typeof value === "object") merge(result ??= {}, value);
    else if (result !== value) throw new ValidationError(`expected ${toString2()} but got ${JSON.stringify(data)}`, options);
  }
  if (!strict && isPlainObject(data)) merge(result, data);
  return [result];
});
Schema.extend("transform", (data, { inner, callback, preserve }, options) => {
  const [result, adapted = data] = Schema.resolve(data, inner, options, true);
  if (preserve) return [callback(result)];
  else return [callback(result), callback(adapted)];
});
var formatters = {};
function defineMethod(name, keys, format) {
  formatters[name] = format;
  Object.assign(Schema, { [name](...args) {
    const schema = new Schema({ type: name });
    keys.forEach((key, index) => {
      switch (key) {
        case "sKey":
          schema.sKey = args[index] ?? Schema.string();
          break;
        case "inner":
          schema.inner = Schema.from(args[index]);
          break;
        case "list":
          schema.list = args[index].map(Schema.from);
          break;
        case "dict":
          schema.dict = mapValues(args[index], Schema.from);
          break;
        case "bits":
          schema.bits = {};
          for (const key2 in args[index]) {
            if (typeof args[index][key2] !== "number") continue;
            schema.bits[key2] = args[index][key2];
          }
          break;
        case "callback": {
          const callback = schema.callback = args[index];
          callback["toJSON"] ||= () => callback.toString();
          break;
        }
        case "constructor": {
          const constructor = schema.constructor = args[index];
          if (typeof constructor === "function") constructor["toJSON"] ||= () => constructor["name"];
          break;
        }
        default:
          schema[key] = args[index];
      }
    });
    if (name === "object" || name === "dict") schema.meta.default = {};
    else if (name === "array" || name === "tuple") schema.meta.default = [];
    else if (name === "bitset") schema.meta.default = 0;
    return schema;
  } });
}
defineMethod("is", ["constructor"], ({ constructor }) => {
  if (typeof constructor === "function") return constructor.name;
  else return constructor;
});
defineMethod("any", [], () => "any");
defineMethod("never", [], () => "never");
defineMethod("const", ["value"], ({ value }) => typeof value === "string" ? JSON.stringify(value) : value);
defineMethod("string", [], () => "string");
defineMethod("number", [], () => "number");
defineMethod("boolean", [], () => "boolean");
defineMethod("bitset", ["bits"], () => "bitset");
defineMethod("function", [], () => "function");
defineMethod("array", ["inner"], ({ inner }) => `${inner.toString(true)}[]`);
defineMethod("dict", ["inner", "sKey"], ({ inner, sKey }) => `{ [key: ${sKey.toString()}]: ${inner.toString()} }`);
defineMethod("tuple", ["list"], ({ list }) => `[${list.map((inner) => inner.toString()).join(", ")}]`);
defineMethod("object", ["dict"], ({ dict }) => {
  if (Object.keys(dict).length === 0) return "{}";
  return `{ ${Object.entries(dict).map(([key, inner]) => {
    return `${key}${inner.meta.required ? "" : "?"}: ${inner.toString()}`;
  }).join(", ")} }`;
});
defineMethod("union", ["list"], ({ list }, inline) => {
  const result = list.map(({ toString: format }) => format()).join(" | ");
  return inline ? `(${result})` : result;
});
defineMethod("intersect", ["list"], ({ list }) => {
  return `${list.map((inner) => inner.toString(true)).join(" & ")}`;
});
defineMethod("transform", [
  "inner",
  "callback",
  "preserve"
], ({ inner }, isInner) => inner.toString(isInner));
var SIMPLE_ESCAPES = {
  '"': '"',
  "\\": "\\",
  "/": "/",
  b: "\b",
  f: "\f",
  n: "\n",
  r: "\r",
  t: "	"
};
var CONTENT_ESCAPE = /[\\\u0000-\u001f]/u;
function isWhitespace(c2) {
  return c2 === " " || c2 === "\n" || c2 === "\r" || c2 === "	";
}
function isHex(c2) {
  return c2 >= "0" && c2 <= "9" || c2 >= "a" && c2 <= "f" || c2 >= "A" && c2 <= "F";
}
(class PartialArguments {
  /** The view of a call with no arguments available. */
  static EMPTY = PartialArguments.fromObject({});
  /**
  * View finished argument text without scanning it until a reader asks.
  * @param text - the complete argument JSON text.
  * @returns a sealed view.
  */
  static fromText(text) {
    const view = new PartialArguments();
    view.append(text);
    view.sealed = true;
    return view;
  }
  /**
  * View an already parsed argument payload, such as a PTC dispatch object.
  * @param value - the parsed argument value.
  * @returns a sealed view; a non-object payload has no fields.
  */
  static fromObject(value) {
    const view = new PartialArguments();
    view.object = typeof value === "object" && value !== null && !Array.isArray(value) ? value : {};
    view.sealed = true;
    return view;
  }
  /**
  * The source: text so far or a parsed object, plus whether it can still grow.
  * These are the only enumerable fields, so two views over the same source
  * compare equal structurally however far each has been read.
  */
  chunks = [];
  object;
  sealed = false;
  #ends = [];
  #size = 0;
  #consumed = 0;
  #mode = "root";
  #escape = false;
  #keyStart = 0;
  #keyEscaped = false;
  #key = "";
  #current = null;
  #nestedEnds = [];
  #nestedInString = false;
  #invalidAt;
  #invalidValue = false;
  #entries = /* @__PURE__ */ new Map();
  #order = [];
  #reads = /* @__PURE__ */ new Map();
  /** Whether this view rejects further appends; does not scan text or register reads. */
  get isSealed() {
    return this.sealed;
  }
  /** Whether indexing or a content read found invalid JSON; unread value contents are not validated. */
  get invalid() {
    this.scan();
    return this.#mode === "invalid" || this.#invalidValue;
  }
  /**
  * Retain streamed argument text without scanning or comparing observed answers.
  * @param fragment - the text following every fragment appended before.
  */
  append(fragment) {
    if (this.sealed) throw new Error("PartialArguments: cannot append to a sealed view");
    if (fragment.length === 0) return;
    this.chunks.push(fragment);
    this.#size += fragment.length;
    this.#ends.push(this.#size);
  }
  /**
  * Reconcile a streamed prefix with authoritative complete text without joining the fragments.
  * @param text - the final argument text, which replaces missing or conflicting deltas.
  * @returns this view sealed with its caches retained when every character matches; otherwise a new sealed view.
  */
  settle(text) {
    if (this.object !== void 0 || text.length !== this.#size) return PartialArguments.fromText(text);
    let offset = 0;
    for (const chunk of this.chunks) {
      if (!text.startsWith(chunk, offset)) return PartialArguments.fromText(text);
      offset += chunk.length;
    }
    this.chunks = text.length === 0 ? [] : [text];
    this.#ends = text.length === 0 ? [] : [text.length];
    this.sealed = true;
    return this;
  }
  /**
  * Compare observed answers and advance their publication baseline. Unread views remain unscanned.
  * @returns whether any observed answer changed since its first read or the preceding refresh.
  */
  refresh() {
    if (this.#reads.size === 0) return false;
    this.scan();
    let changed = false;
    let completions = false;
    for (const read of this.#reads.values()) {
      if (read.completion) {
        completions = true;
        continue;
      }
      changed = this.refreshRead(read) || changed;
    }
    if (completions) {
      for (const read of this.#reads.values()) if (read.completion) changed = this.refreshRead(read) || changed;
    }
    if (this.sealed) this.#reads.clear();
    return changed;
  }
  refreshRead(read) {
    const now = read.answer();
    if (Object.is(now, read.last)) return false;
    read.last = now;
    return true;
  }
  /**
  * Check whether no further fields can arrive.
  * @returns whether the outer object closed, indexing failed, or the view is sealed; unread values are not validated.
  */
  closed() {
    return this.remember("closed", "", () => this.closedNow());
  }
  /**
  * List discovered fields in first-appearance order.
  * @returns top-level keys seen so far, in first-appearance order.
  */
  keys() {
    return this.remember("keys", "", () => this.keysNow(), (keys) => keys.length);
  }
  /**
  * Check whether a top-level field has appeared.
  * @param key - argument name.
  * @returns whether the field has appeared (a string opened or another value began).
  */
  has(key) {
    return this.remember("has", key, () => this.hasNow(key));
  }
  /**
  * Check whether a field's closing delimiter has arrived, without validating its contents.
  * @param key - argument name.
  * @returns whether its delimiter arrived and no content reader has reported an error for this value.
  */
  complete(key) {
    return this.remember("complete", key, () => this.completeNow(key));
  }
  /**
  * Read string length without materializing its text.
  * @param key - argument name.
  * @param options - change granularity for a streaming string.
  * @returns decoded UTF-16 length of the string field so far; undefined when absent or not a string.
  */
  stringLength(key, options) {
    const step = Math.max(1, Math.floor(options?.step ?? 1));
    const offset = options?.offset ?? 0;
    return this.remember(`length:${step}:${offset}`, key, () => this.lengthNow(key), (length) => length === void 0 ? void 0 : Math.ceil((length + offset) / step));
  }
  /**
  * Check a string against a decoded UTF-16 length limit without materializing it.
  * @param key - argument name.
  * @param maxLength - decoded UTF-16 limit, floored to at least zero.
  * @returns whether the string is longer than the limit; false when absent or not a string.
  */
  stringExceeds(key, maxLength) {
    const limit = Math.max(0, Math.floor(maxLength));
    return this.remember(`exceeds:${limit}`, key, () => (this.lengthNow(key, limit + 1) ?? 0) > limit);
  }
  /**
  * Read a decoded string, including a streaming prefix.
  * @param key - argument name.
  * @returns the string field's decoded text so far; undefined when absent or not a string.
  */
  text(key) {
    return this.remember("text", key, () => this.textNow(key));
  }
  /**
  * Read at most the first decoded UTF-16 units of a string.
  * @param key - argument name.
  * @param maxLength - maximum decoded UTF-16 length, floored to at least one.
  * @returns the bounded string prefix; undefined when absent or not a string.
  */
  textPrefix(key, maxLength) {
    const limit = Math.max(1, Math.floor(maxLength));
    return this.remember(`prefix:${limit}`, key, () => this.textPrefixNow(key, limit));
  }
  /**
  * Read a completed non-string argument.
  * @param key - argument name.
  * @returns the parsed non-string value once it closed; undefined while open, absent, or a string.
  */
  value(key) {
    return this.remember("value", key, () => this.valueNow(key));
  }
  /** Answer a question and, on a streaming view, remember it for change detection. */
  remember(kind, key, read, comparison) {
    this.scan();
    const result = read();
    if (!this.sealed) {
      const id = `${kind}/${key}`;
      if (!this.#reads.has(id)) this.#reads.set(id, {
        completion: kind === "complete",
        answer: comparison === void 0 ? read : () => comparison(read()),
        last: comparison === void 0 ? result : comparison(result)
      });
    }
    return result;
  }
  closedNow() {
    return this.sealed || this.#mode === "closed" || this.#mode === "invalid";
  }
  keysNow() {
    return this.object === void 0 ? this.#order : Object.keys(this.object);
  }
  hasNow(key) {
    return this.object === void 0 ? this.#entries.has(key) : Object.hasOwn(this.object, key);
  }
  completeNow(key) {
    if (this.object !== void 0) return Object.hasOwn(this.object, key);
    const entry = this.#entries.get(key);
    return entry !== void 0 && entry.end >= 0 && (entry.kind === "string" ? entry.invalidAt === void 0 : !entry.invalid);
  }
  lengthNow(key, limit = Number.POSITIVE_INFINITY) {
    if (this.object !== void 0) {
      const field = Object.hasOwn(this.object, key) ? this.object[key] : void 0;
      return typeof field === "string" ? field.length : void 0;
    }
    const entry = this.#entries.get(key);
    if (entry?.kind !== "string") return void 0;
    if (entry.text !== void 0 && entry.text.at === entry.end) return entry.text.length;
    const read = entry.length ??= {
      at: entry.start,
      length: 0,
      text: ""
    };
    this.readString(entry, read, limit, false);
    return read.length;
  }
  textNow(key) {
    if (this.object !== void 0) {
      const field = Object.hasOwn(this.object, key) ? this.object[key] : void 0;
      return typeof field === "string" ? field : void 0;
    }
    const entry = this.#entries.get(key);
    if (entry?.kind !== "string") return void 0;
    if (entry.text === void 0 && entry.end >= 0 && entry.needsDecoding && entry.invalidAt === void 0) {
      let text;
      try {
        text = JSON.parse(`"${this.slice(entry.start, entry.end)}"`);
      } catch (_error) {
      }
      if (text !== void 0) entry.text = {
        at: entry.end,
        length: text.length,
        text
      };
    }
    const read = entry.text ??= {
      at: entry.start,
      length: 0,
      text: ""
    };
    this.readString(entry, read, Number.POSITIVE_INFINITY, true);
    return read.text;
  }
  textPrefixNow(key, maxLength) {
    if (this.object !== void 0) {
      const field = Object.hasOwn(this.object, key) ? this.object[key] : void 0;
      return typeof field === "string" ? field.slice(0, maxLength) : void 0;
    }
    const entry = this.#entries.get(key);
    if (entry?.kind !== "string") return void 0;
    const prefixes = entry.prefixes ??= /* @__PURE__ */ new Map();
    let read = prefixes.get(maxLength);
    if (read === void 0) {
      read = {
        at: entry.start,
        length: 0,
        text: ""
      };
      prefixes.set(maxLength, read);
    }
    this.readString(entry, read, maxLength, true);
    return read.text;
  }
  valueNow(key) {
    if (this.object !== void 0) {
      if (!Object.hasOwn(this.object, key)) return void 0;
      const field = this.object[key];
      return typeof field === "string" ? void 0 : field;
    }
    const entry = this.#entries.get(key);
    if (entry?.kind !== "value" || entry.end < 0 || entry.invalid) return void 0;
    if (entry.parsed === void 0) try {
      entry.parsed = JSON.parse(this.slice(entry.start, entry.end));
    } catch (_error) {
      entry.invalid = true;
      this.#invalidValue = true;
    }
    return entry.parsed;
  }
  chunkAt(at2) {
    let low = 0;
    let high = this.#ends.length;
    while (low < high) {
      const mid = low + high >>> 1;
      if (this.#ends[mid] <= at2) low = mid + 1;
      else high = mid;
    }
    return low;
  }
  /** Materialize only a requested range, never the cumulative source. */
  slice(start, end) {
    if (start >= end) return "";
    const first = this.chunkAt(start);
    const last = this.chunkAt(end - 1);
    const base = first === 0 ? 0 : this.#ends[first - 1];
    if (first === last) return this.chunks[first].slice(start - base, end - base);
    const parts = [this.chunks[first].slice(start - base)];
    for (let i2 = first + 1; i2 < last; i2++) parts.push(this.chunks[i2]);
    parts.push(this.chunks[last].slice(0, end - this.#ends[last - 1]));
    return parts.join("");
  }
  readString(entry, read, limit, materialize) {
    const end = Math.min(entry.end < 0 ? this.#consumed : entry.end, entry.invalidAt ?? Number.POSITIVE_INFINITY, this.#invalidAt ?? Number.POSITIVE_INFINITY);
    if (!entry.needsDecoding) {
      const length = Math.min(end - read.at, limit - read.length);
      if (length <= 0) return;
      if (materialize) read.text += this.slice(read.at, read.at + length);
      read.at += length;
      read.length += length;
      return;
    }
    let chunkIndex = this.chunkAt(read.at);
    while (read.at < end && read.length < limit) {
      const base = chunkIndex === 0 ? 0 : this.#ends[chunkIndex - 1];
      const chunk = this.chunks[chunkIndex];
      const remaining = chunk.slice(read.at - base, Math.min(chunk.length, end - base));
      const boundary = remaining.search(CONTENT_ESCAPE);
      const length = Math.min(boundary < 0 ? remaining.length : boundary, limit - read.length);
      if (length > 0) {
        if (materialize) read.text += remaining.slice(0, length);
        read.at += length;
        read.length += length;
        if (read.at === base + chunk.length) chunkIndex++;
        continue;
      }
      const type = remaining.length > 1 ? remaining[1] : read.at + 1 < end ? this.chunks[chunkIndex + 1][0] : void 0;
      let decoded;
      let width = 2;
      if (remaining[0] === "\\" && type === void 0 && entry.end < 0) return;
      if (remaining[0] === "\\" && type === "u") {
        const hex = this.slice(read.at + 2, Math.min(end, read.at + 6));
        let valid = true;
        for (let i2 = 0; i2 < hex.length; i2++) if (!isHex(hex[i2])) valid = false;
        if (valid) {
          if (hex.length < 4 && entry.end < 0) return;
          if (hex.length === 4) decoded = String.fromCharCode(Number.parseInt(hex, 16));
        }
        width = 6;
      } else if (remaining[0] === "\\" && type !== void 0) decoded = SIMPLE_ESCAPES[type];
      if (decoded === void 0) {
        entry.invalidAt = read.at;
        this.#invalidValue = true;
        return;
      }
      if (materialize) read.text += decoded;
      read.length++;
      read.at += width;
      while (chunkIndex < this.chunks.length && read.at >= this.#ends[chunkIndex]) chunkIndex++;
    }
  }
  /** Locate new field ranges without decoding or parsing their contents. */
  scan() {
    if (this.object !== void 0 || this.#consumed === this.#size) return;
    for (let i2 = this.chunkAt(this.#consumed); i2 < this.chunks.length && this.#invalidAt === void 0; i2++) {
      const pending = this.chunks[i2];
      const base = i2 === 0 ? 0 : this.#ends[i2 - 1];
      for (let index = this.#consumed - base; index < pending.length && this.#mode !== "invalid"; index++) {
        if (this.#mode === "string" || this.#mode === "nested" && this.#nestedInString) {
          const end = this.stringBoundary(pending, index);
          this.#consumed += end - index;
          index = end;
          if (index === pending.length) break;
        }
        this.step(pending[index], this.#consumed);
        this.#consumed++;
      }
    }
  }
  /** Only raw quotes and their preceding backslash runs can terminate a string. */
  stringBoundary(fragment, start) {
    let at2 = start;
    while (true) {
      const quote = fragment.indexOf('"', at2);
      const end = quote < 0 ? fragment.length : quote;
      if (this.#mode === "string") {
        const entry = this.#current;
        if (!entry.needsDecoding && CONTENT_ESCAPE.test(fragment.slice(at2, end))) entry.needsDecoding = true;
      }
      let slashStart = end;
      while (slashStart > at2 && fragment[slashStart - 1] === "\\") slashStart--;
      const escaped = (end - slashStart) % 2 === 1 !== (slashStart === at2 && this.#escape);
      this.#escape = quote < 0 && escaped;
      if (quote < 0 || !escaped) return end;
      at2 = quote + 1;
    }
  }
  step(c2, at2) {
    switch (this.#mode) {
      case "root":
        if (isWhitespace(c2)) return;
        if (c2 === "{") {
          this.#mode = "key-or-end";
          return;
        }
        this.fail();
        return;
      case "key-or-end":
        if (isWhitespace(c2)) return;
        if (c2 === "}") {
          this.#mode = "closed";
          return;
        }
        if (c2 === '"') {
          this.beginKey(at2);
          return;
        }
        this.fail();
        return;
      case "key-only":
        if (isWhitespace(c2)) return;
        if (c2 === '"') {
          this.beginKey(at2);
          return;
        }
        this.fail();
        return;
      case "key":
        this.stepKey(c2, at2);
        return;
      case "colon":
        if (isWhitespace(c2)) return;
        if (c2 === ":") {
          this.#mode = "value";
          return;
        }
        this.fail();
        return;
      case "value":
        this.beginValue(c2, at2);
        return;
      case "string": {
        const entry = this.#current;
        entry.end = at2;
        this.#current = null;
        this.#mode = "comma-or-end";
        return;
      }
      case "scalar":
        this.stepScalar(c2, at2);
        return;
      case "nested":
        this.stepNested(c2, at2);
        return;
      case "comma-or-end":
        if (isWhitespace(c2)) return;
        if (c2 === ",") {
          this.#mode = "key-only";
          return;
        }
        if (c2 === "}") {
          this.#mode = "closed";
          return;
        }
        this.fail();
        return;
      case "closed":
        if (isWhitespace(c2)) return;
        this.fail();
        return;
      /* v8 ignore next 2 -- scan() stops stepping once the view is invalid. */
      case "invalid":
        return;
      /* v8 ignore next 2 -- Every scanner mode has a handler above. */
      default:
        assertNever$1(this.#mode);
    }
  }
  fail() {
    this.#invalidAt = this.#consumed;
    this.#mode = "invalid";
    this.#current = null;
  }
  beginKey(at2) {
    this.#mode = "key";
    this.#keyStart = at2 + 1;
    this.#keyEscaped = false;
    this.#escape = false;
  }
  stepKey(c2, at2) {
    if (c2 < " ") {
      this.fail();
      return;
    }
    if (this.#escape) {
      this.#escape = false;
      return;
    }
    if (c2 === "\\") {
      this.#escape = true;
      this.#keyEscaped = true;
      return;
    }
    if (c2 !== '"') return;
    const raw = this.slice(this.#keyStart, at2);
    if (this.#keyEscaped) try {
      this.#key = JSON.parse(`"${raw}"`);
    } catch (_error) {
      this.fail();
      return;
    }
    else this.#key = raw;
    this.#mode = "colon";
  }
  open(entry) {
    if (!this.#entries.has(this.#key)) this.#order.push(this.#key);
    this.#entries.set(this.#key, entry);
    this.#current = entry;
  }
  beginValue(c2, at2) {
    if (isWhitespace(c2)) return;
    if (c2 === '"') {
      this.open({
        kind: "string",
        start: at2 + 1,
        end: -1,
        needsDecoding: false,
        invalidAt: void 0,
        length: void 0,
        text: void 0,
        prefixes: void 0
      });
      this.#escape = false;
      this.#mode = "string";
      return;
    }
    if (c2 === "}" || c2 === "," || c2 === ":" || c2 === "]") {
      this.fail();
      return;
    }
    this.open({
      kind: "value",
      start: at2,
      end: -1,
      parsed: void 0,
      invalid: false
    });
    if (c2 === "{" || c2 === "[") {
      this.#mode = "nested";
      this.#nestedEnds = [c2 === "{" ? "}" : "]"];
      this.#nestedInString = false;
      this.#escape = false;
      return;
    }
    this.#mode = "scalar";
  }
  stepScalar(c2, at2) {
    if (c2 !== "," && c2 !== "}" && !isWhitespace(c2)) return;
    this.closeValue(at2);
    this.#mode = c2 === "," ? "key-only" : c2 === "}" ? "closed" : "comma-or-end";
  }
  stepNested(c2, at2) {
    if (this.#nestedInString) {
      this.#nestedInString = false;
      return;
    }
    if (c2 === '"') {
      this.#nestedInString = true;
      return;
    }
    if (c2 === "{" || c2 === "[") {
      this.#nestedEnds.push(c2 === "{" ? "}" : "]");
      return;
    }
    if (c2 === "}" || c2 === "]") {
      if (this.#nestedEnds.pop() !== c2) {
        this.fail();
        return;
      }
      if (this.#nestedEnds.length === 0) {
        this.closeValue(at2 + 1);
        this.#mode = "comma-or-end";
      }
    }
  }
  closeValue(end) {
    const entry = this.#current;
    entry.end = end;
    this.#current = null;
  }
});
function assertNever$1(value, context) {
  const rendered = JSON.stringify(value) ?? String(value);
  throw new Error(`unreachable variant${context ? ` in ${context}` : ""}: ${rendered}`);
}
var css$9 = ".BNl2La_root{display:contents}.BNl2La_ellipsis{text-overflow:ellipsis;white-space:nowrap;min-width:0;max-width:100%;display:block;overflow:hidden}";
var tagId$9 = "@kode/dsh-composer/cfbd9fd95b05/UserText.module.css";
if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId$9) + "]") === null) {
  const tag = document.createElement("style");
  tag.dataset.plugin = "@kode/dsh-composer";
  tag.dataset.pluginCss = tagId$9;
  tag.textContent = css$9;
  document.head.appendChild(tag);
}
var referenceSchema = zod.z.object({
  source: zod.z.string(),
  ref: zod.z.string(),
  offset: zod.z.number().int().nonnegative(),
  length: zod.z.number().int().positive(),
  label: zod.z.string(),
  appearance: zod.z.enum([
    "session",
    "file",
    "folder"
  ]).optional(),
  clipboardText: zod.z.string(),
  invalid: zod.z.boolean().optional()
});
var commandSchema = zod.z.object({ token: zod.z.string() });
var snapshotSchema = zod.z.object({
  text: zod.z.string(),
  references: zod.z.array(referenceSchema),
  command: commandSchema.optional()
}).refine((draft) => {
  const spelling = draft.command?.token.trimEnd();
  if (spelling !== void 0 && (!/^\/\S/u.test(spelling) || !draft.text.startsWith(spelling))) return false;
  let end = spelling?.length ?? 0;
  for (const reference of draft.references) {
    if (reference.offset < end || reference.length !== reference.clipboardText.length) return false;
    end = reference.offset + reference.length;
    if (end > draft.text.length || draft.text.slice(reference.offset, end) !== reference.clipboardText) return false;
  }
  return true;
}, "Draft references must identify ordered, non-overlapping text spans after the leading command token");
function isImageMediaType(value) {
  return value === "image/png" || value === "image/jpeg" || value === "image/webp" || value === "image/gif";
}
function t(t2, ...e2) {
  const n2 = new URL("https://lexical.dev/docs/error"), o2 = new URLSearchParams();
  o2.append("code", t2);
  for (const t3 of e2) o2.append("v", t3);
  throw n2.search = o2.toString(), Error(`Minified Lexical error #${t2}; visit ${n2.toString()} for the full message or use the non-minified dev environment for full errors and additional helpful warnings.`);
}
function e(t2, ...e2) {
  const n2 = new URL("https://lexical.dev/docs/error"), o2 = new URLSearchParams();
  o2.append("code", t2);
  for (const t3 of e2) o2.append("v", t3);
  n2.search = o2.toString(), console.warn(`Minified Lexical warning #${t2}; visit ${n2.toString()} for the full message or use the non-minified dev environment for full errors and additional helpful warnings.`);
}
var n = "undefined" != typeof window && void 0 !== window.document && void 0 !== window.document.createElement;
var o = n && "documentMode" in document ? document.documentMode : null;
var r$1 = n && /Mac|iPod|iPhone|iPad/.test(navigator.platform);
var i = n && /^(?!.*Seamonkey)(?=.*Firefox).*/i.test(navigator.userAgent);
var s = !(!n || !("InputEvent" in window) || o) && "getTargetRanges" in new window.InputEvent("input");
var l = n && /iPad|iPhone|iPod/.test(navigator.userAgent) && !window.MSStream;
var c = n && /Android/.test(navigator.userAgent);
var a = n && /Version\/[\d.]+.*Safari/.test(navigator.userAgent) && !c;
var u = n && /^(?=.*Chrome).*/i.test(navigator.userAgent);
var f = n && c && u;
var d$1 = n && /AppleWebKit\/[\d.]+/.test(navigator.userAgent) && r$1 && !u;
var h = 0;
var g = 1;
var _ = 2;
var b = 1;
var N = 2;
var E$1 = 3;
var w = 4;
var O$3 = 5;
var M$2 = 6;
var A = a || l || d$1 ? "\xA0" : "\u200B";
var D$1 = "\n\n";
var F = i ? "\xA0" : A;
var z$1 = {
  bold: 1,
  capitalize: 1024,
  code: 16,
  highlight: 128,
  italic: 2,
  lowercase: 256,
  strikethrough: 4,
  subscript: 32,
  superscript: 64,
  underline: 8,
  uppercase: 512
};
var B = {
  directionless: 1,
  unmergeable: 2
};
var R$1 = {
  center: 2,
  end: 6,
  justify: 4,
  left: 1,
  right: 3,
  start: 5
};
var W = {
  [N]: "center",
  [M$2]: "end",
  [w]: "justify",
  [b]: "left",
  [E$1]: "right",
  [O$3]: "start"
};
var $ = {
  normal: 0,
  segmented: 2,
  token: 1
};
var U = {
  [h]: "normal",
  [_]: "segmented",
  [g]: "token"
};
var j = "$config";
function J() {
  return vc()._blockCursorElement;
}
function V(t2) {
  return null !== t2 && 1 === t2.nodeType && t2.hasAttribute("data-lexical-slot");
}
var q = class q2 {
  element;
  before;
  after;
  constructor(t2, e2, n2) {
    this.element = t2, this.before = e2 || null, this.after = n2 || null;
  }
  withBefore(t2) {
    return new q2(this.element, t2, this.after);
  }
  withAfter(t2) {
    return new q2(this.element, this.before, t2);
  }
  withElement(t2) {
    return this.element === t2 ? this : new q2(t2, this.before, this.after);
  }
  insertChild(e2) {
    const n2 = this.getInsertionAnchor();
    return null !== n2 && n2.parentElement !== this.element && t(357), this.element.insertBefore(e2, n2), this;
  }
  removeChild(e2) {
    return e2.parentElement !== this.element && t(358), this.element.removeChild(e2), this;
  }
  replaceChild(e2, n2) {
    return n2.parentElement !== this.element && t(359), this.element.replaceChild(e2, n2), this;
  }
  getFirstChild() {
    const t2 = this.getFirstChildAnchor(), e2 = t2 ? t2.nextSibling : this.element.firstChild;
    return e2 === this.getInsertionAnchor() ? null : e2;
  }
  getFirstChildAnchor() {
    return this.after;
  }
  resolveLeafPosition(t2, e2, n2) {
    if (this.element === t2) return e2 === t2 && 0 === n2 ? "before" : "after";
    const o2 = Y(t2, this.element);
    if (null === o2) return "after";
    const r2 = Array.prototype.indexOf.call(t2.childNodes, o2);
    if (r2 < 0) return "after";
    if (e2 === t2) return n2 <= r2 ? "before" : "after";
    const i2 = Y(t2, e2);
    if (null === i2) return "after";
    const s2 = Array.prototype.indexOf.call(t2.childNodes, i2);
    return s2 >= 0 && s2 <= r2 ? "before" : "after";
  }
  getInsertionAnchor() {
    return this.before;
  }
};
function Y(t2, e2) {
  let n2 = e2;
  for (; null !== n2 && n2.parentNode !== t2; ) n2 = n2.parentNode;
  return n2;
}
var G = class G2 extends q {
  withBefore(t2) {
    return new G2(this.element, t2, this.after);
  }
  withAfter(t2) {
    return new G2(this.element, this.before, t2);
  }
  withElement(t2) {
    return this.element === t2 ? this : new G2(t2, this.before, this.after);
  }
  getInsertionAnchor() {
    return super.getInsertionAnchor() || this.getManagedLineBreak();
  }
  getFirstChildAnchor() {
    let t2 = super.getFirstChildAnchor(), e2 = t2 ? t2.nextSibling : this.element.firstChild;
    for (; V(e2); ) t2 = e2, e2 = e2.nextSibling;
    const n2 = t2 ? t2.nextSibling : this.element.firstChild;
    return null !== n2 && n2 === J() ? n2 : t2;
  }
  getManagedLineBreak() {
    return this.element.__lexicalLineBreak || null;
  }
  setManagedLineBreak(t2) {
    if (this.element.__lexicalLastChildKind = t2, null === t2) this.removeManagedLineBreak();
    else {
      const e2 = "decorator" === t2 && (d$1 || l || a);
      this.insertManagedLineBreak(e2);
    }
  }
  removeManagedLineBreak() {
    const t2 = this.getManagedLineBreak();
    if (t2) {
      const e2 = this.element, n2 = "IMG" === t2.nodeName ? t2.nextSibling : null;
      n2 && e2.removeChild(n2), e2.removeChild(t2), e2.__lexicalLineBreak = void 0;
    }
  }
  insertManagedLineBreak(t2) {
    const e2 = this.getManagedLineBreak();
    if (e2) {
      if (t2 === ("IMG" === e2.nodeName)) return;
      this.removeManagedLineBreak();
    }
    const n2 = this.element, o2 = this.before, r2 = Zl().createElement("br");
    if (r2.setAttribute("data-lexical-managed-linebreak", "true"), n2.insertBefore(r2, o2), t2) {
      const t3 = Zl().createElement("img");
      t3.setAttribute("data-lexical-managed-linebreak", "true"), t3.style.setProperty("display", "inline", "important"), t3.style.setProperty("border", "0px", "important"), t3.style.setProperty("margin", "0px", "important"), t3.alt = "", n2.insertBefore(t3, r2), n2.__lexicalLineBreak = t3;
    } else n2.__lexicalLineBreak = r2;
  }
  getFirstChildOffset() {
    const t2 = this.getFirstChild(), e2 = this.getInsertionAnchor();
    let n2 = 0;
    for (let o2 = this.element.firstChild; null !== o2 && o2 !== t2 && o2 !== e2; o2 = o2.nextSibling) n2++;
    return n2;
  }
  resolveChildIndex(t2, e2, n2, o2) {
    if (n2 === this.element) {
      const e3 = this.getFirstChildOffset(), n3 = J(), r3 = this.element.childNodes, i3 = Math.min(o2, r3.length);
      let s3 = 0;
      for (let t3 = e3; t3 < i3; t3++) r3[t3] !== n3 && s3++;
      return [t2, Math.min(s3, t2.getChildrenSize())];
    }
    const r2 = X(e2, n2);
    r2.push(o2);
    const i2 = X(e2, this.element);
    let s2 = t2.getIndexWithinParent();
    for (let t3 = 0; t3 < i2.length; t3++) {
      const e3 = r2[t3], n3 = i2[t3];
      if (void 0 === e3 || e3 < n3) break;
      if (e3 > n3) {
        s2 += 1;
        break;
      }
    }
    return [t2.getParentOrThrow(), s2];
  }
};
function X(e2, n2) {
  const o2 = [];
  let r2 = n2;
  for (; r2 !== e2 && null !== r2; r2 = r2.parentNode) {
    let t2 = 0;
    for (let e3 = r2.previousSibling; null !== e3; e3 = e3.previousSibling) t2++;
    o2.push(t2);
  }
  return r2 !== e2 && t(225), o2.reverse();
}
var Q;
try {
  Q = "0.49.0+prod.esm";
} catch (t2) {
}
var Z$1 = Q ?? '"<unknown>+source"';
var tt = class {
  _front = /* @__PURE__ */ new Set();
  _back = /* @__PURE__ */ new Set();
  _cache;
  get size() {
    return this._front.size + this._back.size;
  }
  addBack(t2) {
    return delete this._cache, this._front.has(t2) || this._back.add(t2), this;
  }
  addFront(t2) {
    return delete this._cache, this._back.has(t2) || this._front.add(t2), this;
  }
  delete(t2) {
    return delete this._cache, this._front.delete(t2) || this._back.delete(t2);
  }
  toArray() {
    const t2 = Array.from(this._front).reverse();
    for (const e2 of this._back) t2.push(e2);
    return t2;
  }
  toReadonlyArray() {
    return this._cache = this._cache || this.toArray(), this._cache;
  }
  [Symbol.iterator]() {
    return this.toReadonlyArray()[Symbol.iterator]();
  }
};
var et$1 = null;
function nt$2(t2, e2 = 1e3) {
  return t2 instanceof ot$1 ? t2.clone() : t2.size < e2 ? new Map(t2) : new ot$1().init(new Map(t2), void 0, t2.size);
}
var ot$1 = class ot$12 {
  _mutable = false;
  _old = void 0;
  _nursery = void 0;
  _size = 0;
  clone() {
    return this._mutable = false, new ot$12().init(this._old, this._nursery, this._size);
  }
  init(t2, e2, n2) {
    return this._old = t2, this._nursery = e2, this._size = n2, this;
  }
  get size() {
    return this._size;
  }
  has(t2) {
    return void 0 !== this.get(t2);
  }
  getWithTombstone(t2) {
    const e2 = this._nursery && this._nursery.get(t2);
    return void 0 !== e2 ? e2 : this._old && this._old.get(t2);
  }
  get(t2) {
    const e2 = this.getWithTombstone(t2);
    return e2 === et$1 ? void 0 : e2;
  }
  shouldCompact() {
    return void 0 !== this._nursery && 2 * this._nursery.size > this._size;
  }
  getNursery() {
    return this._mutable && this._nursery || (this.compact(), this._nursery = new Map(this._nursery), this._mutable = true), this._nursery;
  }
  compact(t2 = false) {
    if (this._nursery && this._nursery.size > 0 && (t2 || this.shouldCompact())) {
      const t3 = new Map(this._old);
      for (const [e2, n2] of this._nursery) n2 !== et$1 ? t3.set(e2, n2) : t3.delete(e2);
      this._old = t3, this._nursery = void 0;
    }
    return this._mutable = false, this;
  }
  set(t2, e2) {
    const n2 = this.getWithTombstone(t2);
    if (n2 === e2) return this;
    const o2 = this.getNursery();
    return n2 !== et$1 && void 0 !== n2 || (this._size++, n2 === et$1 && o2.delete(t2)), o2.set(t2, e2), this;
  }
  delete(t2) {
    const e2 = this.has(t2);
    return e2 && (this.getNursery().set(t2, et$1), this._size--), e2;
  }
  getOrInsert(t2, e2) {
    const n2 = this.get(t2);
    return void 0 !== n2 ? n2 : (this.set(t2, e2), e2);
  }
  getOrInsertComputed(t2, e2) {
    const n2 = this.get(t2);
    if (void 0 !== n2) return n2;
    const o2 = e2(t2);
    return this.set(t2, o2), o2;
  }
  clear() {
    this._mutable = false, this._old = void 0, this._nursery = void 0, this._size = 0;
  }
  *keys() {
    for (const t2 of this.entries()) yield t2[0];
  }
  *values() {
    for (const t2 of this.entries()) yield t2[1];
  }
  *entries() {
    const t2 = this._nursery, e2 = this._old;
    if (e2) for (const n2 of e2) {
      const e3 = n2[0], o2 = t2 ? t2.get(e3) : void 0;
      o2 !== et$1 && (void 0 !== o2 && (n2[1] = o2), yield n2);
    }
    if (t2) for (const n2 of t2) n2[1] === et$1 || e2 && e2.has(n2[0]) || (yield n2);
  }
  forEach(t2, e2) {
    void 0 !== e2 && (t2 = t2.bind(e2));
    for (const [e3, n2] of this.entries()) t2(n2, e3, this);
  }
  get [Symbol.toStringTag]() {
    return "GenMap";
  }
  [Symbol.iterator]() {
    return this.entries();
  }
};
function rt$1(t2, e2, n2, o2, r2, i2) {
  if (Pi(t2)) {
    let s2 = t2.getFirstChild();
    for (; null !== s2; ) {
      const t3 = s2.__key;
      s2.__parent === e2 && ((Pi(s2) || Qc(s2) && null !== s2.__slots) && rt$1(s2, t3, n2, o2, r2, i2), n2.has(t3) || i2.delete(t3), r2.push(t3)), s2 = s2.getNextSibling();
    }
  }
  for (const s2 of Qc(t2) && null !== t2.__slots ? t2.__slots.values() : []) {
    const t3 = o2.get(s2);
    void 0 !== t3 && Zc(t3) && t3.__slotHost === e2 && ((Pi(t3) || Qc(t3) && null !== t3.__slots) && rt$1(t3, s2, n2, o2, r2, i2), n2.has(s2) || i2.delete(s2), r2.push(s2));
  }
}
var it$1 = false;
var st$1 = 0;
function lt$1(t2) {
  st$1 = t2.timeStamp;
}
function ct$1(t2, e2, n2) {
  const o2 = "BR" === t2.nodeName, r2 = e2.__lexicalLineBreak;
  return r2 && (t2 === r2 || o2 && t2.previousSibling === r2) || o2 && void 0 !== Qs(t2, n2);
}
function at(t2, e2, n2) {
  const o2 = Jl(Il(n2)), r2 = o2 && nc(o2, n2._rootElement);
  let i2 = null, s2 = null;
  null !== r2 && r2.anchorNode === t2 && (i2 = r2.anchorOffset, s2 = r2.focusOffset);
  const l2 = t2.nodeValue;
  null !== l2 && fl(e2, l2, i2, s2, false);
}
function ut$1(t2, e2, n2) {
  if (ur(t2)) {
    const e3 = t2.anchor.getNode();
    if (e3.is(n2) && t2.format !== e3.getFormat()) return false;
  }
  return zs(e2) && n2.isAttached();
}
function ft$1(t2, e2, n2) {
  for (let o2 = t2; o2 && !zc(o2); o2 = wl(o2)) {
    const t3 = Qs(o2, e2);
    if (void 0 !== t3) {
      const e3 = Ys(t3, n2);
      if (e3) return Ki(e3) || !gc(o2) ? void 0 : [o2, e3];
    }
  }
}
function dt$1(t2, e2, n2) {
  it$1 = true;
  const o2 = performance.now() - st$1 > 100;
  try {
    Ai(t2, () => {
      const r2 = Kr() || (function(t3) {
        return t3.read("latest", () => {
          const t4 = Kr();
          return null !== t4 ? t4.clone() : null;
        });
      })(t2), s2 = /* @__PURE__ */ new Map(), l2 = t2._editorState, c2 = t2._blockCursorElement;
      let a2 = false, u2 = "";
      for (let n3 = 0; n3 < e2.length; n3++) {
        const f3 = e2[n3], d2 = f3.type, h2 = f3.target, g2 = ft$1(h2, t2, l2);
        if (!g2) continue;
        const [_2, p] = g2;
        if ("characterData" === d2) o2 && Xo(p) && zs(h2) && ut$1(r2, h2, p) && at(h2, p, t2);
        else if ("childList" === d2) {
          a2 = true;
          const e3 = f3.addedNodes;
          for (let n5 = 0; n5 < e3.length; n5++) {
            const o4 = e3[n5], r3 = Gs(o4), s3 = o4.parentNode;
            if (!(null == s3 || o4 === c2 || null !== r3 || ct$1(o4, s3, t2) || t2._slotsUsed && gc(o4) && o4.hasAttribute("data-lexical-slot") || zc(o4))) {
              if (i) {
                const t3 = (gc(o4) ? o4.innerText : null) || o4.nodeValue;
                t3 && (u2 += t3);
              }
              s3.removeChild(o4);
            }
          }
          const n4 = f3.removedNodes, o3 = n4.length;
          if (o3 > 0) {
            let e4 = 0;
            for (let r3 = 0; r3 < o3; r3++) {
              const o4 = n4[r3];
              (ct$1(o4, h2, t2) || c2 === o4) && (h2.appendChild(o4), e4++);
            }
            o3 !== e4 && s2.set(_2, p);
          }
        }
      }
      if (s2.size > 0) for (const [e3, n3] of s2) n3.reconcileObservedMutation(e3, t2);
      const f2 = n2.takeRecords();
      if (f2.length > 0) {
        for (let e3 = 0; e3 < f2.length; e3++) {
          const n3 = f2[e3], o3 = n3.addedNodes, r3 = n3.target;
          for (let e4 = 0; e4 < o3.length; e4++) {
            const n4 = o3[e4], i2 = n4.parentNode;
            null == i2 || "BR" !== n4.nodeName || ct$1(n4, r3, t2) || i2.removeChild(n4);
          }
        }
        n2.takeRecords();
      }
      null !== r2 && (a2 && ol(r2), i && bl(t2) && r2.insertRawText(u2));
    });
  } finally {
    it$1 = false;
  }
}
function ht$2(t2) {
  const e2 = t2._observer;
  if (null !== e2) dt$1(t2, e2.takeRecords(), e2);
}
function gt$1(t2) {
  (function(t3) {
    0 === st$1 && Il(t3).addEventListener("textInput", lt$1, true);
  })(t2), t2._observer = new MutationObserver((e2, n2) => {
    dt$1(t2, e2, n2);
  });
}
var yt$2 = class {
  key;
  parse;
  unparse;
  isEqual;
  defaultValue;
  resetOnCopyNode;
  constructor(t2, e2) {
    this.key = t2, this.parse = e2.parse.bind(e2), this.unparse = (e2.unparse || wt).bind(e2), this.isEqual = (e2.isEqual || Object.is).bind(e2), this.defaultValue = this.parse(void 0), this.resetOnCopyNode = e2.resetOnCopyNode || false;
  }
};
function mt$2(t2, e2) {
  return new yt$2(t2, e2);
}
function vt$1(t2) {
  const e2 = /* @__PURE__ */ new Map(), n2 = /* @__PURE__ */ new Set();
  for (const { ownNodeConfig: o2 } of jc("function" == typeof t2 ? t2 : t2.replace)) if (o2 && o2.stateConfigs) for (const t3 of o2.stateConfigs) {
    let o3;
    "stateConfig" in t3 ? (o3 = t3.stateConfig, t3.flat && n2.add(o3.key)) : o3 = t3, e2.set(o3.key, o3);
  }
  return {
    flatKeys: n2,
    sharedConfigMap: e2
  };
}
var Tt$2 = /* @__PURE__ */ new Set([
  "__proto__",
  "constructor",
  "prototype"
]);
var kt$1 = class kt$12 {
  node;
  knownState;
  unknownState;
  sharedNodeState;
  size;
  constructor(t2, e2, n2 = void 0, o2 = /* @__PURE__ */ new Map(), r2 = void 0) {
    this.node = t2, this.sharedNodeState = e2, this.unknownState = n2, this.knownState = o2;
    const { sharedConfigMap: i2 } = this.sharedNodeState, s2 = void 0 !== r2 ? r2 : (function(t3, e3, n3) {
      let o3 = n3.size;
      if (e3) for (const r3 in e3) {
        const e4 = t3.get(r3);
        e4 && n3.has(e4) || o3++;
      }
      return o3;
    })(i2, n2, o2);
    this.size = s2;
  }
  getValue(t2) {
    const e2 = this.knownState.get(t2);
    if (void 0 !== e2) return e2;
    this.sharedNodeState.sharedConfigMap.set(t2.key, t2);
    let n2 = t2.defaultValue;
    if (this.unknownState && t2.key in this.unknownState) {
      const e3 = this.unknownState[t2.key];
      void 0 !== e3 && (n2 = t2.parse(e3)), this.updateFromKnown(t2, n2);
    }
    return n2;
  }
  getInternalState() {
    return [this.unknownState, this.knownState];
  }
  toJSON() {
    const t2 = { ...this.unknownState }, e2 = {};
    for (const [e3, n2] of this.knownState) e3.isEqual(n2, e3.defaultValue) ? delete t2[e3.key] : t2[e3.key] = e3.unparse(n2);
    for (const n2 of this.sharedNodeState.flatKeys) n2 in t2 && (e2[n2] = t2[n2], delete t2[n2]);
    return Et$1(t2) && (e2.$ = t2), e2;
  }
  getWritable(t2) {
    if (this.node === t2) return this;
    const { sharedNodeState: e2, unknownState: n2 } = this, o2 = new Map(this.knownState);
    return new kt$12(t2, e2, (function(t3, e3, n3) {
      let o3;
      if (n3) for (const [r2, i2] of Object.entries(n3)) {
        if (Tt$2.has(r2)) continue;
        const n4 = t3.get(r2);
        n4 ? e3.has(n4) || e3.set(n4, n4.parse(i2)) : (o3 = o3 || {}, o3[r2] = i2);
      }
      return o3;
    })(e2.sharedConfigMap, o2, n2), o2, this.size);
  }
  resetOnCopyNode() {
    for (const t2 of this.knownState.keys()) t2.resetOnCopyNode && this.knownState.set(t2, t2.defaultValue);
    return this;
  }
  updateFromKnown(t2, e2) {
    const n2 = t2.key;
    this.sharedNodeState.sharedConfigMap.set(n2, t2);
    const { knownState: o2, unknownState: r2 } = this;
    o2.has(t2) || r2 && n2 in r2 || (r2 && (delete r2[n2], this.unknownState = Et$1(r2)), this.size++), o2.set(t2, e2);
  }
  updateFromUnknown(t2, e2) {
    if (Tt$2.has(t2)) return;
    const n2 = this.sharedNodeState.sharedConfigMap.get(t2);
    n2 ? this.updateFromKnown(n2, n2.parse(e2)) : (this.unknownState = this.unknownState || {}, t2 in this.unknownState || this.size++, this.unknownState[t2] = e2);
  }
  updateFromJSON(t2) {
    const { knownState: e2 } = this;
    for (const t3 of e2.keys()) e2.set(t3, t3.defaultValue);
    if (this.size = e2.size, this.unknownState = void 0, t2) for (const [e3, n2] of Object.entries(t2)) this.updateFromUnknown(e3, n2);
  }
};
function bt$2(t2) {
  const e2 = t2.getWritable(), n2 = e2.__state ? e2.__state.getWritable(e2) : new kt$1(e2, Nt$1(e2));
  return e2.__state = n2, n2;
}
function Nt$1(t2) {
  return t2.__state ? t2.__state.sharedNodeState : Ns(vc(), t2.getType()).sharedNodeState;
}
function Et$1(t2) {
  if (t2) for (const e2 in t2) return t2;
}
function wt(t2) {
  return t2;
}
function Ot$1(t2, e2, n2) {
  for (const [o2, r2] of e2.knownState) {
    if (t2.has(o2.key)) continue;
    t2.add(o2.key);
    const e3 = n2 ? n2.getValue(o2) : o2.defaultValue;
    if (e3 !== r2 && !o2.isEqual(e3, r2)) return true;
  }
  return false;
}
function Mt$1(t2, e2, n2) {
  const { unknownState: o2 } = e2, r2 = n2 ? n2.unknownState : void 0;
  if (o2) for (const [e3, n3] of Object.entries(o2)) {
    if (t2.has(e3)) continue;
    t2.add(e3);
    if (n3 !== (r2 ? r2[e3] : void 0)) return true;
  }
  return false;
}
function At(t2, e2) {
  const n2 = t2.__state;
  return n2 && n2.node === t2 ? n2.getWritable(e2) : n2;
}
function Dt$1(t2, e2) {
  const n2 = t2.__mode, o2 = t2.__format, r2 = t2.__style, i2 = e2.__mode, s2 = e2.__format, l2 = e2.__style, c2 = t2.__state, a2 = e2.__state;
  return (null === n2 || n2 === i2) && (null === o2 || o2 === s2) && (null === r2 || r2 === l2) && (null === t2.__state || c2 === a2 || (function(t3, e3) {
    if (t3 === e3) return true;
    const n3 = /* @__PURE__ */ new Set();
    return !(t3 && Ot$1(n3, t3, e3) || e3 && Ot$1(n3, e3, t3) || t3 && Mt$1(n3, t3, e3) || e3 && Mt$1(n3, e3, t3));
  })(c2, a2));
}
function Ft$1(t2, e2) {
  const n2 = t2.mergeWithSibling(e2), o2 = _i()._normalizedNodes;
  return o2.add(t2.__key), o2.add(e2.__key), n2;
}
function Pt$1(t2) {
  let e2, n2, o2 = t2;
  if ("" !== o2.__text || !o2.isSimpleText() || o2.isUnmergeable()) {
    for (; null !== (e2 = o2.getPreviousSibling()) && Xo(e2) && e2.isSimpleText() && !e2.isUnmergeable(); ) {
      if ("" !== e2.__text) {
        if (Dt$1(e2, o2)) {
          o2 = Ft$1(e2, o2);
          break;
        }
        break;
      }
      e2.remove();
    }
    for (; null !== (n2 = o2.getNextSibling()) && Xo(n2) && n2.isSimpleText() && !n2.isUnmergeable(); ) {
      if ("" !== n2.__text) {
        if (Dt$1(o2, n2)) {
          o2 = Ft$1(o2, n2);
          break;
        }
        break;
      }
      n2.remove();
    }
  } else o2.remove();
}
function It(t2) {
  return Lt$1(t2.anchor), Lt$1(t2.focus), t2;
}
function Lt$1(t2) {
  for (; "element" === t2.type; ) {
    const e2 = t2.getNode(), n2 = t2.offset;
    let o2, r2;
    if (n2 === e2.getChildrenSize() ? (o2 = e2.getChildAtIndex(n2 - 1), r2 = true) : (o2 = e2.getChildAtIndex(n2), r2 = false), Xo(o2)) {
      t2.set(o2.__key, r2 ? o2.getTextContentSize() : 0, "text", true);
      break;
    }
    if (!Pi(o2)) break;
    t2.set(o2.__key, r2 ? o2.getChildrenSize() : 0, "element", true);
  }
}
var Kt$2 = Symbol.for("@lexical/CachedTextSize");
function zt$2(e2, n2) {
  return ee$3.read(() => {
    let o2 = 0, r2 = e2;
    for (let e3 = 0; e3 < n2 && null !== r2; e3++) {
      const i2 = te$3.get(r2);
      if (void 0 === i2 && t(345, r2), Pi(i2)) {
        const s2 = ne$3.get(r2);
        if (void 0 !== s2 && Pi(s2) && s2.__parent !== i2.__parent) o2 += i2.getTextContentSize();
        else {
          const e4 = oe$3.get(r2), n3 = e4 && e4.__lexicalTextContent;
          "string" != typeof n3 && t(346, i2.getType()), o2 += n3.length;
        }
        e3 < n2 - 1 && !i2.isInline() && (o2 += 2);
      } else {
        const e4 = i2[Kt$2];
        void 0 === e4 && t(347, i2.getType(), r2), o2 += e4;
      }
      r2 = i2.__next;
    }
    return o2;
  }, { editor: $t$2 });
}
function Bt$3(t2) {
  Pi(t2) || void 0 === t2[Kt$2] && (t2[Kt$2] = Xo(t2) ? t2.__text.length : t2.getTextContentSize());
}
var Rt$1 = 4;
var Wt$2;
var $t$2;
var Ut$2;
var Ht$2 = "";
var jt$2 = null;
var Jt$2 = null;
var Vt$2 = null;
function qt$2() {
  return {
    firstTextKey: Vt$2,
    format: jt$2,
    style: Jt$2
  };
}
function Yt$2(t2) {
  null !== t2.firstTextKey && (jt$2 = t2.format, Jt$2 = t2.style, Vt$2 = t2.firstTextKey);
}
function Gt$2(e2) {
  if (null !== Vt$2) return;
  const n2 = e2.__lexicalFirstTextKey;
  if (void 0 === n2 && t(348), null === n2) return;
  const o2 = ne$3.get(n2);
  Xo(o2) && (jt$2 = o2.getFormat(), Jt$2 = o2.getStyle(), Vt$2 = n2);
}
var Xt$2;
var Qt$2;
var Zt$2;
var te$3;
var ee$3;
var ne$3;
var oe$3;
var re$2;
var ie$2;
var se$2;
var le$2 = false;
var ce$2 = false;
function ae$2(t2, e2) {
  const n2 = te$3.get(t2), o2 = ne$3.has(t2);
  if (null !== e2) {
    const n3 = Fe$2(t2);
    n3.parentNode === e2 && e2.removeChild(n3);
  }
  if (!o2) {
    if ($t$2._keyToDOMMap.delete(t2), Pi(n2)) {
      const t3 = Yc(n2, te$3);
      ue$1(t3, 0, t3.length - 1, null);
    }
    if (void 0 !== n2) {
      for (const t3 of xe$1(n2).values()) {
        const e3 = Se$1(t3);
        ae$2(t3, null), null !== e3 && e3.remove();
      }
      Sl(ie$2, Ut$2, Xt$2, n2, "destroyed");
    }
  }
}
function ue$1(t2, e2, n2, o2) {
  for (let r2 = e2; r2 <= n2; ++r2) {
    const e3 = t2[r2];
    void 0 !== e3 && ae$2(e3, o2);
  }
}
function fe$1(t2, e2) {
  t2.setProperty("text-align", e2);
}
var de$1 = "40px";
function he(t2, e2) {
  const n2 = Wt$2.theme.indent;
  if ("string" == typeof n2) {
    const o2 = t2.classList.contains(n2);
    e2 > 0 && !o2 ? t2.classList.add(n2) : e2 < 1 && o2 && t2.classList.remove(n2);
  }
  t2.style.setProperty("padding-inline-start", 0 === e2 ? "" : `calc(${e2} * var(--lexical-indent-base-value, ${de$1}))`);
}
function ge$1(t2, e2) {
  const n2 = t2.style;
  0 === e2 ? fe$1(n2, "") : 1 === e2 ? fe$1(n2, "left") : 2 === e2 ? fe$1(n2, "center") : 3 === e2 ? fe$1(n2, "right") : 4 === e2 ? fe$1(n2, "justify") : 5 === e2 ? fe$1(n2, "start") : 6 === e2 && fe$1(n2, "end");
}
function _e$2(t2, e2) {
  const n2 = (function(t3) {
    const e3 = t3.__dir;
    if (null !== e3) return e3;
    if (Bi(t3)) return null;
    const n3 = t3.getParent();
    return null === n3 || Bl(n3) && null === n3.__dir ? "auto" : null;
  })(e2);
  null !== n2 ? t2.dir = n2 : t2.removeAttribute("dir");
}
function pe$1(t2) {
  const e2 = Zl().createElement("div");
  return e2.setAttribute("data-lexical-slot", t2), e2.style.display = "none", e2;
}
function ye$1(t2, e2, n2) {
  e2 || "false" === t2.contentEditable ? Bc(n2, $t$2) : n2.removeAttribute("contenteditable");
}
function me$2(t2, e2, n2) {
  const o2 = Ht$2, r2 = qt$2();
  Ht$2 = "";
  let i2 = "";
  const s2 = Ki(t2);
  for (const [o3, r3] of n2) {
    const n3 = pe$1(o3);
    ye$1(e2, s2, n3), e2.appendChild(n3), Ht$2 = "";
    const l2 = qt$2();
    Te$2(r3, kc(t2, n3, $t$2)), Yt$2(l2), Ce$2(t2, o3, e2, n3), i2 += Ht$2;
  }
  return Yt$2(r2), Ht$2 = o2, i2;
}
function xe$1(t2) {
  return Qc(t2) && null !== t2.__slots ? t2.__slots : Xc;
}
function Ce$2(t2, e2, n2, o2) {
  const r2 = se$2.$getSlotTargetElement(t2, e2, n2, $t$2);
  null !== r2 && (o2.parentElement !== r2 && r2.appendChild(o2), o2.style.display = "");
}
function Se$1(t2) {
  const e2 = oe$3.get(t2);
  return void 0 !== e2 ? e2.parentElement : null;
}
function ve$2(t2, e2, n2) {
  const o2 = xe$1(t2), r2 = xe$1(e2);
  for (const [t3, e3] of o2) if (!r2.has(t3)) {
    const t4 = Se$1(e3);
    ae$2(e3, null), null !== t4 && t4.remove();
  }
  const i2 = Ht$2, s2 = qt$2();
  let l2 = "", c2 = null;
  const a2 = Ki(e2);
  for (const [t3, i3] of r2) {
    const r3 = o2.get(t3);
    let s3 = void 0 !== r3 ? Se$1(r3) : null;
    Ht$2 = "";
    const u2 = qt$2();
    if (null === s3) {
      s3 = pe$1(t3);
      let o3 = null;
      for (const t4 of n2.children) if (!t4.hasAttribute("data-lexical-slot")) {
        o3 = t4;
        break;
      }
      n2.insertBefore(s3, o3), Te$2(i3, kc(e2, s3, $t$2));
    } else r3 === i3 ? we$1(i3, s3) : (void 0 !== r3 && ae$2(r3, s3), Te$2(i3, kc(e2, s3, $t$2)));
    if (Yt$2(u2), ye$1(n2, a2, s3), Ce$2(e2, t3, n2, s3), l2 += Ht$2, s3.parentElement === n2) {
      const t4 = null === c2 ? n2.firstChild : c2.nextSibling;
      t4 !== s3 && n2.insertBefore(s3, t4), c2 = s3;
    }
  }
  return Yt$2(s2), Ht$2 = i2, l2;
}
function Te$2(e2, n2) {
  const o2 = ne$3.get(e2);
  if (void 0 === o2 && t(60), null !== n2) {
    const t2 = te$3.get(e2);
    if (void 0 !== t2) {
      const r3 = oe$3.get(e2);
      if (void 0 !== r3) {
        const i2 = Zc(t2) ? t2.__slotHost : null, s2 = Zc(o2) ? o2.__slotHost : null, l2 = t2.__parent !== o2.__parent || i2 !== s2, c2 = null !== s2 && r3.parentElement !== n2.element;
        if (l2 || c2) return n2.insertChild(r3), we$1(e2, n2.element);
      }
    }
  }
  const r2 = se$2.$createDOM(o2, $t$2);
  if ((function(t2, e3, n3) {
    const o3 = n3._keyToDOMMap;
    Xs(e3, n3, t2), o3.set(t2, e3);
  })(e2, r2, $t$2), Xo(o2) ? r2.setAttribute("data-lexical-text", "true") : Ki(o2) && (r2.setAttribute("data-lexical-decorator", "true"), Kc(r2, { captureSelection: true })), Pi(o2)) {
    const t2 = o2.__indent, e3 = o2.__size;
    _e$2(r2, o2), 0 !== t2 && he(r2, t2);
    const n3 = xe$1(o2), i2 = n3.size > 0 ? me$2(o2, r2, n3) : "";
    if (0 === e3) r2.__lexicalTextContent = i2, r2.__lexicalFirstTextKey = null, Ht$2 += i2, n3.size > 0 && (r2.__lexicalSlotTextLength = i2.length);
    else {
      const t3 = Ht$2, s3 = e3 - 1;
      if (ke$2(Yc(o2, ne$3), o2, 0, s3, kc(o2, r2, $t$2)), "" !== i2) {
        const e4 = r2.__lexicalTextContent || "";
        r2.__lexicalTextContent = i2 + e4, Ht$2 = t3 + i2 + e4;
      }
      n3.size > 0 && (r2.__lexicalSlotTextLength = i2.length);
    }
    const s2 = o2.__format;
    0 !== s2 && ge$1(r2, s2), o2.isInline() || be$1(null, o2, r2);
  } else {
    const t2 = o2.getTextContent();
    if (Ki(o2)) {
      const t3 = o2.decorate($t$2, Wt$2);
      null !== t3 && Oe$1(e2, t3), r2.contentEditable = "false";
      const n3 = xe$1(o2);
      n3.size > 0 && me$2(o2, r2, n3);
    }
    Ht$2 += t2;
  }
  return null !== n2 && n2.insertChild(r2), se$2.$decorateDOM(o2, null, r2, $t$2), Bt$3(o2), Sl(ie$2, Ut$2, Xt$2, o2, "created"), r2;
}
function ke$2(e2, n2, o2, r2, i2) {
  const s2 = Ht$2, l2 = qt$2();
  Ht$2 = "", jt$2 = null, Jt$2 = null, Vt$2 = null;
  let c2 = o2;
  for (; c2 <= r2; ++c2) {
    const t2 = qt$2();
    Te$2(e2[c2], i2);
    const n3 = ne$3.get(e2[c2]);
    null !== n3 && Xo(n3) ? null === jt$2 && (jt$2 = n3.getFormat(), Jt$2 = n3.getStyle(), Vt$2 = n3.__key) : Pi(n3) && c2 < r2 && !n3.isInline() && (Ht$2 += D$1), Yt$2(t2);
  }
  const a2 = $t$2._keyToDOMMap.get(n2.__key);
  void 0 === a2 && t(349, n2.__key), a2.__lexicalTextContent = Ht$2, a2.__lexicalFirstTextKey = Vt$2, Ht$2 = s2 + Ht$2, Yt$2(l2);
}
function be$1(t2, e2, n2) {
  const o2 = kc(e2, n2, $t$2), r2 = o2.element.__lexicalLastChildKind ?? null, i2 = (function(t3, e3) {
    if (t3) {
      const n3 = t3.__last;
      if (n3) {
        const t4 = e3.get(n3);
        if (t4) return Yi(t4) ? "line-break" : Ki(t4) && t4.isInline() ? "decorator" : null;
      }
      return xe$1(t3).size > 0 ? null : "empty";
    }
    return null;
  })(e2, ne$3);
  r2 !== i2 && o2.setManagedLineBreak(i2);
}
function Ne$1(e2, n2, o2) {
  var r2;
  jt$2 = null, Jt$2 = null, Vt$2 = null, (function(e3, n3, o3) {
    const r3 = Ht$2, i2 = e3.__size, s2 = n3.__size;
    Ht$2 = "";
    const l2 = o3.element, c2 = $t$2._keyToDOMMap.get(n3.__key);
    void 0 === c2 && t(351, n3.__key);
    const a2 = s2 - i2;
    if (!le$2 && Math.abs(a2) <= 1 && i2 >= Rt$1 && e3.__first === n3.__first && (0 !== a2 || !$t$2._cloneNotNeeded.has(e3.__key))) {
      const i3 = c2.__lexicalTextContent, u2 = re$2.get(e3.__key);
      if (!le$2 && "string" == typeof i3 && void 0 !== u2) {
        const s3 = (function(t2, e4) {
          const n4 = e4.size;
          if (0 === n4 || n4 >= t2.__size) return null;
          let o4 = t2.__last, r4 = null, i4 = 0;
          for (; null !== o4 && i4 < n4; ) {
            if (!e4.has(o4)) return null;
            r4 = o4;
            const t3 = ne$3.get(o4);
            if (void 0 === t3) return null;
            o4 = t3.__prev, i4++;
          }
          if (i4 !== n4) return null;
          if (null !== o4 && e4.has(o4)) return null;
          return r4;
        })(n3, u2);
        if (null !== s3) {
          const f2 = u2.size;
          if (0 === a2) {
            const e4 = zt$2(s3, f2);
            let o4 = s3, a3 = 0;
            for (; null !== o4 && a3 < f2; ) {
              const t2 = ne$3.get(o4);
              if (void 0 === t2) break;
              const e5 = qt$2();
              we$1(o4, l2), Xo(t2) && null === jt$2 && (jt$2 = t2.getFormat(), Jt$2 = t2.getStyle(), Vt$2 = t2.__key), Yt$2(e5), o4 = t2.__next, a3++;
            }
            let d2 = "";
            for (o4 = s3, a3 = 0; null !== o4 && a3 < f2; ) {
              const e5 = ne$3.get(o4);
              if (void 0 === e5) break;
              let n4;
              if (Pi(e5)) {
                const r4 = $t$2._keyToDOMMap.get(o4), i4 = r4 && r4.__lexicalTextContent;
                "string" != typeof i4 && t(352, e5.getType()), n4 = i4;
              } else n4 = e5.getTextContent();
              d2 += n4, a3 < f2 - 1 && Pi(e5) && !e5.isInline() && (d2 += D$1), o4 = e5.__next, a3++;
            }
            const h2 = c2.__lexicalSlotTextLength || 0, g2 = h2 > 0 ? i3.slice(h2) : i3, _2 = g2.slice(0, g2.length - e4) + d2;
            c2.__lexicalTextContent = _2, Ht$2 = r3 + _2, Ee$1(n3, c2, u2);
            return;
          }
          if ((function(e4, n4, o4, r4, i4, s4, l3, c3) {
            if (1 !== c3 && -1 !== c3) return false;
            if (l3 !== (1 === c3 ? 2 : 1)) return false;
            const u3 = l3 - c3;
            let f3 = e4.__last;
            for (let t2 = 0; t2 < u3 - 1; t2++) {
              if (null === f3) return false;
              const t3 = te$3.get(f3);
              if (void 0 === t3) return false;
              f3 = t3.__prev;
            }
            if (null === f3) return false;
            const d2 = ne$3.get(s4), h2 = te$3.get(f3);
            if (void 0 === d2 || void 0 === h2) return false;
            if (d2.__prev !== h2.__prev) return false;
            const g2 = [];
            let _2 = s4;
            for (let t2 = 0; t2 < l3; t2++) {
              if (null === _2) return false;
              g2.push(_2);
              const t3 = ne$3.get(_2);
              _2 = t3 ? t3.__next : null;
            }
            const p = [];
            _2 = f3;
            for (let t2 = 0; t2 < u3; t2++) {
              if (null === _2) return false;
              p.push(_2);
              const t3 = te$3.get(_2);
              _2 = t3 ? t3.__next : null;
            }
            const y = new Set(p), m = new Set(g2), x2 = [];
            let C = 0, S = 0;
            for (; C < u3 && S < l3; ) if (g2[S] === p[C]) x2.push({
              key: g2[S],
              kind: "reconcile"
            }), C++, S++;
            else if (m.has(p[C])) {
              if (y.has(g2[S])) return false;
              x2.push({
                key: g2[S],
                kind: "create",
                nextIndex: S
              }), S++;
            } else x2.push({
              key: p[C],
              kind: "destroy"
            }), C++;
            for (; C < u3; ) x2.push({
              key: p[C++],
              kind: "destroy"
            });
            for (; S < l3; ) x2.push({
              key: g2[S],
              kind: "create",
              nextIndex: S
            }), S++;
            const v = zt$2(f3, u3);
            for (const t2 of x2) {
              const e5 = qt$2();
              if ("reconcile" === t2.kind) we$1(t2.key, o4.element);
              else if ("destroy" === t2.kind) ae$2(t2.key, o4.element);
              else {
                let e6 = null;
                for (let n5 = t2.nextIndex + 1; n5 < l3; n5++) {
                  const t3 = $t$2._keyToDOMMap.get(g2[n5]);
                  if (void 0 !== t3) {
                    e6 = t3;
                    break;
                  }
                }
                Te$2(t2.key, o4.withBefore(e6 ?? o4.before));
              }
              if ("destroy" !== t2.kind) {
                const e6 = ne$3.get(t2.key);
                e6 && Xo(e6) && null === jt$2 && (jt$2 = e6.getFormat(), Jt$2 = e6.getStyle(), Vt$2 = e6.__key);
              }
              Yt$2(e5);
            }
            let T = "";
            for (let e5 = 0; e5 < l3; e5++) {
              const n5 = ne$3.get(g2[e5]);
              if (void 0 === n5) return false;
              let o5;
              if (Pi(n5)) {
                const r5 = $t$2._keyToDOMMap.get(g2[e5]), i5 = r5 && r5.__lexicalTextContent;
                "string" != typeof i5 && t(350, n5.getType()), o5 = i5;
              } else o5 = n5.getTextContent();
              T += o5, e5 < l3 - 1 && Pi(n5) && !n5.isInline() && (T += D$1);
            }
            const k = r4.__lexicalSlotTextLength || 0, b2 = k > 0 ? i4.slice(k) : i4;
            return r4.__lexicalTextContent = b2.slice(0, b2.length - v) + T, true;
          })(e3, 0, o3, c2, i3, s3, f2, a2)) {
            const e4 = c2.__lexicalTextContent;
            "string" != typeof e4 && t(353), Ht$2 = r3 + e4, Ee$1(n3, c2, u2);
            return;
          }
        }
      }
      if (0 === a2) {
        let n4 = e3.__first, o4 = 0;
        for (; null !== n4; ) {
          const e4 = ne$3.get(n4);
          if (void 0 === e4) break;
          const r4 = le$2 || Zt$2.has(n4) || Qt$2.has(n4), i4 = qt$2();
          if (r4) we$1(n4, l2);
          else {
            let o5, r5;
            if (Pi(e4)) {
              r5 = oe$3.get(n4);
              const i5 = r5 && r5.__lexicalTextContent;
              "string" != typeof i5 && t(354, e4.getType()), o5 = i5;
            } else o5 = e4.getTextContent();
            Ht$2 += o5, void 0 !== r5 && Gt$2(r5);
          }
          Xo(e4) ? null === jt$2 && (jt$2 = e4.getFormat(), Jt$2 = e4.getStyle(), Vt$2 = e4.__key) : Pi(e4) && o4 < s2 - 1 && !e4.isInline() && (Ht$2 += D$1), Yt$2(i4), n4 = e4.__next, o4++;
        }
        c2.__lexicalTextContent = Ht$2, c2.__lexicalFirstTextKey = Vt$2, Ht$2 = r3 + Ht$2;
        return;
      }
    }
    if (1 === i2 && 1 === s2) {
      const t2 = e3.__first, r4 = n3.__first;
      if (t2 === r4) we$1(t2, l2);
      else {
        const e4 = Fe$2(t2), n4 = Te$2(r4, null);
        try {
          e4.parentNode === l2 ? l2.replaceChild(n4, e4) : o3.insertChild(n4);
        } catch (o4) {
          if ("object" == typeof o4 && null != o4) {
            const i4 = `${o4.toString()} Parent: ${l2.tagName}, new child: {tag: ${n4.tagName} key: ${r4}}, old child: {tag: ${e4.tagName}, key: ${t2}}.`;
            throw new Error(i4);
          }
          throw o4;
        }
        ae$2(t2, null);
      }
      const i3 = ne$3.get(r4);
      Xo(i3) && null === jt$2 && (jt$2 = i3.getFormat(), Jt$2 = i3.getStyle(), Vt$2 = i3.__key);
    } else {
      const r4 = Yc(e3, te$3), c3 = Yc(n3, ne$3);
      if (r4.length !== i2 && t(227), c3.length !== s2 && t(228), 0 === i2) 0 !== s2 && ke$2(c3, n3, 0, s2 - 1, o3);
      else if (0 === s2) {
        if (0 !== i2) {
          const t2 = null == o3.after && null == o3.before && 0 === xe$1(n3).size && null == o3.element.__lexicalLineBreak;
          ue$1(r4, 0, i2 - 1, t2 ? null : l2), t2 && (l2.textContent = "");
        }
      } else (function(t2, e4, n4, o4, r5, i3) {
        const s3 = o4 - 1, l3 = r5 - 1;
        let c4, a3, u2 = i3.getFirstChild(), f2 = 0, d2 = 0;
        for (; f2 <= s3 && d2 <= l3; ) {
          const t3 = e4[f2], o5 = n4[d2], r6 = qt$2();
          if (t3 === o5) u2 = Me$2(we$1(o5, i3.element)), f2++, d2++;
          else {
            if (void 0 === a3 && (a3 = Ae$2(n4, d2)), void 0 === c4) c4 = Ae$2(e4, f2);
            else if (!c4.has(t3)) {
              f2++, Yt$2(r6);
              continue;
            }
            if (!a3.has(t3)) {
              u2 = Me$2(Fe$2(t3)), ae$2(t3, i3.element), f2++, c4.delete(t3), Yt$2(r6);
              continue;
            }
            if (c4.has(o5)) {
              const t4 = El($t$2, o5);
              t4 !== u2 && i3.withBefore(u2 ?? i3.before).insertChild(t4), u2 = Me$2(we$1(o5, i3.element)), f2++, d2++;
            } else Te$2(o5, i3.withBefore(u2 ?? i3.before)), d2++;
          }
          const s4 = ne$3.get(o5);
          null !== s4 && Xo(s4) ? null === jt$2 && (jt$2 = s4.getFormat(), Jt$2 = s4.getStyle(), Vt$2 = s4.__key) : Pi(s4) && d2 <= l3 && !s4.isInline() && (Ht$2 += D$1), Yt$2(r6);
        }
        const h2 = f2 > s3, g2 = d2 > l3;
        if (h2 && !g2) {
          const e5 = n4[l3 + 1], o5 = void 0 === e5 ? null : $t$2.getElementByKey(e5);
          ke$2(n4, t2, d2, l3, i3.withBefore(o5 ?? i3.before));
        } else g2 && !h2 && ue$1(e4, f2, s3, i3.element);
      })(n3, r4, c3, i2, s2, o3);
    }
    c2.__lexicalTextContent = Ht$2, c2.__lexicalFirstTextKey = Vt$2, Ht$2 = r3 + Ht$2;
  })(e2, n2, kc(n2, o2, $t$2)), Bl(n2) || (r2 = n2, null == jt$2 || jt$2 === r2.__textFormat || ce$2 || r2.setTextFormat(jt$2), (function(t2) {
    null == Jt$2 || Jt$2 === t2.__textStyle || ce$2 || t2.setTextStyle(Jt$2);
  })(n2));
}
function Ee$1(t2, e2, n2) {
  const o2 = e2.__lexicalFirstTextKey;
  if (null != o2) {
    const e3 = t2.__key;
    let r2 = o2;
    for (; null !== r2; ) {
      const t3 = ne$3.get(r2);
      if (void 0 === t3) {
        r2 = null;
        break;
      }
      if (t3.__parent === e3) break;
      r2 = t3.__parent;
    }
    if (null !== r2 && !n2.has(r2)) {
      const t3 = ne$3.get(o2);
      if (Xo(t3)) return jt$2 = t3.getFormat(), void (Jt$2 = t3.getStyle());
    }
  }
  e2.__lexicalFirstTextKey = Vt$2;
}
function we$1(e2, n2) {
  const o2 = te$3.get(e2);
  let r2 = ne$3.get(e2);
  void 0 !== o2 && void 0 !== r2 || t(61);
  const i2 = le$2 || Zt$2.has(e2) || Qt$2.has(e2), s2 = El($t$2, e2);
  if (o2 === r2 && !i2) {
    let e3;
    if (Pi(o2)) {
      const n3 = s2.__lexicalTextContent;
      "string" != typeof n3 && t(355, o2.getType()), e3 = n3, Gt$2(s2);
    } else e3 = o2.getTextContent();
    return Ht$2 += e3, s2;
  }
  if (o2 !== r2 && i2 && Sl(ie$2, Ut$2, Xt$2, r2, "updated"), se$2.$updateDOM(r2, o2, s2, $t$2)) {
    const o3 = Te$2(e2, null);
    return null === n2 && t(62), n2.replaceChild(o3, s2), ae$2(e2, null), o3;
  }
  if (Pi(o2)) {
    Pi(r2) || t(334, e2);
    const n3 = r2.__indent;
    (le$2 || n3 !== o2.__indent) && he(s2, n3);
    const l2 = r2.__format;
    (le$2 || l2 !== o2.__format) && ge$1(s2, l2);
    const c2 = i2 && (xe$1(r2).size > 0 || xe$1(o2).size > 0) ? ve$2(o2, r2, s2) : "";
    if (i2) {
      const t2 = Ht$2;
      if (Ne$1(o2, r2, s2), Bi(r2) || r2.isInline() || be$1(0, r2, s2), "" !== c2) {
        const e3 = s2.__lexicalTextContent || "";
        s2.__lexicalTextContent = c2 + e3, Ht$2 = t2 + c2 + e3, s2.__lexicalSlotTextLength = c2.length;
      } else (xe$1(r2).size > 0 || xe$1(o2).size > 0) && (s2.__lexicalSlotTextLength = 0);
    } else {
      const e3 = s2.__lexicalTextContent;
      "string" != typeof e3 && t(356, o2.getType()), Ht$2 += e3, Gt$2(s2);
    }
    if ((le$2 || r2.__dir !== o2.__dir || r2.__parent !== o2.__parent) && (_e$2(s2, r2), Bi(r2) && !le$2)) {
      for (const t2 of r2.getChildren()) if (Pi(t2)) _e$2(El($t$2, t2.getKey()), t2);
    }
  } else {
    const t2 = r2.getTextContent();
    if (Ki(r2)) {
      const t3 = r2.decorate($t$2, Wt$2);
      null !== t3 && Oe$1(e2, t3), i2 && (xe$1(r2).size > 0 || xe$1(o2).size > 0) && ve$2(o2, r2, s2);
    }
    Ht$2 += t2;
  }
  if (!ce$2 && Bi(r2)) {
    const t2 = r2.getLatest();
    if (t2.__cachedText !== Ht$2) {
      const e3 = t2.getWritable();
      e3.__cachedText = Ht$2, r2 = e3;
    }
  }
  return se$2.$decorateDOM(r2, o2, s2, $t$2), Bt$3(r2), s2;
}
function Oe$1(t2, e2) {
  let n2 = $t$2._pendingDecorators;
  const o2 = $t$2._decorators;
  if (null === n2) {
    if (o2[t2] === e2) return;
    n2 = tl($t$2);
  }
  n2[t2] = e2;
}
function Me$2(t2) {
  let e2 = t2.nextSibling;
  return null !== e2 && e2 === $t$2._blockCursorElement && (e2 = e2.nextSibling), e2;
}
function Ae$2(t2, e2) {
  const n2 = /* @__PURE__ */ new Set();
  for (let o2 = e2; o2 < t2.length; o2++) n2.add(t2[o2]);
  return n2;
}
function De$2(t2, e2, n2, o2, r2, i2) {
  Ht$2 = "", jt$2 = null, Jt$2 = null, Vt$2 = null, le$2 = 2 === o2, $t$2 = n2, Wt$2 = n2._config, se$2 = n2._config.dom || ps, Ut$2 = n2._nodes, Xt$2 = $t$2._listeners.mutation, Qt$2 = r2, Zt$2 = i2, te$3 = t2._nodeMap, ee$3 = t2, ne$3 = e2._nodeMap, ce$2 = e2._readOnly, oe$3 = nt$2(n2._keyToDOMMap), re$2 = (function() {
    const t3 = /* @__PURE__ */ new Map(), e3 = (e4) => {
      for (const n3 of e4) {
        const e5 = ne$3.get(n3);
        if (void 0 === e5) continue;
        const o3 = e5.__parent;
        if (null === o3) continue;
        let r3 = t3.get(o3);
        void 0 === r3 && (r3 = /* @__PURE__ */ new Set(), t3.set(o3, r3)), r3.add(n3);
      }
    };
    return e3(Qt$2.keys()), e3(Zt$2), t3;
  })();
  const s2 = /* @__PURE__ */ new Map();
  return ie$2 = s2, we$1("root", null), $t$2 = void 0, Ut$2 = void 0, Qt$2 = void 0, Zt$2 = void 0, te$3 = void 0, ee$3 = void 0, ne$3 = void 0, Wt$2 = void 0, oe$3 = void 0, re$2 = void 0, ie$2 = void 0, se$2 = ps, s2;
}
function Fe$2(e2) {
  const n2 = oe$3.get(e2);
  return void 0 === n2 && t(75, e2), n2;
}
function Pe$2(t2) {
  return { type: t2 };
}
var Ie$2 = /* @__PURE__ */ Pe$2("SELECTION_CHANGE_COMMAND");
var Ke$2 = /* @__PURE__ */ Pe$2("CLICK_COMMAND");
var ze$2 = /* @__PURE__ */ Pe$2("BEFORE_INPUT_COMMAND");
var Be$2 = /* @__PURE__ */ Pe$2("INPUT_COMMAND");
var Re = /* @__PURE__ */ Pe$2("COMPOSITION_START_COMMAND");
var We$2 = /* @__PURE__ */ Pe$2("COMPOSITION_END_COMMAND");
var $e$2 = /* @__PURE__ */ Pe$2("DELETE_CHARACTER_COMMAND");
var Ue$2 = /* @__PURE__ */ Pe$2("INSERT_LINE_BREAK_COMMAND");
var He$2 = /* @__PURE__ */ Pe$2("INSERT_PARAGRAPH_COMMAND");
var je$2 = /* @__PURE__ */ Pe$2("CONTROLLED_TEXT_INSERTION_COMMAND");
var Je$2 = /* @__PURE__ */ Pe$2("PASTE_COMMAND");
var Ve$2 = /* @__PURE__ */ Pe$2("REMOVE_TEXT_COMMAND");
var qe$2 = /* @__PURE__ */ Pe$2("DELETE_WORD_COMMAND");
var Ye$1 = /* @__PURE__ */ Pe$2("DELETE_LINE_COMMAND");
var Ge$2 = /* @__PURE__ */ Pe$2("FORMAT_TEXT_COMMAND");
var Qe$2 = /* @__PURE__ */ Pe$2("UNDO_COMMAND");
var Ze$2 = /* @__PURE__ */ Pe$2("REDO_COMMAND");
var tn$2 = /* @__PURE__ */ Pe$2("KEYDOWN_COMMAND");
var en$3 = /* @__PURE__ */ Pe$2("KEY_ARROW_RIGHT_COMMAND");
var nn$2 = /* @__PURE__ */ Pe$2("MOVE_TO_END");
var on$1 = /* @__PURE__ */ Pe$2("KEY_ARROW_LEFT_COMMAND");
var rn$1 = /* @__PURE__ */ Pe$2("MOVE_TO_START");
var sn$2 = /* @__PURE__ */ Pe$2("KEY_ARROW_UP_COMMAND");
var ln$2 = /* @__PURE__ */ Pe$2("KEY_ARROW_DOWN_COMMAND");
var cn$1 = /* @__PURE__ */ Pe$2("KEY_ENTER_COMMAND");
var an$1 = /* @__PURE__ */ Pe$2("KEY_SPACE_COMMAND");
var un$2 = /* @__PURE__ */ Pe$2("KEY_BACKSPACE_COMMAND");
var fn$1 = /* @__PURE__ */ Pe$2("KEY_ESCAPE_COMMAND");
var dn$1 = /* @__PURE__ */ Pe$2("KEY_DELETE_COMMAND");
var hn$2 = /* @__PURE__ */ Pe$2("KEY_TAB_COMMAND");
var yn$1 = /* @__PURE__ */ Pe$2("DROP_COMMAND");
var xn$1 = /* @__PURE__ */ Pe$2("DRAGSTART_COMMAND");
var Cn$1 = /* @__PURE__ */ Pe$2("DRAGOVER_COMMAND");
var Sn$2 = /* @__PURE__ */ Pe$2("DRAGEND_COMMAND");
var vn$2 = /* @__PURE__ */ Pe$2("COPY_COMMAND");
var Tn = /* @__PURE__ */ Pe$2("CUT_COMMAND");
var kn = /* @__PURE__ */ Pe$2("SELECT_ALL_COMMAND");
var bn$2 = /* @__PURE__ */ Pe$2("CLEAR_EDITOR_COMMAND");
var Nn$1 = /* @__PURE__ */ Pe$2("CLEAR_HISTORY_COMMAND");
var En = /* @__PURE__ */ Pe$2("CAN_REDO_COMMAND");
var wn$1 = /* @__PURE__ */ Pe$2("CAN_UNDO_COMMAND");
var On$1 = /* @__PURE__ */ Pe$2("FOCUS_COMMAND");
var Mn$1 = /* @__PURE__ */ Pe$2("BLUR_COMMAND");
var An = /* @__PURE__ */ Pe$2("KEY_MODIFIER_COMMAND");
function Dn$1(t2) {
  const e2 = /* @__PURE__ */ new Map();
  return {
    dispose() {
      for (const t3 of e2.values()) t3.dispose();
      e2.clear();
    },
    register(n2, o2) {
      let r2 = e2.get(n2);
      void 0 === r2 && (r2 = {
        dispose: t2(n2, o2),
        holders: /* @__PURE__ */ new Set()
      }, e2.set(n2, r2));
      const i2 = () => {
        const t3 = e2.get(n2);
        t3 && t3.holders.delete(i2) && 0 === t3.holders.size && (e2.delete(n2), t3.dispose());
      };
      return r2.holders.add(i2), i2;
    }
  };
}
function Fn(t2, e2, n2, o2) {
  return t2.addEventListener(e2, n2, o2), t2.removeEventListener.bind(t2, e2, n2, o2);
}
var Pn = Object.freeze({});
var In = [
  ["keydown", function(t2, e2) {
    const n2 = e2._inputState;
    n2.lastKeyDownTimeStamp = t2.timeStamp, n2.lastKeyCode = t2.key, "Backspace" !== t2.key && Jn(n2);
    if (e2.isComposing()) return;
    Nl(e2, tn$2, t2);
  }],
  ["pointerdown", function(t2, e2) {
    const n2 = ac(t2), o2 = t2.pointerType;
    _c(n2) && "touch" !== o2 && "pen" !== o2 && 0 === t2.button && Ai(e2, () => {
      Rc(n2, e2) || (e2._inputState.isSelectionChangeFromMouseDown = true);
    });
  }],
  ["compositionstart", function(t2, e2) {
    Nl(e2, Re, t2);
  }],
  ["compositionend", function(t2, e2) {
    const n2 = e2._inputState;
    i ? n2.compositionPhase = "ending-firefox" : l || !a && !d$1 ? Nl(e2, We$2, t2) : (n2.compositionPhase = "ending-safari", n2.compositionEndData = t2.data);
  }],
  ["input", function(t2, e2) {
    t2.stopPropagation();
    const n2 = e2._inputState;
    Jn(n2), Ai(e2, () => {
      qn(t2, e2) || e2.dispatchCommand(Be$2, t2);
    }, { event: t2 }), n2.unprocessedBeforeInputData = null;
  }],
  ["click", function(t2, e2) {
    Ai(e2, () => {
      const n2 = Kr(), o2 = Jl(Il(e2)), r2 = zr();
      if (o2) {
        if (ur(n2)) {
          const t3 = n2.anchor, e3 = t3.getNode();
          "element" === t3.type && 0 === t3.offset && n2.isCollapsed() && !Bi(e3) && 1 === nl().getChildrenSize() && e3.getTopLevelElementOrThrow().isEmpty() && null !== r2 && n2.is(r2) && (o2.removeAllRanges(), n2.dirty = true);
        } else if ("touch" === t2.pointerType || "pen" === t2.pointerType) {
          const n3 = nc(o2, e2._rootElement).anchorNode;
          if (gc(n3) || zs(n3)) ol(Lr(r2, o2, e2, t2));
        }
      }
      if (i && null !== o2 && 0 === o2.rangeCount) {
        const n3 = e2._rootElement;
        if (null !== n3 && t2.target === n3) {
          const i2 = t2.clientY;
          let s2 = n3.childNodes.length;
          for (let t3 = 0; t3 < n3.childNodes.length; t3++) {
            const e3 = n3.childNodes[t3];
            if (gc(e3)) {
              const n4 = e3.getBoundingClientRect();
              if (i2 <= (n4.top + n4.bottom) / 2) {
                s2 = t3;
                break;
              }
            }
          }
          o2.setBaseAndExtent(n3, s2, n3, s2);
          const l2 = Lr(r2, o2, e2, t2);
          null !== l2 ? ol(l2) : o2.removeAllRanges();
        }
      }
      Nl(e2, Ke$2, t2);
    });
  }],
  ["cut", Pn],
  ["copy", Pn],
  ["dragstart", Pn],
  ["dragover", Pn],
  ["dragend", Pn],
  ["paste", Pn],
  ["focus", Pn],
  ["blur", Pn],
  ["drop", Pn]
];
s && In.push(["beforeinput", (t2, e2) => (function(t3, e3) {
  const n2 = t3.inputType;
  if ("deleteCompositionText" === n2 || i && bl(e3)) return;
  if ("insertCompositionText" === n2) return;
  Ai(e3, () => {
    qn(t3, e3) || Nl(e3, ze$2, t3);
  }, { event: t3 });
})(t2, e2)]);
var Ln = /* @__PURE__ */ new WeakMap();
var Kn = /* @__PURE__ */ new WeakMap();
var zn = Dn$1((t2) => (t2.addEventListener("selectionchange", ro), () => t2.removeEventListener("selectionchange", ro)));
function Bn(t2, e2, n2, o2, r2, i2) {
  const l2 = t2.anchor, c2 = t2.focus, a2 = l2.getNode(), u2 = _i();
  let f2;
  if (void 0 !== i2) f2 = i2;
  else {
    const t3 = Jl(Il(u2));
    f2 = null !== t3 ? nc(t3, u2._rootElement) : null;
  }
  const d2 = null !== f2 ? f2.anchorNode : null, h2 = l2.key, g2 = u2.getElementByKey(h2), _2 = n2.length;
  return h2 !== c2.key || !Xo(a2) || (!r2 && (!s || u2._inputState.lastBeforeInputInsertTextTimeStamp < o2 + 50) || a2.isDirty() && _2 < 2 || sl(n2)) && l2.offset !== c2.offset && !a2.isComposing() || Ks(a2) || a2.isDirty() && _2 > 1 || (r2 || !s) && null !== g2 && !a2.isComposing() && d2 !== wc(a2, g2, u2) || null !== f2 && null !== e2 && (!e2.collapsed || e2.startContainer !== f2.anchorNode || e2.startOffset !== f2.anchorOffset) || !a2.isComposing() && (a2.getFormat() !== t2.format || a2.getStyle() !== t2.style) || (function(t3, e3) {
    if (e3.isSegmented()) return true;
    if (!t3.isCollapsed()) return false;
    const n3 = t3.anchor.offset, o3 = e3.getParentOrThrow(), r3 = Ls(e3);
    return 0 === n3 ? !e3.canInsertTextBefore() || !o3.canInsertTextBefore() && !e3.isComposing() || r3 || (function(t4) {
      const e4 = t4.getPreviousSibling();
      return (Xo(e4) || Pi(e4) && e4.isInline()) && !e4.canInsertTextAfter();
    })(e3) : n3 === e3.getTextContentSize() && (!e3.canInsertTextAfter() || !o3.canInsertTextAfter() && !e3.isComposing() || r3);
  })(t2, a2);
}
function Rn(t2, e2) {
  return zs(t2) && null !== t2.nodeValue && 0 !== e2 && e2 !== t2.nodeValue.length;
}
function Wn(e2, n2, o2) {
  const { anchorNode: r2, anchorOffset: i2, focusNode: s2, focusOffset: l2 } = nc(e2, n2._rootElement), c2 = n2._inputState;
  c2.isSelectionChangeFromDOMUpdate && (c2.isSelectionChangeFromDOMUpdate = false, Rn(r2, i2) && Rn(s2, l2) && !c2.postDeleteSelectionToRestore) || Ai(n2, () => {
    if (!o2) return void ol(null);
    if (!As(n2, r2, s2)) return;
    let a2 = Kr();
    if (c2.postDeleteSelectionToRestore && ur(a2) && a2.isCollapsed()) {
      const t2 = a2.anchor, e3 = c2.postDeleteSelectionToRestore.anchor;
      (t2.key === e3.key && t2.offset === e3.offset + 1 || 1 === t2.offset && e3.getNode().is(t2.getNode().getPreviousSibling())) && (a2 = c2.postDeleteSelectionToRestore.clone(), ol(a2));
    }
    if (c2.postDeleteSelectionToRestore = null, ur(a2)) {
      const o3 = a2.anchor, u2 = o3.getNode();
      if (a2.isCollapsed()) {
        "Range" === e2.type && r2 === s2 && (a2.dirty = true);
        const i3 = Il(n2).event, l3 = i3 ? i3.timeStamp : performance.now(), { format: f2, style: d2, offset: h2, key: g2, timeStamp: _2 } = c2.collapsedSelectionFormat, p = nl(), y = false === n2.isComposing() && "" === p.getTextContent();
        if (l3 < _2 + 200 && o3.offset === h2 && o3.key === g2) $n$1(a2, f2, d2);
        else if ("text" === o3.type) Xo(u2) || t(141), Un(a2, u2);
        else if ("element" === o3.type && !y) {
          Pi(u2) || t(259);
          const e3 = o3.getNode();
          e3.isEmpty() ? (function(t2, e4) {
            $n$1(t2, e4.getTextFormat(), e4.getTextStyle());
          })(a2, e3) : $n$1(a2, a2.format, "");
        }
      } else {
        const t2 = o3.key, e3 = a2.focus.key, n3 = a2.getNodes(), r3 = n3.length, s3 = a2.isBackward(), c3 = s3 ? l2 : i2, u3 = s3 ? i2 : l2, f2 = s3 ? e3 : t2, d2 = s3 ? t2 : e3;
        let h2 = 2047, g2 = false;
        for (let t3 = 0; t3 < r3; t3++) {
          const e4 = n3[t3], o4 = e4.getTextContentSize();
          if (Xo(e4) && 0 !== o4 && !(0 === t3 && e4.__key === f2 && c3 === o4 || t3 === r3 - 1 && e4.__key === d2 && 0 === u3) && (g2 = true, h2 &= e4.getFormat(), 0 === h2)) break;
        }
        a2.format = g2 ? h2 : 0;
      }
    }
    Nl(n2, Ie$2);
  });
}
function $n$1(t2, e2, n2) {
  t2.format === e2 && t2.style === n2 || (t2.format = e2, t2.style = n2, t2.dirty = true);
}
function Un(t2, e2) {
  $n$1(t2, e2.getFormat(), e2.getStyle());
}
function Hn(t2) {
  if (!t2.getTargetRanges) return null;
  const e2 = t2.getTargetRanges();
  return 0 === e2.length ? null : e2[0];
}
function jn(t2) {
  const { lastKeyCode: e2 } = _i()._inputState;
  if (null == t2 || t2.length <= 1 || null == e2) return;
  const n2 = 1 === e2.length ? e2 : "Enter" === e2 ? "\n" : "Tab" === e2 ? "	" : null;
  if (!n2) return;
  const o2 = Kr();
  if (!ur(o2) || !o2.isCollapsed()) return;
  const r2 = o2.anchor.getNode();
  if (!Xo(r2)) return;
  const { offset: i2 } = o2.anchor;
  if (r2.getTextContentSize() === i2) {
    const t3 = r2.getNextSibling();
    if ("\n" === n2) {
      if (Yi(t3)) t3.selectEnd();
      else if (!t3) {
        const t4 = qc(r2, Ar), e3 = t4 && t4.getNextSibling();
        Pi(e3) && e3.selectStart();
      }
    } else "	" === n2 ? er(t3) && t3.selectEnd() : Xo(t3) && t3.getTextContent()[0] === n2 && t3.select(1, 1);
  } else r2.getTextContent()[i2] === n2 && r2.select(i2 + 1, i2 + 1);
}
function Jn(t2) {
  t2.isInsertTextAfterHandledSelectionCommand = false, null !== t2.handledSelectionCommandTimeoutId && (clearTimeout(t2.handledSelectionCommandTimeoutId), t2.handledSelectionCommandTimeoutId = null);
}
function Vn(t2) {
  Jn(t2), t2.isInsertTextAfterHandledSelectionCommand = true, t2.handledSelectionCommandTimeoutId = setTimeout(() => Jn(t2), 0);
}
function qn(t2, e2) {
  const n2 = ac(t2);
  if (gc(n2) && Rc(n2, e2)) return true;
  const o2 = e2.getRootElement();
  if (null === o2) return false;
  const r2 = cc(o2.ownerDocument);
  return null !== r2 && o2.contains(r2) && Rc(r2, e2);
}
function Yn(e2) {
  const n2 = e2.inputType, o2 = Hn(e2), r2 = _i(), i2 = r2._inputState, s2 = Kr();
  if ("insertText" === n2 && e2.data && i2.isInsertTextAfterHandledSelectionCommand) {
    if (Jn(i2), e2.preventDefault(), ur(s2) && !s2.isCollapsed()) {
      const t2 = s2.isBackward() ? s2.anchor : s2.focus;
      s2.anchor.set(t2.key, t2.offset, t2.type), s2.focus.set(t2.key, t2.offset, t2.type);
    }
    return true;
  }
  if ("deleteContentBackward" === n2) {
    if (null === s2) {
      const t2 = zr();
      if (!ur(t2)) return true;
      ol(t2.clone());
    }
    if (ur(s2)) {
      const n3 = s2.anchor.key === s2.focus.key;
      if ((function(t2, e3) {
        return "MediaLast" === t2.lastKeyCode && e3 < t2.lastKeyDownTimeStamp + 30;
      })(i2, e2.timeStamp) && r2.isComposing() && n3) {
        if (Vs(null), i2.lastKeyDownTimeStamp = 0, setTimeout(() => {
          Ai(r2, () => {
            Vs(null);
          });
        }, 30), ur(s2)) {
          const e3 = s2.anchor.getNode();
          e3.markDirty(), Xo(e3) || t(142), Un(s2, e3);
        }
      } else {
        if (Vs(null), l && null !== o2 && !o2.collapsed && (s2.applyDOMRange(o2), !s2.isCollapsed())) return e2.preventDefault(), s2.removeText(), true;
        e2.preventDefault();
        const t2 = s2.anchor.getNode(), c3 = t2.getTextContent(), a3 = t2.canInsertTextAfter(), u3 = 0 === s2.anchor.offset && s2.focus.offset === c3.length;
        let d3 = f && n3 && !u3 && a3;
        if (d3 && s2.isCollapsed() && (d3 = !Ki(kl(s2.anchor, true))), !d3) {
          Nl(r2, $e$2, true);
          const t3 = Kr();
          f && ur(t3) && t3.isCollapsed() && (i2.postDeleteSelectionToRestore = t3, setTimeout(() => i2.postDeleteSelectionToRestore = null));
        }
      }
      return true;
    }
  }
  if (!ur(s2)) return true;
  const c2 = e2.data;
  null !== i2.unprocessedBeforeInputData && ul(false, r2, i2.unprocessedBeforeInputData), s2.dirty && null === i2.unprocessedBeforeInputData || !s2.isCollapsed() || Bi(s2.anchor.getNode()) || null === o2 || s2.applyDOMRange(o2), i2.unprocessedBeforeInputData = null;
  const a2 = s2.anchor, u2 = s2.focus, d2 = a2.getNode(), h2 = u2.getNode();
  if ("insertText" === n2 || "insertTranspose" === n2) {
    if ("\n" === c2) e2.preventDefault(), Nl(r2, Ue$2, false);
    else if (c2 === D$1) e2.preventDefault(), Nl(r2, He$2);
    else if (null == c2 && e2.dataTransfer) {
      const t2 = e2.dataTransfer.getData("text/plain");
      e2.preventDefault(), s2.insertRawText(t2);
    } else null != c2 && Bn(s2, o2, c2, e2.timeStamp, true) ? (e2.preventDefault(), Nl(r2, je$2, c2), jn(c2)) : i2.unprocessedBeforeInputData = c2;
    return i2.lastBeforeInputInsertTextTimeStamp = e2.timeStamp, true;
  }
  switch (e2.preventDefault(), n2) {
    case "insertFromYank":
    case "insertFromDrop":
    case "insertReplacementText":
      Nl(r2, je$2, e2);
      jn((e2.dataTransfer ? e2.dataTransfer.getData("text/plain") : null) ?? e2.data);
      break;
    case "insertFromComposition": {
      const t2 = i2.hadOrphanedCompositionEvents;
      i2.hadOrphanedCompositionEvents = false;
      const n3 = r2._compositionKey;
      Vs(null), t2 || Nl(r2, je$2, e2), Zn(n3);
      break;
    }
    case "insertLineBreak":
      Vs(null), Nl(r2, Ue$2, false);
      break;
    case "insertParagraph":
      Vs(null), i2.isInsertLineBreak && !l ? (i2.isInsertLineBreak = false, Nl(r2, Ue$2, false)) : Nl(r2, He$2);
      break;
    case "insertFromPaste":
    case "insertFromPasteAsQuotation":
      Nl(r2, Je$2, e2);
      break;
    case "deleteByComposition":
      (function(t2, e3) {
        return t2 !== e3 || Pi(t2) || Pi(e3) || !Ls(t2) || !Ls(e3);
      })(d2, h2) && Nl(r2, Ve$2, e2);
      break;
    case "deleteByDrag":
      Al(No), Nl(r2, Ve$2, e2);
      break;
    case "deleteByCut":
      Nl(r2, Ve$2, e2);
      break;
    case "deleteContent":
      Nl(r2, $e$2, false);
      break;
    case "deleteWordBackward":
      Nl(r2, qe$2, true);
      break;
    case "deleteWordForward":
      Nl(r2, qe$2, false);
      break;
    case "deleteHardLineBackward":
    case "deleteSoftLineBackward":
      Nl(r2, Ye$1, true);
      break;
    case "deleteContentForward":
    case "deleteHardLineForward":
    case "deleteSoftLineForward":
      Nl(r2, Ye$1, false);
      break;
    case "formatStrikeThrough":
      Nl(r2, Ge$2, "strikethrough");
      break;
    case "formatBold":
      Nl(r2, Ge$2, "bold");
      break;
    case "formatItalic":
      Nl(r2, Ge$2, "italic");
      break;
    case "formatUnderline":
      Nl(r2, Ge$2, "underline");
      break;
    case "historyUndo":
      Nl(r2, Qe$2);
      break;
    case "historyRedo":
      Nl(r2, Ze$2);
  }
  return true;
}
function Gn(t2) {
  const e2 = _i(), n2 = e2._inputState, o2 = Kr(), r2 = t2.data, l2 = Hn(t2);
  let c2 = false;
  if (null != r2 && ur(o2)) {
    const a2 = Jl(Il(e2)), u2 = null !== a2 ? nc(a2, e2._rootElement) : null, d2 = "insertCompositionText" === t2.inputType && "ending-firefox" !== n2.compositionPhase && !e2.isComposing();
    d2 && (n2.hadOrphanedCompositionEvents = true);
    const h2 = o2.anchor.getNode(), g2 = "insertCompositionText" === t2.inputType && "ending-firefox" !== n2.compositionPhase && e2.isComposing() && Xo(h2) && Ks(h2);
    if (!d2 && !g2 && Bn(o2, l2, r2, t2.timeStamp, false, u2)) {
      if (c2 = true, "ending-firefox" === n2.compositionPhase) {
        const t3 = to(e2, r2);
        if (n2.compositionPhase = "idle", t3) return Al(wo), rl(), true;
      }
      const l3 = o2.anchor.getNode();
      if (null === a2 || null === u2) return true;
      const d3 = o2.isBackward(), h3 = d3 ? o2.anchor.offset : o2.focus.offset, g3 = d3 ? o2.focus.offset : o2.anchor.offset;
      s && !o2.isCollapsed() && Xo(l3) && null !== u2.anchorNode && l3.getTextContent().slice(0, h3) + r2 + l3.getTextContent().slice(h3 + g3) === al(u2.anchorNode) || Nl(e2, je$2, r2);
      const _2 = r2.length;
      i && _2 > 1 && "insertCompositionText" === t2.inputType && !e2.isComposing() && (o2.anchor.offset -= _2, o2._cachedNodes = null, o2._cachedIsBackward = null), f && e2.isComposing() && (n2.lastKeyDownTimeStamp = 0, Vs(null));
    }
  }
  if (!c2) ul(false, e2, null !== r2 ? r2 : void 0), "ending-firefox" === n2.compositionPhase && (to(e2, r2 || void 0), Al("composition-end"), n2.compositionPhase = "idle");
  return rl(), true;
}
function Xn(t2) {
  const e2 = _i(), n2 = e2._inputState, o2 = Kr();
  if (ur(o2) && !e2.isComposing()) {
    n2.compositionPhase = "composing", n2.hadOrphanedCompositionEvents = false;
    const r2 = o2.anchor, i2 = o2.anchor.getNode();
    if (Vs(r2.key), Al("composition-start"), t2.timeStamp < n2.lastKeyDownTimeStamp + 30 || "element" === r2.type || !o2.isCollapsed() || !f && (i2.getFormat() !== o2.format || Xo(i2) && i2.getStyle() !== o2.style) || Xo(i2) && (Ks(i2) || 0 === r2.offset && !i2.canInsertTextBefore() || r2.offset === i2.getTextContentSize() && !i2.canInsertTextAfter())) {
      Nl(e2, je$2, F);
      const t3 = Kr();
      ur(t3) && Vs(t3.anchor.key);
    }
  }
  return true;
}
function Qn(t2) {
  const e2 = _i();
  return e2._inputState.compositionPhase = "idle", to(e2, t2.data), Al(wo), true;
}
function Zn(t2) {
  if (null === t2) return;
  const e2 = Ys(t2);
  if (!Xo(e2) || "text" === e2.getType() || Ks(e2) || !e2.isAttached()) return;
  const n2 = Kr(), o2 = ur(n2) && n2.anchor.key === t2 ? n2.anchor.offset : null, r2 = Go(e2.getTextContent());
  if (r2.setFormat(e2.getFormat()), r2.setStyle(e2.getStyle()), e2.replace(r2), null !== o2) {
    const t3 = Math.min(o2, r2.getTextContentSize());
    r2.select(t3, t3);
  }
}
function to(t2, e2) {
  const n2 = t2._compositionKey;
  if (Vs(null), null !== n2 && null != e2) {
    if ("" === e2) {
      const e3 = Ys(n2), o3 = t2.getElementByKey(n2), r2 = null !== o3 && Xo(e3) ? wc(e3, o3, t2) : null;
      if (null !== r2 && null !== r2.nodeValue && Xo(e3)) {
        const n3 = Jl(Il(t2)), o4 = n3 && nc(n3, t2._rootElement);
        let i2 = null, s2 = null;
        null !== o4 && o4.anchorNode === r2 && (i2 = o4.anchorOffset, s2 = o4.focusOffset), fl(e3, r2.nodeValue, i2, s2, true);
      }
      return Zn(n2), false;
    }
    if ("\n" === e2[e2.length - 1]) {
      const e3 = Kr();
      if (ur(e3) || dr(e3)) {
        if (ur(e3)) {
          const t3 = e3.focus;
          e3.anchor.set(t3.key, t3.offset, t3.type);
        }
        return Nl(t2, cn$1, null), Zn(n2), false;
      }
    }
    const o2 = Ys(n2);
    if (null !== o2 && Xo(o2) && Ks(o2)) {
      o2.markDirty();
      const t3 = Kr(), r2 = o2.getTextContentSize(), i2 = ur(t3) && t3.anchor.key === n2 ? t3.anchor.offset : r2;
      return o2.select(i2, i2).insertText(e2), true;
    }
  }
  return ul(true, t2, e2), Zn(n2), false;
}
function eo(t2) {
  const e2 = _i(), n2 = e2._inputState;
  if (null == t2.key) return true;
  if ("ending-safari" === n2.compositionPhase) {
    const o2 = ml(t2);
    if (o2 && Ai(e2, () => {
      to(e2, n2.compositionEndData);
    }), n2.compositionPhase = "idle", n2.compositionEndData = "", o2) return true;
  }
  if ((function(t3) {
    return _l(t3, "ArrowRight", { shiftKey: "any" });
  })(t2)) Nl(e2, en$3, t2);
  else if ((function(t3) {
    return _l(t3, "ArrowRight", {
      ...pl,
      shiftKey: "any"
    });
  })(t2)) Nl(e2, nn$2, t2);
  else if ((function(t3) {
    return _l(t3, "ArrowLeft", { shiftKey: "any" });
  })(t2)) Nl(e2, on$1, t2);
  else if ((function(t3) {
    return _l(t3, "ArrowLeft", {
      ...pl,
      shiftKey: "any"
    });
  })(t2)) Nl(e2, rn$1, t2);
  else if ((function(t3) {
    return _l(t3, "ArrowUp", {
      altKey: "any",
      shiftKey: "any"
    });
  })(t2)) Nl(e2, sn$2, t2);
  else if ((function(t3) {
    return _l(t3, "ArrowDown", {
      altKey: "any",
      shiftKey: "any"
    });
  })(t2)) Nl(e2, ln$2, t2);
  else if ((function(t3) {
    return _l(t3, "Enter", {
      altKey: "any",
      ctrlKey: "any",
      metaKey: "any",
      shiftKey: true
    });
  })(t2)) n2.isInsertLineBreak = true, Nl(e2, cn$1, t2);
  else if ((function(t3) {
    return " " === t3.key;
  })(t2)) Nl(e2, an$1, t2);
  else if ((function(t3) {
    return r$1 && _l(t3, "o", { ctrlKey: true });
  })(t2)) t2.preventDefault(), n2.isInsertLineBreak = true, Nl(e2, Ue$2, true);
  else if ((function(t3) {
    return _l(t3, "Enter", {
      altKey: "any",
      ctrlKey: "any",
      metaKey: "any"
    });
  })(t2)) n2.isInsertLineBreak = false, Nl(e2, cn$1, t2);
  else if ((function(t3) {
    return _l(t3, "Backspace", { shiftKey: "any" }) || r$1 && _l(t3, "h", { ctrlKey: true });
  })(t2)) ml(t2) ? Nl(e2, un$2, t2) && Vn(n2) : (t2.preventDefault(), Nl(e2, $e$2, true));
  else if ((function(t3) {
    return "Escape" === t3.key;
  })(t2)) Nl(e2, fn$1, t2);
  else if ((function(t3) {
    return _l(t3, "Delete", {}) || r$1 && _l(t3, "d", { ctrlKey: true });
  })(t2)) !(function(t3) {
    return "Delete" === t3.key;
  })(t2) ? (t2.preventDefault(), Nl(e2, $e$2, false)) : Nl(e2, dn$1, t2);
  else if ((function(t3) {
    return _l(t3, "Backspace", yl);
  })(t2)) t2.preventDefault(), Nl(e2, qe$2, true);
  else if ((function(t3) {
    return _l(t3, "Delete", yl);
  })(t2)) t2.preventDefault(), Nl(e2, qe$2, false);
  else if ((function(t3) {
    return r$1 && _l(t3, "Backspace", { metaKey: true });
  })(t2)) t2.preventDefault(), Nl(e2, Ye$1, true);
  else if ((function(t3) {
    return r$1 && (_l(t3, "Delete", { metaKey: true }) || _l(t3, "k", { ctrlKey: true }));
  })(t2)) t2.preventDefault(), Nl(e2, Ye$1, false);
  else if ((function(t3) {
    return _l(t3, "b", pl);
  })(t2)) t2.preventDefault(), Nl(e2, Ge$2, "bold");
  else if ((function(t3) {
    return _l(t3, "u", pl);
  })(t2)) t2.preventDefault(), Nl(e2, Ge$2, "underline");
  else if ((function(t3) {
    return _l(t3, "i", pl);
  })(t2)) t2.preventDefault(), Nl(e2, Ge$2, "italic");
  else if ((function(t3) {
    return _l(t3, "Tab", { shiftKey: "any" });
  })(t2)) Nl(e2, hn$2, t2);
  else if ((function(t3) {
    return _l(t3, "z", pl);
  })(t2)) t2.preventDefault(), Nl(e2, Qe$2);
  else if ((function(t3) {
    if (r$1) return _l(t3, "z", {
      metaKey: true,
      shiftKey: true
    });
    return _l(t3, "y", { ctrlKey: true }) || _l(t3, "z", {
      ctrlKey: true,
      shiftKey: true
    });
  })(t2)) t2.preventDefault(), Nl(e2, Ze$2);
  else {
    const o2 = e2._editorState._selection;
    !(function(t3) {
      return _l(t3, "a", pl);
    })(t2) ? null === o2 || ur(o2) || (!(function(t3) {
      return _l(t3, "c", pl);
    })(t2) ? (function(t3) {
      return _l(t3, "x", pl);
    })(t2) && (t2.preventDefault(), Nl(e2, Tn, t2)) : (t2.preventDefault(), Nl(e2, vn$2, t2))) : (t2.preventDefault(), Nl(e2, kn, t2) && Vn(n2));
  }
  return (function(t3) {
    return t3.ctrlKey || t3.shiftKey || t3.altKey || t3.metaKey;
  })(t2) && e2.dispatchCommand(An, t2), true;
}
function no(t2) {
  let e2 = t2.__lexicalEventHandles;
  return void 0 === e2 && (e2 = [], t2.__lexicalEventHandles = e2), e2;
}
var oo = /* @__PURE__ */ new Map();
function ro(t2) {
  const e2 = Vl(t2.target);
  if (null === e2) return;
  const n2 = Ol(t2.target);
  let o2 = null, r2 = null;
  const i2 = null !== n2 ? Kn.get(n2) : void 0;
  if (null !== n2) {
    if (void 0 !== i2) {
      const t3 = i2.editors;
      let n3 = i2.hasShadowEditor;
      if (void 0 === n3) {
        n3 = false;
        for (const e3 of t3) if (null !== e3._rootElement && ql(e3._rootElement.getRootNode())) {
          n3 = true;
          break;
        }
        i2.hasShadowEditor = n3;
      }
      if (n3) {
        let n4 = null, i3 = null;
        for (const s3 of t3) {
          const t4 = s3._rootElement;
          if (null === t4) continue;
          const l3 = nc(e2, t4).anchorNode;
          if (null !== l3 && Fs(l3) === s3) {
            if (ql(t4.getRootNode())) {
              o2 = s3, r2 = l3;
              break;
            }
            null === n4 && (n4 = s3, i3 = l3);
          }
        }
        null === o2 && null !== n4 && (o2 = n4, r2 = i3);
      } else {
        const t4 = e2.anchorNode;
        null === t4 || gc(t4) && null !== t4.shadowRoot || (o2 = Fs(t4), null !== o2 && (r2 = t4));
      }
    }
    if (null === o2) {
      const t3 = cc(n2);
      o2 = null !== t3 ? Fs(t3) : null;
    }
  }
  if (null === o2) return;
  if (o2._inputState.isSelectionChangeFromMouseDown) {
    if (void 0 !== i2) for (const t3 of i2.editors) t3._inputState.isSelectionChangeFromMouseDown = false;
    Ai(o2, () => {
      const n3 = zr(), i3 = r2 ?? nc(e2, o2._rootElement).anchorNode;
      if (gc(i3) || zs(i3)) ol(Lr(n3, e2, o2, t2));
    });
  }
  const s2 = ll(o2), l2 = s2[s2.length - 1], c2 = l2._key, a2 = oo.get(c2), u2 = a2 || l2;
  u2 !== o2 && Wn(e2, u2, false), Wn(e2, o2, true), o2 !== l2 ? oo.set(c2, o2) : a2 && oo.delete(c2);
}
function io(t2) {
  t2._lexicalHandled = true;
}
function so(t2) {
  return true === t2._lexicalHandled;
}
function co(e2) {
  const n2 = Ln.get(e2);
  if (void 0 === n2) return void 0;
  const o2 = Kn.get(n2);
  if (void 0 === o2) return void 0;
  Ln.delete(e2);
  const r2 = Ps(e2);
  Ds(r2) ? ((function(t2) {
    if (null !== t2._parentEditor) {
      const e3 = ll(t2), n3 = e3[e3.length - 1]._key;
      oo.get(n3) === t2 && oo.delete(n3);
    } else oo.delete(t2._key);
  })(r2), o2.editors.delete(r2), o2.hasShadowEditor = void 0, e2.__lexicalEditor = null) : r2 && t(198);
  const i2 = no(e2);
  for (let t2 = 0; t2 < i2.length; t2++) i2[t2]();
  e2.__lexicalEventHandles = [];
}
function ao(e2, n2, o2) {
  fi();
  const r2 = e2.__key, i2 = e2.getParent();
  if (null === i2) return void (null !== ta(e2) && t(367, r2, String(ta(e2))));
  const s2 = (function(t2) {
    const e3 = Kr();
    if (!ur(e3) || !Pi(t2)) return e3;
    const { anchor: n3, focus: o3 } = e3, r3 = n3.getNode(), i3 = o3.getNode();
    Fl(r3, t2) && n3.set(t2.__key, 0, "element");
    Fl(i3, t2) && o3.set(t2.__key, 0, "element");
    return e3;
  })(e2);
  let l2 = false;
  if (ur(s2) && n2) {
    const t2 = s2.anchor, n3 = s2.focus;
    t2.key === r2 && (Wr(t2, e2, i2, e2.getPreviousSibling(), e2.getNextSibling()), l2 = true), n3.key === r2 && (Wr(n3, e2, i2, e2.getPreviousSibling(), e2.getNextSibling()), l2 = true);
  } else dr(s2) && n2 && e2.isSelected() && e2.selectPrevious();
  if (ur(s2) && n2 && !l2) {
    const t2 = e2.getIndexWithinParent();
    Hs(e2), Br(s2, i2, t2, -1);
  } else Hs(e2);
  o2 || Bl(i2) || i2.canBeEmpty() || !i2.isEmpty() || ao(i2, n2), n2 && s2 && Bi(i2) && i2.isEmpty() && i2.selectEnd();
}
var fo = Symbol.for("ephemeral");
function ho(t2) {
  return t2[fo] || false;
}
var go = {
  configurable: true,
  enumerable: false,
  value: void 0,
  writable: true
};
var _o = class {
  __type;
  __key;
  __parent;
  __prev;
  __next;
  __state;
  [Kt$2];
  static getType() {
    const { ownNodeType: e2 } = Hc(this);
    return void 0 === e2 && t(64, this.name), e2;
  }
  static clone(e2) {
    t(65, this.name);
  }
  $config() {
    return {};
  }
  config(t2, e2) {
    const n2 = e2.extends || Gc(this.constructor);
    return Object.assign(e2, { extends: n2 }), "string" == typeof t2 && Object.assign(e2, { type: t2 }), { [t2]: e2 };
  }
  afterCloneFrom(t2) {
    this.__key === t2.__key ? (this.__parent = t2.__parent, this.__next = t2.__next, this.__prev = t2.__prev, this.__state = t2.__state) : t2.__state && (this.__state = t2.__state.getWritable(this));
  }
  resetOnCopyNodeFrom(t2) {
    this.__state && (this.__state = this.__state.getWritable(this).resetOnCopyNode());
  }
  static importDOM;
  constructor(t2) {
    this.__type = this.constructor.getType(), this.__parent = null, this.__prev = null, this.__next = null, Object.defineProperty(this, "__state", go), Object.defineProperty(this, Kt$2, go), Us(this, t2);
  }
  getType() {
    return this.__type;
  }
  isInline() {
    t(137, this.constructor.name);
  }
  isAttached() {
    let t2 = this.__key;
    for (; null !== t2; ) {
      if ("root" === t2) return true;
      const e2 = Ys(t2);
      if (null === e2) break;
      t2 = null !== e2.__parent ? e2.__parent : ta(e2);
    }
    return false;
  }
  isSelected(t2) {
    const e2 = t2 || Kr();
    if (null == e2) return false;
    const n2 = e2.getNodes().some((t3) => t3.__key === this.__key);
    if (Xo(this)) return n2;
    if (ur(e2) && "element" === e2.anchor.type && "element" === e2.focus.type) {
      if (e2.isCollapsed()) return false;
      const t3 = this.getParent();
      if (Ki(this) && this.isInline() && t3) {
        const n3 = e2.isBackward() ? e2.focus : e2.anchor;
        if (t3.is(n3.getNode()) && n3.offset === t3.getChildrenSize() && this.is(t3.getLastChild())) return false;
      }
    }
    return n2;
  }
  getKey() {
    return this.__key;
  }
  getIndexWithinParent() {
    const t2 = this.getParent();
    if (null === t2) return -1;
    let e2 = t2.getFirstChild(), n2 = 0;
    for (; null !== e2; ) {
      if (this.is(e2)) return n2;
      n2++, e2 = e2.getNextSibling();
    }
    return -1;
  }
  getParent() {
    const t2 = this.getLatest().__parent;
    return null === t2 ? null : Ys(t2);
  }
  getParentOrThrow() {
    const e2 = this.getParent();
    return null === e2 && t(66, this.__key), e2;
  }
  getTopLevelElement() {
    let e2 = this;
    for (; null !== e2; ) {
      const n2 = e2.getParent();
      if (Bl(n2) || null !== ta(e2)) return Pi(e2) || e2 === this && Ki(e2) || t(194), e2;
      e2 = n2;
    }
    return null;
  }
  getTopLevelElementOrThrow() {
    const e2 = this.getTopLevelElement();
    return null === e2 && t(67, this.__key), e2;
  }
  getParents() {
    const t2 = [];
    let e2 = this.getParent();
    for (; null !== e2; ) t2.push(e2), e2 = e2.getParent();
    return t2;
  }
  getParentKeys() {
    const t2 = [];
    let e2 = this.getParent();
    for (; null !== e2; ) t2.push(e2.__key), e2 = e2.getParent();
    return t2;
  }
  getPreviousSibling() {
    const t2 = this.getLatest().__prev;
    return null === t2 ? null : Ys(t2);
  }
  getPreviousSiblings() {
    const t2 = [], e2 = this.getParent();
    if (null === e2) return t2;
    let n2 = e2.getFirstChild();
    for (; null !== n2 && !n2.is(this); ) t2.push(n2), n2 = n2.getNextSibling();
    return t2;
  }
  getNextSibling() {
    const t2 = this.getLatest().__next;
    return null === t2 ? null : Ys(t2);
  }
  getNextSiblings() {
    const t2 = [];
    let e2 = this.getNextSibling();
    for (; null !== e2; ) t2.push(e2), e2 = e2.getNextSibling();
    return t2;
  }
  getCommonAncestor(t2) {
    const e2 = Pi(this) ? this : this.getParent(), n2 = Pi(t2) ? t2 : t2.getParent(), o2 = e2 && n2 ? Za(e2, n2) : null;
    return o2 ? o2.commonAncestor : null;
  }
  is(t2) {
    return null != t2 && this.__key === t2.__key;
  }
  isBefore(e2) {
    const n2 = Za(this, e2);
    return null !== n2 && ("descendant" === n2.type || ("branch" === n2.type ? -1 === Ga(n2) : ("same" !== n2.type && "ancestor" !== n2.type && t(279), false)));
  }
  isParentOf(t2) {
    return Fl(t2, this);
  }
  getNodesBetween(e2) {
    const n2 = this.isBefore(e2), o2 = [], r2 = /* @__PURE__ */ new Set();
    let i2 = this;
    for (; null !== i2; ) {
      const s2 = i2.__key;
      if (r2.has(s2) || (r2.add(s2), o2.push(i2)), i2 === e2) break;
      const l2 = Pi(i2) ? n2 ? i2.getFirstChild() : i2.getLastChild() : null;
      if (null !== l2) {
        i2 = l2;
        continue;
      }
      const c2 = n2 ? i2.getNextSibling() : i2.getPreviousSibling();
      if (null !== c2) {
        i2 = c2;
        continue;
      }
      const a2 = i2.getParentOrThrow();
      if (r2.has(a2.__key) || o2.push(a2), a2 === e2) break;
      let u2 = null, f2 = a2;
      do {
        if (null === f2 && t(68), u2 = n2 ? f2.getNextSibling() : f2.getPreviousSibling(), f2 = f2.getParent(), null === f2) break;
        null !== u2 || r2.has(f2.__key) || o2.push(f2);
      } while (null === u2);
      i2 = u2;
    }
    return n2 || o2.reverse(), o2;
  }
  isDirty() {
    const t2 = _i()._dirtyLeaves;
    return null !== t2 && t2.has(this.__key);
  }
  getLatest() {
    if (ho(this)) return this;
    const e2 = Ys(this.__key);
    return null === e2 && t(113), e2;
  }
  getWritable() {
    if (ho(this)) return this;
    fi();
    const t2 = hi(), e2 = _i(), n2 = t2._nodeMap, o2 = this.__key, r2 = this.getLatest(), i2 = e2._cloneNotNeeded, s2 = Kr();
    if (null !== s2 && s2.setCachedNodes(null), i2.has(o2)) return Js(r2), r2;
    const l2 = Dc(r2);
    return i2.add(o2), Js(l2), n2.set(o2, l2), l2;
  }
  getTextContent() {
    return ha(this);
  }
  getTextContentSize() {
    return this.getTextContent().length;
  }
  createDOM(e2, n2) {
    t(70);
  }
  updateDOM(e2, n2, o2) {
    t(71);
  }
  getDOMSlot(t2) {
    return new q(t2);
  }
  exportDOM(t2) {
    return { element: this.createDOM(t2._config, t2) };
  }
  exportJSON() {
    const t2 = this.__state ? this.__state.toJSON() : void 0;
    return {
      type: this.__type,
      version: 1,
      ...t2
    };
  }
  static importJSON(e2) {
    t(18, this.name);
  }
  updateFromJSON(t2) {
    return (function(t3, e2) {
      const n2 = t3.getWritable(), o2 = e2.$;
      let r2 = o2;
      for (const t4 of Nt$1(n2).flatKeys) t4 in e2 && (void 0 !== r2 && r2 !== o2 || (r2 = { ...o2 }), r2[t4] = e2[t4]);
      return (n2.__state || r2) && bt$2(t3).updateFromJSON(r2), n2;
    })(this, t2);
  }
  static transform() {
    return null;
  }
  remove(t2) {
    ao(this, true, t2);
  }
  replace(e2, n2) {
    fi();
    let o2 = Kr();
    null !== o2 && (o2 = o2.clone()), $l(this, e2);
    const r2 = this.getLatest(), i2 = this.__key, s2 = e2.__key, l2 = e2.getWritable(), c2 = this.getParentOrThrow().getWritable(), a2 = c2.__size, u2 = l2.getParent(), f2 = null !== u2 ? l2.getIndexWithinParent() : -1;
    Hs(l2), null !== u2 && ur(o2) && Br(o2, u2, f2, -1);
    const d2 = r2.getPreviousSibling(), h2 = r2.getNextSibling(), g2 = r2.__prev, _2 = r2.__next, p = r2.__parent;
    if (ao(r2, false, true), null === d2) c2.__first = s2;
    else d2.getWritable().__next = s2;
    if (l2.__prev = g2, null === h2) c2.__last = s2;
    else h2.getWritable().__prev = s2;
    l2.__next = _2, l2.__parent = p, c2.__size = a2;
    let y = 0;
    n2 && (Pi(this) && Pi(l2) || t(139), y = l2.getChildrenSize(), l2.splice(y, 0, this.getChildren()));
    const m = ia(this);
    if (m.length > 0) {
      Qc(this) && Qc(l2) || t(368, this.__key, l2.__key);
      for (const t2 of m) {
        const e3 = sa(this, t2);
        null !== e3 && (ya(this, t2), pa(l2, t2, e3));
      }
    }
    if (ur(o2)) {
      ol(o2);
      const t2 = o2.anchor, e3 = o2.focus;
      t2.key === i2 && (n2 && "element" === t2.type ? t2.set(l2.__key, y + t2.offset, "element") : ir(t2, l2)), e3.key === i2 && (n2 && "element" === e3.type ? e3.set(l2.__key, y + e3.offset, "element") : ir(e3, l2));
    }
    return qs() === i2 && Vs(s2), l2;
  }
  insertAfter(t2, e2 = true) {
    fi(), $l(this, t2);
    const n2 = this.getWritable(), o2 = t2.getWritable();
    this.getParentOrThrow();
    const r2 = o2.getParent(), i2 = Kr();
    let s2 = false, l2 = false;
    if (null !== r2) {
      const n3 = t2.getIndexWithinParent();
      if (ur(i2)) {
        const t3 = r2.__key, e3 = i2.anchor, o3 = i2.focus;
        s2 = "element" === e3.type && e3.key === t3 && e3.offset === n3 + 1, l2 = "element" === o3.type && o3.key === t3 && o3.offset === n3 + 1;
      }
      Hs(o2), e2 && ur(i2) && Br(i2, r2, n3, -1);
    } else Hs(o2);
    const c2 = this.getNextSibling(), a2 = this.getParentOrThrow().getWritable(), u2 = o2.__key, f2 = n2.__next;
    if (null === c2) a2.__last = u2;
    else c2.getWritable().__prev = u2;
    if (a2.__size++, n2.__next = u2, o2.__next = f2, o2.__prev = n2.__key, o2.__parent = n2.__parent, e2 && ur(i2)) {
      const t3 = this.getIndexWithinParent();
      Br(i2, a2, t3 + 1);
      const e3 = a2.__key;
      s2 && i2.anchor.set(e3, t3 + 2, "element"), l2 && i2.focus.set(e3, t3 + 2, "element");
    }
    return t2;
  }
  insertBefore(t2, e2 = true) {
    fi(), $l(this, t2);
    const n2 = this.getWritable(), o2 = t2.getWritable();
    this.getParentOrThrow();
    const r2 = o2.__key, i2 = Kr(), s2 = o2.getParent(), l2 = null !== s2 ? o2.getIndexWithinParent() : -1;
    Hs(o2), null !== s2 && e2 && ur(i2) && Br(i2, s2, l2, -1);
    const c2 = this.getPreviousSibling(), a2 = this.getParentOrThrow().getWritable(), u2 = n2.__prev, f2 = this.getIndexWithinParent();
    if (null === c2) a2.__first = r2;
    else c2.getWritable().__next = r2;
    if (a2.__size++, n2.__prev = r2, o2.__prev = u2, o2.__next = n2.__key, o2.__parent = n2.__parent, e2 && ur(i2)) Br(i2, this.getParentOrThrow(), f2);
    return t2;
  }
  isParentRequired() {
    return false;
  }
  createParentElementNode() {
    return es();
  }
  selectStart() {
    return this.selectPrevious();
  }
  selectEnd() {
    return this.selectNext(0, 0);
  }
  selectPrevious(t2, e2) {
    fi();
    const n2 = ea(this);
    if (null !== n2) return n2.selectPrevious(t2, e2);
    const o2 = this.getPreviousSibling(), r2 = this.getParentOrThrow();
    if (null === o2) return r2.select(0, 0);
    if (Pi(o2)) return o2.select();
    if (!Xo(o2)) {
      const t3 = o2.getIndexWithinParent() + 1;
      return r2.select(t3, t3);
    }
    return o2.select(t2, e2);
  }
  selectNext(t2, e2) {
    fi();
    const n2 = ea(this);
    if (null !== n2) return n2.selectNext(t2, e2);
    const o2 = this.getNextSibling(), r2 = this.getParentOrThrow();
    if (null === o2) return r2.select();
    if (Pi(o2)) return o2.select(0, 0);
    if (!Xo(o2)) {
      const t3 = o2.getIndexWithinParent();
      return r2.select(t3, t3);
    }
    return o2.select(t2, e2);
  }
  markDirty() {
    this.getWritable();
  }
  reconcileObservedMutation(t2, e2) {
    this.markDirty();
  }
};
function po(t2) {
  return t2 instanceof _o;
}
var mo = "history-push";
var xo = "history-merge";
var Co = "paste";
var bo = "skip-dom-selection";
var No = "skip-selection-focus";
var wo = "composition-end";
var Oo = "!important";
function Mo(t2) {
  const e2 = {};
  if (!t2) return e2;
  let n2 = "", o2 = "", r2 = null, i2 = false, s2 = false, l2 = false, c2 = 0;
  const a2 = t2.length;
  let u2 = -1;
  for (let f3 = 0; f3 < a2; f3++) {
    const a3 = t2[f3];
    if (i2) "*" === a3 && "/" === t2[f3 + 1] && (i2 = false, f3++);
    else if (s2) -1 === u2 && (u2 = f3), s2 = false;
    else if (null === r2) if ("/" !== a3 || "*" !== t2[f3 + 1]) if ('"' !== a3 && "'" !== a3) if ("(" !== a3) if (")" !== a3) if (l2 || ":" !== a3 || 0 !== c2) {
      if (";" === a3 && 0 === c2) {
        -1 !== u2 && (l2 ? o2 += t2.slice(u2, f3) : n2 += t2.slice(u2, f3), u2 = -1);
        const r3 = n2.trim(), i3 = o2.trim();
        "" !== r3 && "" !== i3 && (e2[r3] = i3), n2 = "", o2 = "", l2 = false;
        continue;
      }
      -1 === u2 && (u2 = f3);
    } else -1 !== u2 && (n2 += t2.slice(u2, f3), u2 = -1), l2 = true;
    else -1 === u2 && (u2 = f3), c2 = Math.max(0, c2 - 1);
    else -1 === u2 && (u2 = f3), c2++;
    else -1 === u2 && (u2 = f3), r2 = a3;
    else -1 !== u2 && (l2 ? o2 += t2.slice(u2, f3) : n2 += t2.slice(u2, f3), u2 = -1), i2 = true, f3++;
    else -1 === u2 && (u2 = f3), "\\" === a3 ? s2 = true : a3 === r2 && (r2 = null);
  }
  -1 !== u2 && (l2 ? o2 += t2.slice(u2, a2) : n2 += t2.slice(u2, a2));
  const f2 = n2.trim(), d2 = o2.trim();
  return "" !== f2 && "" !== d2 && (e2[f2] = d2), e2;
}
function Ao(t2, e2, n2) {
  const o2 = n2.trimEnd(), r2 = o2.length - 10;
  r2 >= 0 && o2.slice(r2).toLowerCase() === Oo ? t2.setProperty(e2, o2.slice(0, r2).trim(), "important") : t2.setProperty(e2, n2, "");
}
function Fo(t2, e2, n2 = "") {
  if (e2 === n2) return;
  const o2 = Mo(n2), r2 = Mo(e2);
  for (const e3 in r2) delete o2[e3], Ao(t2, e3, r2[e3]);
  for (const e3 in o2) t2.removeProperty(e3);
}
function Po(t2, e2) {
  return 16 & e2 ? "code" : e2 & 128 ? "mark" : 32 & e2 ? "sub" : 64 & e2 ? "sup" : null;
}
function Io(t2, e2) {
  return 1 & e2 ? "strong" : 2 & e2 ? "em" : "span";
}
function Lo(t2, e2, n2, o2, r2) {
  const i2 = o2.classList;
  let s2 = Cl(r2, "base");
  void 0 !== s2 && i2.add(...s2), s2 = Cl(r2, "underlineStrikethrough");
  let l2 = false;
  const c2 = 8 & e2 && 4 & e2;
  void 0 !== s2 && (8 & n2 && 4 & n2 ? (l2 = true, c2 || i2.add(...s2)) : c2 && i2.remove(...s2));
  for (const t3 in z$1) {
    const o3 = z$1[t3];
    if (s2 = Cl(r2, t3), void 0 !== s2) if (n2 & o3) {
      if (l2 && ("underline" === t3 || "strikethrough" === t3)) {
        e2 & o3 && i2.remove(...s2);
        continue;
      }
      (0 === (e2 & o3) || c2 && "underline" === t3 || "strikethrough" === t3) && i2.add(...s2);
    } else e2 & o3 && i2.remove(...s2);
  }
}
function Ko(t2, e2, n2) {
  const o2 = n2.isComposing(), r2 = t2 + (o2 ? A : ""), s2 = vc(), l2 = Tc(s2).$getDOMSlot(n2, e2, s2), c2 = l2.getFirstChild();
  if (null === c2 || c2.nodeType !== Node.TEXT_NODE) return void l2.insertChild(Zl().createTextNode(r2));
  const a2 = c2, u2 = a2.nodeValue;
  if (u2 !== r2) if (o2 || i) {
    const [t3, e3, n3] = (function(t4, e4) {
      const n4 = t4.length, o3 = e4.length;
      let r3 = 0, i2 = 0;
      for (; r3 < n4 && r3 < o3 && t4[r3] === e4[r3]; ) r3++;
      for (; i2 + r3 < n4 && i2 + r3 < o3 && t4[n4 - i2 - 1] === e4[o3 - i2 - 1]; ) i2++;
      return [
        r3,
        n4 - r3 - i2,
        e4.slice(r3, o3 - i2)
      ];
    })(u2, r2);
    0 !== e3 && a2.deleteData(t3, e3), a2.insertData(t3, n3);
  } else a2.nodeValue = r2;
}
function zo(t2, e2, n2, o2, r2, i2) {
  Ko(r2, t2, e2);
  const s2 = i2.theme.text;
  void 0 !== s2 && Lo(0, 0, o2, t2, s2);
}
function Bo(t2, e2) {
  const n2 = Zl().createElement(e2);
  return n2.appendChild(t2), n2;
}
function Ro(t2) {
  return null != t2 && true === t2.__isInlineFormattable;
}
var Wo = class extends _o {
  __text;
  __format;
  __style;
  __mode;
  __detail;
  get __isInlineFormattable() {
    return true;
  }
  $config() {
    return this.config("text", { importDOM: {
      "#text": () => ({
        conversion: Jo,
        priority: 0
      }),
      b: () => ({
        conversion: Uo,
        priority: 0
      }),
      code: () => ({
        conversion: Yo,
        priority: 0
      }),
      em: () => ({
        conversion: Yo,
        priority: 0
      }),
      i: () => ({
        conversion: Yo,
        priority: 0
      }),
      mark: () => ({
        conversion: Yo,
        priority: 0
      }),
      s: () => ({
        conversion: Yo,
        priority: 0
      }),
      span: () => ({
        conversion: $o,
        priority: 0
      }),
      strong: () => ({
        conversion: Yo,
        priority: 0
      }),
      sub: () => ({
        conversion: Yo,
        priority: 0
      }),
      sup: () => ({
        conversion: Yo,
        priority: 0
      }),
      u: () => ({
        conversion: Yo,
        priority: 0
      })
    } });
  }
  afterCloneFrom(t2) {
    super.afterCloneFrom(t2), this.__text = t2.__text, this.__format = t2.__format, this.__style = t2.__style, this.__mode = t2.__mode, this.__detail = t2.__detail;
  }
  constructor(t2 = "", e2) {
    super(e2), this.__text = t2, this.__format = 0, this.__style = "", this.__mode = 0, this.__detail = 0;
  }
  getFormat() {
    return this.getLatest().__format;
  }
  getDetail() {
    return this.getLatest().__detail;
  }
  getMode() {
    return U[this.getLatest().__mode];
  }
  getStyle() {
    return this.getLatest().__style;
  }
  isToken() {
    return 1 === this.getLatest().__mode;
  }
  isComposing() {
    return this.__key === qs();
  }
  isSegmented() {
    return 2 === this.getLatest().__mode;
  }
  isDirectionless() {
    return !!(1 & this.getLatest().__detail);
  }
  isUnmergeable() {
    return !!(2 & this.getLatest().__detail);
  }
  hasFormat(t2) {
    const e2 = z$1[t2];
    return 0 !== (this.getFormat() & e2);
  }
  isSimpleText() {
    return "text" === this.__type && 0 === this.__mode;
  }
  getTextContent() {
    return this.getLatest().__text;
  }
  getFormatFlags(t2, e2) {
    return Ws(this.getLatest().__format, t2, e2);
  }
  canHaveFormat() {
    return true;
  }
  isInline() {
    return true;
  }
  createDOM(t2, e2) {
    const n2 = this.__format, o2 = Po(0, n2), r2 = Io(0, n2), i2 = null === o2 ? r2 : o2, s2 = Zl().createElement(i2);
    let l2 = s2;
    this.hasFormat("code") && s2.setAttribute("spellcheck", "false"), null !== o2 && (l2 = Zl().createElement(r2), s2.appendChild(l2));
    zo(l2, this, 0, n2, this.__text, t2);
    const c2 = this.__style;
    return "" !== c2 && Fo(s2.style, c2), s2;
  }
  updateDOM(e2, n2, o2) {
    const r2 = this.__text, i2 = e2.__format, s2 = this.__format, l2 = Po(0, i2), c2 = Po(0, s2), a2 = Io(0, i2), u2 = Io(0, s2);
    if ((null === l2 ? a2 : l2) !== (null === c2 ? u2 : c2)) return true;
    if (l2 === c2 && a2 !== u2) {
      const e3 = n2.firstChild;
      e3 ?? t(48);
      const i3 = Zl().createElement(u2);
      return zo(i3, this, 0, s2, r2, o2), n2.replaceChild(i3, e3), false;
    }
    let f2 = n2;
    null !== c2 && null !== l2 && (f2 = n2.firstChild, f2 ?? t(49)), Ko(r2, f2, this);
    const d2 = o2.theme.text;
    void 0 !== d2 && i2 !== s2 && Lo(0, i2, s2, f2, d2);
    const h2 = e2.__style, g2 = this.__style;
    return h2 !== g2 && Fo(n2.style, g2, h2), false;
  }
  updateFromJSON(t2) {
    return super.updateFromJSON(t2).setTextContent(t2.text).setFormat(t2.format).setDetail(t2.detail).setMode(t2.mode).setStyle(t2.style);
  }
  exportDOM(e2) {
    let { element: n2 } = super.exportDOM(e2);
    return gc(n2) || t(132), n2.style.whiteSpace = "pre-wrap", this.hasFormat("lowercase") ? n2.style.textTransform = "lowercase" : this.hasFormat("uppercase") ? n2.style.textTransform = "uppercase" : this.hasFormat("capitalize") && (n2.style.textTransform = "capitalize"), this.hasFormat("bold") && (n2 = Bo(n2, "b")), this.hasFormat("italic") && (n2 = Bo(n2, "i")), this.hasFormat("strikethrough") && (n2 = Bo(n2, "s")), this.hasFormat("underline") && (n2 = Bo(n2, "u")), { element: n2 };
  }
  exportJSON() {
    return {
      detail: this.getDetail(),
      format: this.getFormat(),
      mode: this.getMode(),
      style: this.getStyle(),
      text: this.getTextContent(),
      ...super.exportJSON()
    };
  }
  selectionTransform(t2, e2) {
  }
  setFormat(t2) {
    const e2 = this.getWritable();
    return e2.__format = "string" == typeof t2 ? z$1[t2] : t2, e2;
  }
  setDetail(t2) {
    const e2 = this.getWritable();
    return e2.__detail = "string" == typeof t2 ? B[t2] : t2, e2;
  }
  setStyle(t2) {
    const e2 = this.getWritable();
    return e2.__style = t2, e2;
  }
  toggleFormat(t2) {
    const e2 = Ws(this.getFormat(), t2, null);
    return this.setFormat(e2);
  }
  toggleDirectionless() {
    const t2 = this.getWritable();
    return t2.__detail ^= 1, t2;
  }
  toggleUnmergeable() {
    const t2 = this.getWritable();
    return t2.__detail ^= 2, t2;
  }
  setMode(t2) {
    const e2 = $[t2];
    if (this.__mode === e2) return this;
    const n2 = this.getWritable();
    return n2.__mode = e2, n2;
  }
  setTextContent(t2) {
    if (this.__text === t2) return this;
    const e2 = this.getWritable();
    return e2.__text = t2, e2;
  }
  select(t2, e2) {
    fi();
    let n2 = t2, o2 = e2;
    const r2 = Kr(), i2 = this.getTextContent(), s2 = this.__key;
    if ("string" == typeof i2) {
      const t3 = i2.length;
      void 0 === n2 && (n2 = t3), void 0 === o2 && (o2 = t3);
    } else n2 = 0, o2 = 0;
    if (!ur(r2)) return Dr(s2, n2, s2, o2, "text", "text");
    {
      const t3 = qs();
      t3 !== r2.anchor.key && t3 !== r2.focus.key || Vs(s2), r2.setTextNodeRange(this, n2, this, o2);
    }
    return r2;
  }
  selectStart() {
    return this.select(0, 0);
  }
  selectEnd() {
    const t2 = this.getTextContentSize();
    return this.select(t2, t2);
  }
  spliceText(t2, e2, n2, o2) {
    const r2 = this.getWritable(), i2 = r2.__text, s2 = n2.length;
    let l2 = t2;
    l2 < 0 && (l2 = s2 + l2, l2 < 0 && (l2 = 0));
    const c2 = Kr();
    if (o2 && ur(c2)) {
      const e3 = t2 + s2;
      c2.setTextNodeRange(r2, e3, r2, e3);
    }
    return r2.__text = i2.slice(0, l2) + n2 + i2.slice(l2 + e2), r2;
  }
  canInsertTextBefore() {
    return true;
  }
  canInsertTextAfter() {
    return true;
  }
  splitText(...t2) {
    fi();
    const e2 = this.getLatest(), n2 = e2.getTextContent();
    if ("" === n2) return [];
    const o2 = e2.__key, r2 = qs(), i2 = n2.length;
    t2.sort((t3, e3) => t3 - e3), t2.push(i2);
    const s2 = [], l2 = t2.length;
    for (let e3 = 0, o3 = 0; e3 < i2 && o3 <= l2; o3++) {
      const r3 = t2[o3];
      r3 > e3 && (s2.push(n2.slice(e3, r3)), e3 = r3);
    }
    const c2 = s2.length;
    if (1 === c2) return [e2];
    const a2 = s2[0], u2 = e2.getParent();
    let f2;
    const d2 = e2.getFormat(), h2 = e2.getStyle(), g2 = e2.__detail;
    let _2 = false, p = null, y = null;
    const m = Kr();
    if (ur(m)) {
      const [t3, e3] = m.isBackward() ? [m.focus, m.anchor] : [m.anchor, m.focus];
      "text" === t3.type && t3.key === o2 && (p = t3), "text" === e3.type && e3.key === o2 && (y = e3);
    }
    e2.isSegmented() ? (f2 = Go(a2), f2.__format = d2, f2.__style = h2, f2.__detail = g2, f2.__state = At(e2, f2), _2 = true) : f2 = e2.setTextContent(a2);
    const x2 = [f2];
    for (let t3 = 1; t3 < c2; t3++) {
      const n3 = Go(s2[t3]);
      n3.__format = d2, n3.__style = h2, n3.__detail = g2, n3.__state = At(e2, n3);
      const i3 = n3.__key;
      r2 === o2 && Vs(i3), x2.push(n3);
    }
    const C = p ? p.offset : null, S = y ? y.offset : null;
    let v = 0;
    for (const t3 of x2) {
      if (!p && !y) break;
      const e3 = v + t3.getTextContentSize();
      if (null !== p && null !== C && C <= e3 && C >= v && (p.set(t3.getKey(), C - v, "text"), C < e3 && (p = null)), null !== y && null !== S && S <= e3 && S >= v) {
        y.set(t3.getKey(), S - v, "text");
        break;
      }
      v = e3;
    }
    if (null !== u2) {
      (function(t4) {
        const e4 = t4.getPreviousSibling(), n3 = t4.getNextSibling();
        null !== e4 && Js(e4);
        null !== n3 && Js(n3);
      })(this);
      const t3 = u2.getWritable(), e3 = this.getIndexWithinParent();
      _2 ? (t3.splice(e3, 0, x2), this.remove()) : t3.splice(e3, 1, x2), ur(m) && Br(m, u2, e3, c2 - 1);
    }
    return x2;
  }
  mergeWithSibling(e2) {
    const n2 = e2 === this.getPreviousSibling();
    n2 || e2 === this.getNextSibling() || t(50);
    const o2 = this.__key, r2 = e2.__key, i2 = this.__text, s2 = i2.length;
    qs() === r2 && Vs(o2);
    const l2 = Kr();
    if (ur(l2)) {
      const t2 = l2.anchor, i3 = l2.focus;
      null !== t2 && t2.key === r2 && $r(t2, n2, o2, e2, s2), null !== i3 && i3.key === r2 && $r(i3, n2, o2, e2, s2);
    }
    const c2 = e2.__text, a2 = n2 ? c2 + i2 : i2 + c2;
    this.setTextContent(a2);
    const u2 = this.getWritable();
    return e2.remove(), u2;
  }
  isTextEntity() {
    return false;
  }
};
function $o(t2) {
  return {
    forChild: Qo(t2.style),
    node: null
  };
}
function Uo(t2) {
  const e2 = t2, n2 = "normal" === e2.style.fontWeight;
  return {
    forChild: Qo(e2.style, n2 ? void 0 : "bold"),
    node: null
  };
}
var Ho = /* @__PURE__ */ new WeakMap();
function jo(t2) {
  if (!gc(t2)) return false;
  if ("PRE" === t2.nodeName) return true;
  const e2 = t2.style.whiteSpace;
  return "string" == typeof e2 && e2.startsWith("pre");
}
function Jo(e2) {
  const n2 = e2;
  null === e2.parentElement && t(129);
  let o2 = n2.textContent || "";
  if (null !== (function(t2) {
    let e3, n3 = t2.parentNode;
    const o3 = [t2];
    for (; null !== n3 && void 0 === (e3 = Ho.get(n3)) && !jo(n3); ) o3.push(n3), n3 = n3.parentNode;
    const r2 = void 0 === e3 ? n3 : e3;
    for (let t3 = 0; t3 < o3.length; t3++) Ho.set(o3[t3], r2);
    return r2;
  })(n2)) return { node: qr(o2) };
  if (o2 = o2.replace(/\r/g, "").replace(/[ \t\n]+/g, " "), "" === o2) return { node: null };
  if (" " === o2[0]) {
    let t2 = n2, e3 = true;
    for (; null !== t2 && null !== (t2 = Vo(t2, false)); ) {
      const n3 = t2.textContent || "";
      if (n3.length > 0) {
        /[ \t\n]$/.test(n3) && (o2 = o2.slice(1)), e3 = false;
        break;
      }
    }
    e3 && (o2 = o2.slice(1));
  }
  if (" " === o2[o2.length - 1]) {
    let t2 = n2, e3 = true;
    for (; null !== t2 && null !== (t2 = Vo(t2, true)); ) if ((t2.textContent || "").replace(/^( |\t|\r?\n)+/, "").length > 0) {
      e3 = false;
      break;
    }
    e3 && (o2 = o2.slice(0, o2.length - 1));
  }
  return "" === o2 ? { node: null } : { node: Go(o2) };
}
function Vo(t2, e2) {
  let n2 = t2;
  for (; ; ) {
    let t3;
    for (; null === (t3 = e2 ? n2.nextSibling : n2.previousSibling); ) {
      const t4 = n2.parentElement;
      if (null === t4) return null;
      n2 = t4;
    }
    if (n2 = t3, gc(n2)) {
      const t4 = n2.style.display;
      if ("" === t4 && !mc(n2) || "" !== t4 && !t4.startsWith("inline")) return null;
    }
    let o2 = n2;
    for (; null !== (o2 = e2 ? n2.firstChild : n2.lastChild); ) n2 = o2;
    if (zs(n2)) return n2;
    if ("BR" === n2.nodeName) return null;
  }
}
var qo = {
  code: "code",
  em: "italic",
  i: "italic",
  mark: "highlight",
  s: "strikethrough",
  strong: "bold",
  sub: "subscript",
  sup: "superscript",
  u: "underline"
};
function Yo(t2) {
  const e2 = qo[t2.nodeName.toLowerCase()];
  return void 0 === e2 ? { node: null } : {
    forChild: Qo(t2.style, e2),
    node: null
  };
}
function Go(t2 = "") {
  return Wl(new Wo(t2));
}
function Xo(t2) {
  return t2 instanceof Wo;
}
function Qo(t2, e2) {
  const n2 = t2.fontWeight, o2 = t2.textDecoration.split(" "), r2 = "700" === n2 || "bold" === n2, i2 = o2.includes("line-through"), s2 = "italic" === t2.fontStyle, l2 = o2.includes("underline"), c2 = t2.verticalAlign;
  return (t3) => Xo(t3) || Ro(t3) ? (r2 && !t3.hasFormat("bold") && t3.toggleFormat("bold"), i2 && !t3.hasFormat("strikethrough") && t3.toggleFormat("strikethrough"), s2 && !t3.hasFormat("italic") && t3.toggleFormat("italic"), l2 && !t3.hasFormat("underline") && t3.toggleFormat("underline"), "sub" !== c2 || t3.hasFormat("subscript") || t3.toggleFormat("subscript"), "super" !== c2 || t3.hasFormat("superscript") || t3.toggleFormat("superscript"), e2 && !t3.hasFormat(e2) && t3.toggleFormat(e2), t3) : t3;
}
var Zo = class extends Wo {
  $config() {
    return this.config("tab", { extends: Wo });
  }
  constructor(t2 = void 0) {
    super("	", t2), this.__detail = 2;
  }
  createDOM(t2) {
    const e2 = super.createDOM(t2), n2 = Cl(t2.theme, "tab");
    if (void 0 !== n2) e2.classList.add(...n2);
    return e2;
  }
  setTextContent(t2) {
    return super.setTextContent("	");
  }
  spliceText(e2, n2, o2, r2) {
    return "" === o2 && 0 === n2 || "	" === o2 && 1 === n2 || t(286), this;
  }
  setDetail(e2) {
    return 2 !== e2 && t(127), this;
  }
  setMode(e2) {
    return "normal" !== e2 && t(128), this;
  }
  canInsertTextBefore() {
    return false;
  }
  canInsertTextAfter() {
    return false;
  }
};
function tr() {
  return Wl(new Zo());
}
function er(t2) {
  return t2 instanceof Zo;
}
var nr = class {
  key;
  offset;
  type;
  _selection;
  constructor(t2, e2, n2) {
    this._selection = null, this.key = t2, this.offset = e2, this.type = n2;
  }
  is(t2) {
    return this.key === t2.key && this.offset === t2.offset && this.type === t2.type;
  }
  isBefore(t2) {
    if (this.key === t2.key) return this.offset < t2.offset;
    return Ya(au(tu(this, "next")), au(tu(t2, "next"))) < 0;
  }
  getNode() {
    const e2 = Ys(this.key);
    return null === e2 && t(20), e2;
  }
  set(t2, e2, n2, o2) {
    const r2 = this._selection, i2 = this.key;
    o2 && this.key === t2 && this.offset === e2 && this.type === n2 || (this.key = t2, this.offset = e2, this.type = n2, ui() || (qs() === i2 && Vs(t2), null !== r2 && (r2.setCachedNodes(null), ur(r2) && (r2._cachedIsBackward = null), r2.dirty = true)));
  }
};
function or(t2, e2, n2) {
  return new nr(t2, e2, n2);
}
function rr(t2, e2) {
  let n2 = e2.__key, o2 = t2.offset, r2 = "element";
  if (Xo(e2)) {
    r2 = "text";
    const t3 = e2.getTextContentSize();
    o2 > t3 && (o2 = t3);
  } else if (!Pi(e2)) {
    const t3 = e2.getNextSibling();
    if (Xo(t3)) n2 = t3.__key, o2 = 0, r2 = "text";
    else {
      const t4 = e2.getParent();
      t4 && (n2 = t4.__key, o2 = e2.getIndexWithinParent() + 1);
    }
  }
  t2.set(n2, o2, r2);
}
function ir(t2, e2) {
  if (Pi(e2)) {
    const n2 = e2.getLastDescendant();
    Pi(n2) || Xo(n2) ? rr(t2, n2) : rr(t2, e2);
  } else rr(t2, e2);
}
function sr(t2, e2, n2, o2) {
  const r2 = t2.getNode(), i2 = r2.getChildAtIndex(t2.offset), s2 = Go();
  if (s2.setFormat(n2), s2.setStyle(o2), ns(i2)) i2.splice(0, 0, [s2]);
  else if (null !== i2) {
    const t3 = Bl(r2) ? es().append(s2) : s2;
    i2.insertBefore(t3);
  } else if (Bl(r2)) {
    const t3 = r2.getLastChild();
    Pi(t3) && !t3.isInline() && t3.isEmpty() ? t3.append(s2) : r2.append(es().append(s2));
  } else r2.append(s2);
  t2.is(e2) && e2.set(s2.__key, 0, "text"), t2.set(s2.__key, 0, "text");
}
function lr(e2, n2, o2, r2) {
  const i2 = e2.anchor.getNode();
  Xo(i2) || t(398);
  const s2 = e2.anchor.offset, l2 = Go(n2);
  l2.setFormat(o2), l2.setStyle(r2);
  const c2 = i2.getParentOrThrow();
  if (0 === s2) c2.isInline() && !i2.__prev ? c2.insertBefore(l2) : i2.insertBefore(l2, false);
  else if (s2 === i2.getTextContentSize()) c2.isInline() && !i2.__next ? c2.insertAfter(l2) : i2.insertAfter(l2, false);
  else {
    const [t2] = i2.splitText(s2);
    t2.insertAfter(l2, false);
  }
  "" === i2.getTextContent() && i2.isAttached() && i2.remove(), l2.selectEnd(), l2.isComposing() && "text" === e2.anchor.type && e2.anchor.set(e2.anchor.key, e2.anchor.offset - n2.length, e2.anchor.type);
}
var cr = class cr2 {
  _nodes;
  _cachedNodes;
  dirty;
  constructor(t2) {
    this._cachedNodes = null, this._nodes = t2, this.dirty = false;
  }
  getCachedNodes() {
    return this._cachedNodes;
  }
  setCachedNodes(t2) {
    this._cachedNodes = t2;
  }
  is(t2) {
    if (!dr(t2)) return false;
    const e2 = this._nodes, n2 = t2._nodes;
    return e2.size === n2.size && Array.from(e2).every((t3) => n2.has(t3));
  }
  isCollapsed() {
    return false;
  }
  isBackward() {
    return false;
  }
  getStartEndPoints() {
    return null;
  }
  add(t2) {
    this.dirty = true, this._nodes.add(t2), this._cachedNodes = null;
  }
  delete(t2) {
    this.dirty = true, this._nodes.delete(t2), this._cachedNodes = null;
  }
  clear() {
    this.dirty = true, this._nodes.clear(), this._cachedNodes = null;
  }
  has(t2) {
    return this._nodes.has(t2);
  }
  clone() {
    return new cr2(new Set(this._nodes));
  }
  extract() {
    return this.getNodes();
  }
  insertRawText(t2) {
  }
  insertText() {
  }
  insertNodes(t2) {
    const e2 = this.getNodes().filter((t3) => null === ta(t3)), n2 = e2.length;
    if (0 === n2) return;
    const o2 = e2[n2 - 1];
    let r2;
    if (Xo(o2)) r2 = o2.select();
    else {
      const t3 = o2.getIndexWithinParent() + 1;
      r2 = o2.getParentOrThrow().select(t3, t3);
    }
    r2.insertNodes(t2);
    for (let t3 = 0; t3 < n2; t3++) e2[t3].remove();
  }
  getNodes() {
    const t2 = this._cachedNodes;
    if (null !== t2) return t2;
    const e2 = this._nodes, n2 = [];
    for (const t3 of e2) {
      const e3 = Ys(t3);
      null !== e3 && n2.push(e3);
    }
    return ui() || (this._cachedNodes = n2), n2;
  }
  getTextContent() {
    const t2 = this.getNodes();
    let e2 = "";
    for (let n2 = 0; n2 < t2.length; n2++) e2 += t2[n2].getTextContent();
    return e2;
  }
  deleteNodes() {
    const t2 = this.getNodes().filter((t3) => null === ta(t3));
    if ((Kr() || zr()) === this && t2[0]) {
      const e2 = Ia(t2[0], "next");
      nu(Va(e2, e2));
    }
    for (const e2 of t2) e2.remove();
    ar();
  }
};
function ar() {
  const t2 = nl();
  if (t2.isEmpty()) {
    const e2 = es();
    t2.append(e2), e2.select();
  }
}
function ur(t2) {
  return t2 instanceof fr;
}
var fr = class fr2 {
  format;
  style;
  anchor;
  focus;
  _cachedNodes;
  _cachedIsBackward;
  dirty;
  constructor(t2, e2, n2, o2) {
    this.anchor = t2, this.focus = e2, t2._selection = this, e2._selection = this, this._cachedNodes = null, this._cachedIsBackward = null, this.format = n2, this.style = o2, this.dirty = false;
  }
  getCachedNodes() {
    return this._cachedNodes;
  }
  setCachedNodes(t2) {
    this._cachedNodes = t2;
  }
  is(t2) {
    return !!ur(t2) && this.anchor.is(t2.anchor) && this.focus.is(t2.focus) && this.format === t2.format && this.style === t2.style;
  }
  isCollapsed() {
    return this.anchor.is(this.focus);
  }
  getNodes() {
    const t2 = this._cachedNodes;
    if (null !== t2) return t2;
    const e2 = (function(t3) {
      const e3 = [], [n2, o2] = t3.getTextSlices();
      n2 && e3.push(n2.caret.origin);
      const r2 = /* @__PURE__ */ new Set(), i2 = /* @__PURE__ */ new Set();
      for (const n3 of t3) if (Aa(n3)) {
        const { origin: t4 } = n3;
        0 === e3.length ? r2.add(t4) : (i2.add(t4), e3.push(t4));
      } else {
        const { origin: t4 } = n3;
        Pi(t4) && i2.has(t4) || e3.push(t4);
      }
      o2 && e3.push(o2.caret.origin);
      if (Ma(t3.focus) && Pi(t3.focus.origin) && null === t3.focus.getNodeAtCaret()) for (let n3 = Ba(t3.focus.origin, "previous"); Aa(n3) && r2.has(n3.origin) && !n3.origin.isEmpty() && n3.origin.is(e3[e3.length - 1]); n3 = Wa(n3)) r2.delete(n3.origin), e3.pop();
      for (; e3.length > 1; ) {
        const t4 = e3[e3.length - 1];
        if (!Pi(t4) || i2.has(t4) || t4.isEmpty() || r2.has(t4)) break;
        e3.pop();
      }
      if (0 === e3.length && t3.isCollapsed()) {
        const n3 = au(t3.anchor), o3 = au(t3.anchor.getFlipped()), r3 = (t4) => wa(t4) ? t4.origin : t4.getNodeAtCaret(), i3 = r3(n3) || r3(o3) || (t3.anchor.getNodeAtCaret() ? n3.origin : o3.origin);
        e3.push(i3);
      }
      return e3;
    })(du(ru(this), "next"));
    return ui() || (this._cachedNodes = e2), e2;
  }
  setTextNodeRange(t2, e2, n2, o2) {
    return this.anchor.set(t2.__key, e2, "text"), this.focus.set(n2.__key, o2, "text"), this;
  }
  getTextContent() {
    const t2 = this.getNodes();
    if (0 === t2.length) return "";
    const e2 = t2[0], n2 = t2[t2.length - 1], o2 = this.anchor, r2 = this.focus, i2 = o2.isBefore(r2), [s2, l2] = yr(this);
    let c2 = "", a2 = true;
    for (let u2 = 0; u2 < t2.length; u2++) {
      const f2 = t2[u2];
      if (Pi(f2) && !f2.isInline()) {
        a2 || (c2 += "\n");
        let t3 = "";
        for (const e3 of ia(f2)) {
          const n3 = sa(f2, e3);
          null !== n3 && (t3 += n3.getTextContent());
        }
        "" !== t3 ? (c2 += t3, a2 = false) : a2 = !f2.isEmpty();
      } else if (a2 = false, Xo(f2)) {
        let t3 = f2.getTextContent();
        f2 === e2 ? f2 === n2 ? "element" === o2.type && "element" === r2.type && r2.offset !== o2.offset || (t3 = s2 < l2 ? t3.slice(s2, l2) : t3.slice(l2, s2)) : t3 = i2 ? t3.slice(s2) : t3.slice(l2) : f2 === n2 && (t3 = i2 ? t3.slice(0, l2) : t3.slice(0, s2)), c2 += t3;
      } else !Ki(f2) && !Yi(f2) || f2 === n2 && this.isCollapsed() || (c2 += f2.getTextContent());
    }
    return c2;
  }
  applyDOMRange(t2) {
    const e2 = _i(), n2 = e2.getEditorState()._selection, o2 = Mr(t2.startContainer, t2.startOffset, t2.endContainer, t2.endOffset, e2, n2);
    if (null === o2) return;
    const [r2, i2, s2] = o2;
    this.anchor.set(r2.key, r2.offset, r2.type, true), this.focus.set(i2.key, i2.offset, i2.type, true), s2 && (this.dirty = true), It(this);
  }
  clone() {
    const t2 = this.anchor, e2 = this.focus;
    return new fr2(or(t2.key, t2.offset, t2.type), or(e2.key, e2.offset, e2.type), this.format, this.style);
  }
  toggleFormat(t2) {
    this.format = Ws(this.format, t2, null), this.dirty = true;
  }
  setFormat(t2) {
    this.format = t2, this.dirty = true;
  }
  setStyle(t2) {
    this.style = t2, this.dirty = true;
  }
  hasFormat(t2) {
    const e2 = z$1[t2];
    return 0 !== (this.format & e2);
  }
  insertRawText(t2) {
    this.insertNodes(qr(t2));
  }
  insertText(e2) {
    let n2 = this.format, o2 = this.style;
    if (!this.isCollapsed()) {
      const t2 = (this.focus.isBefore(this.anchor) ? this.focus : this.anchor).getNode();
      if (Xo(t2) && (n2 = t2.getFormat(), o2 = t2.getStyle()), this.removeText(), this.format = n2, this.style = o2, "" === e2) return;
      if (null === qs()) return "element" === this.anchor.type && sr(this.anchor, this.focus, n2, o2), void lr(this, e2, n2, o2);
    }
    "element" === this.anchor.type && sr(this.anchor, this.focus, n2, o2);
    const r2 = this.anchor.getNode();
    Xo(r2) || t(398);
    const i2 = this.anchor.offset, s2 = r2.getParentOrThrow(), l2 = r2.getTextContentSize();
    if (Ks(r2) || 0 === i2 && (!r2.canInsertTextBefore() || !s2.canInsertTextBefore() && !r2.__prev) || i2 === l2 && (!r2.canInsertTextAfter() || !s2.canInsertTextAfter() && !r2.__next)) {
      if (r2.isSegmented() && 0 !== i2 && i2 !== l2) {
        if (null !== qs()) r2.setMode("normal").setFormat(n2).setStyle(o2);
        else {
          const t3 = Go(r2.getTextContent());
          t3.setFormat(n2), t3.setStyle(o2), r2.replace(t3), t3.select(i2, i2);
        }
        "" !== e2 && this.insertText(e2);
        return;
      }
      if ("" === e2) return;
      if (0 === i2) {
        const t3 = r2.getPreviousSibling();
        if (Xo(t3) && t3.canInsertTextAfter() && !Ks(t3)) t3.select();
        else {
          const t4 = Go();
          t4.setFormat(n2), t4.setStyle(o2), s2.canInsertTextBefore() ? r2.insertBefore(t4) : s2.insertBefore(t4), t4.select();
        }
        this.insertText(e2);
        return;
      }
      if (i2 === l2) {
        const t3 = r2.getNextSibling();
        if (Xo(t3) && t3.canInsertTextBefore() && !Ks(t3)) t3.select(0, 0);
        else {
          const t4 = Go();
          t4.setFormat(n2), t4.setStyle(o2), s2.canInsertTextAfter() ? r2.insertAfter(t4) : s2.insertAfter(t4), t4.select(0, 0);
        }
        this.insertText(e2);
        return;
      }
      const t2 = Go(e2);
      t2.setFormat(n2), t2.setStyle(o2), r2.replace(t2), t2.select();
      return;
    }
    if ("" === e2) return;
    const c2 = s2.isInline() && 0 === i2 && !r2.__prev, a2 = s2.isInline() && i2 === l2 && !r2.__next, u2 = r2.getFormat() !== n2 || r2.getStyle() !== o2;
    if (c2 || a2 || u2) {
      if ("" !== r2.getTextContent() || c2 || a2) return void lr(this, e2, n2, o2);
      r2.setFormat(n2), r2.setStyle(o2);
    }
    r2.spliceText(i2, 0, e2, true), r2.isComposing() && "text" === this.anchor.type && this.anchor.set(this.anchor.key, this.anchor.offset - e2.length, this.anchor.type);
  }
  removeText() {
    const t2 = Kr() === this;
    ou(this, cu(ru(this))), t2 && Kr() !== this && ol(this);
  }
  formatText(t2, e2 = null) {
    _r(this, t2, e2);
  }
  insertNodes(e2) {
    if (0 === e2.length) return;
    this.isCollapsed() || this.removeText();
    const n2 = this.anchor.getNode();
    if ("element" === this.anchor.type && Pi(n2) && null !== ta(n2)) {
      let o3 = n2.isShadowRoot() ? n2.getFirstChild() ?? n2.append(es()).getFirstChild() : n2.getFirstChild();
      if (n2.isShadowRoot() && null !== o3 && !Pi(o3)) {
        const t2 = es();
        o3.insertBefore(t2), o3 = t2;
      }
      if (null !== o3) {
        o3.selectStart();
        const n3 = Kr();
        return ur(n3) || t(369), n3.insertNodes(e2);
      }
    }
    if ("element" === this.anchor.type && Bl(n2)) {
      const t2 = ti(e2), o3 = t2.getLastDescendant();
      n2.splice(this.anchor.offset, 0, t2.getChildren()), null !== o3 && o3.selectEnd();
      return;
    }
    let o2 = (this.isBackward() ? this.focus : this.anchor).getNode(), r2 = qc(o2, Sc);
    const i2 = e2[e2.length - 1];
    if (Pi(r2) && "__language" in r2) {
      if ("__language" in e2[0]) this.insertText(e2[0].getTextContent());
      else {
        const t2 = Xr(this);
        r2.splice(t2, 0, e2), i2.selectEnd();
      }
      return;
    }
    if (!e2.some((t2) => (Pi(t2) || Ki(t2)) && !t2.isInline())) {
      Pi(r2) || t(211, o2.constructor.name, o2.getType());
      const n3 = Xr(this);
      r2.splice(n3, 0, e2), i2.selectEnd();
      return;
    }
    if (Pi(r2) && null !== ta(r2)) {
      const t2 = Xr(this), n3 = Gr(e2);
      r2.splice(t2, 0, n3);
      const o3 = n3[n3.length - 1];
      void 0 !== o3 ? o3.selectEnd() : r2.select(t2, t2);
      return;
    }
    if (null === r2) {
      const t2 = ti(e2), n3 = t2.getLastDescendant();
      let o3 = tu(this.anchor, "next");
      for (const e3 of t2.getChildren()) o3 = mu(e3, o3);
      null !== n3 && n3.selectEnd();
      return;
    }
    if (Pi(r2) && !r2.isParentRequired() && !Bl(r2.getParentOrThrow())) {
      const t2 = Xr(this), n3 = Gr(e2);
      r2.splice(t2, 0, n3);
      const o3 = n3[n3.length - 1];
      void 0 !== o3 ? o3.selectEnd() : r2.select(t2, t2);
      return;
    }
    const s2 = ti(e2), l2 = s2.getLastDescendant(), c2 = s2.getChildren(), a2 = !Pi(r2) || !r2.isEmpty() ? this.insertParagraph() : null;
    a2 && !r2.isAttached() && (o2 = this.anchor.getNode(), r2 = qc(o2, Sc));
    const u2 = c2[c2.length - 1];
    let f2 = c2[0];
    var d2;
    Pi(d2 = f2) && Sc(d2) && !d2.isEmpty() && Pi(r2) && (!r2.isEmpty() || r2.canMergeWhenEmpty()) && (Pi(r2) || t(211, o2.constructor.name, o2.getType()), r2.append(...f2.getChildren()), f2 = c2[1]), f2 && (null === r2 && t(212, o2.constructor.name, o2.getType()), (function(e3, n3) {
      const o3 = n3.getParentOrThrow().getLastChild();
      let r3 = n3;
      const i3 = [n3];
      for (; r3 !== o3; ) r3.getNextSibling() || t(140), r3 = r3.getNextSibling(), i3.push(r3);
      let s3 = e3;
      for (const t2 of i3) s3 = s3.insertAfter(t2);
    })(r2, f2));
    const h2 = qc(l2, Sc);
    a2 && Pi(h2) && (a2.canMergeWhenEmpty() || Sc(u2)) && (h2.append(...a2.getChildren()), a2.remove()), Pi(r2) && r2.isEmpty() && r2.remove(), l2.selectEnd();
    const g2 = Pi(r2) ? r2.getLastChild() : null;
    Yi(g2) && h2 !== r2 && g2.remove();
  }
  insertParagraph() {
    const e2 = this.anchor.getNode();
    if ("element" === this.anchor.type && Bl(e2)) {
      const t2 = es();
      return e2.splice(this.anchor.offset, 0, [t2]), t2.select(), t2;
    }
    const n2 = Xr(this), o2 = qc(this.anchor.getNode(), Sc);
    if (null !== o2 && null !== ta(o2)) return null;
    Pi(o2) || t(213);
    const r2 = o2.getChildAtIndex(n2), i2 = r2 ? [r2, ...r2.getNextSiblings()] : [], s2 = o2.insertNewAfter(this, false);
    return s2 ? (s2.append(...i2), s2.selectStart(), s2) : null;
  }
  insertLineBreak(t2) {
    const e2 = qi();
    if (this.insertNodes([e2]), t2) {
      const t3 = e2.getParentOrThrow(), n2 = e2.getIndexWithinParent();
      t3.select(n2, n2);
    }
  }
  extract() {
    const t2 = [...this.getNodes()], e2 = t2.length;
    let n2 = t2[0], o2 = t2[e2 - 1];
    const [r2, i2] = yr(this), s2 = this.isBackward(), [l2, c2] = s2 ? [this.focus, this.anchor] : [this.anchor, this.focus], [a2, u2] = s2 ? [i2, r2] : [r2, i2];
    if (0 === e2) return [];
    if (1 === e2) {
      if (Xo(n2) && !this.isCollapsed()) {
        const t3 = n2.splitText(a2, u2), e3 = 0 === a2 ? t3[0] : t3[1];
        return e3 ? (l2.set(e3.getKey(), 0, "text"), c2.set(e3.getKey(), e3.getTextContentSize(), "text"), [e3]) : [];
      }
      return [n2];
    }
    if (Xo(n2) && (a2 === n2.getTextContentSize() ? t2.shift() : 0 !== a2 && ([, n2] = n2.splitText(a2), t2[0] = n2, l2.set(n2.getKey(), 0, "text"))), Xo(o2)) {
      const e3 = o2.getTextContent().length;
      0 === u2 ? t2.pop() : u2 !== e3 && ([o2] = o2.splitText(u2), t2[t2.length - 1] = o2, c2.set(o2.getKey(), o2.getTextContentSize(), "text"));
    }
    return t2;
  }
  modify(t2, e2, n2) {
    if (ei(this, t2, e2, n2)) return;
    const o2 = "move" === t2, r2 = _i(), i2 = Jl(Il(r2));
    if (!i2) return;
    const s2 = r2._blockCursorElement, l2 = r2._rootElement, c2 = this.focus.getNode();
    null === l2 || null === s2 || !Pi(c2) || c2.isInline() || c2.canBeEmpty() || jl(s2, r2, l2);
    const a2 = El(r2, this.focus.key);
    let u2 = a2;
    if ("text" === this.focus.type && (u2 = Xo(c2) ? wc(c2, a2, r2) : null), this.dirty) {
      const t3 = El(r2, this.anchor.key);
      let e3 = t3;
      if ("text" === this.anchor.type) {
        const n3 = this.anchor.getNode();
        e3 = Xo(n3) ? wc(n3, t3, r2) : null;
      }
      e3 && u2 && Ur(i2, e3, this.anchor.offset, u2, this.focus.offset);
    }
    if ("character" === n2 && Xo(c2) && c2.isUnmergeable()) {
      if (e2 ? 0 === this.focus.offset : this.focus.offset === c2.getTextContentSize()) {
        const t3 = Ia(c2, e2 ? "previous" : "next").getNodeAtCaret();
        if (Xo(t3)) {
          if (!o2) {
            const n3 = t3.getTextContentSize();
            e2 ? this.focus.set(t3.__key, n3 - 1, "text") : this.focus.set(t3.__key, 1, "text"), this.dirty = true;
            return;
          }
          {
            const n3 = r2.getElementByKey(t3.getKey()), o3 = n3 ? wc(t3, n3, r2) : null;
            if (o3) {
              const t4 = e2 ? o3.length : 0;
              Ur(i2, o3, t4, o3, t4);
            }
          }
        }
      }
    }
    if (Cr(i2, t2, e2 ? "backward" : "forward", n2), i2.rangeCount > 0) {
      const t3 = tc(i2, r2._rootElement), n3 = t3 || i2.getRangeAt(0), s3 = this.anchor.getNode(), l3 = Bi(s3) ? s3 : Kl(s3);
      if (this.applyDOMRange(n3), this.dirty = true, !o2) {
        Sr(this, e2, l3);
        (t3 ? "backward" !== i2.direction : i2.anchorNode === n3.startContainer && i2.anchorOffset === n3.startOffset) || xr(this);
      }
    }
    "lineboundary" === n2 && ei(this, t2, e2, n2, "decorators");
  }
  forwardDeletion(t2, e2, n2) {
    if (!n2 && ("element" === t2.type && Pi(e2) && t2.offset === e2.getChildrenSize() || "text" === t2.type && t2.offset === e2.getTextContentSize())) {
      const t3 = e2.getParent(), n3 = e2.getNextSibling() || (null === t3 ? null : t3.getNextSibling());
      if (Pi(n3) && n3.isShadowRoot()) return true;
    }
    return false;
  }
  deleteCharacter(t2) {
    const e2 = this.isCollapsed();
    if (this.isCollapsed()) {
      const e3 = this.anchor;
      let n2 = e3.getNode();
      if (this.forwardDeletion(e3, n2, t2)) return;
      const o2 = ja(tu(e3, t2 ? "previous" : "next"));
      if (o2.getTextSlices().every((t3) => null === t3 || 0 === t3.distance)) {
        let t3 = { type: "initial" };
        for (const e4 of o2.iterNodeCarets("shadowRoot")) if (Aa(e4)) if (e4.origin.isInline()) ;
        else {
          if (e4.origin.isShadowRoot()) {
            if ("merge-block" === t3.type) break;
            if (Pi(o2.anchor.origin) && o2.anchor.origin.isEmpty()) {
              const t4 = au(e4);
              ou(this, Va(t4, t4)), o2.anchor.origin.remove();
            }
            return;
          }
          "merge-next-block" !== t3.type && "merge-block" !== t3.type || (t3 = {
            block: t3.block,
            caret: e4,
            type: "merge-block"
          });
        }
        else {
          if ("merge-block" === t3.type) break;
          if (Ma(e4)) {
            if (Pi(e4.origin)) {
              if (e4.origin.isInline()) {
                if (!e4.origin.isParentOf(o2.anchor.origin)) break;
              } else t3 = {
                block: e4.origin,
                type: "merge-next-block"
              };
              continue;
            }
            if (Ki(e4.origin)) {
              if (e4.origin.isIsolated()) ;
              else if (ia(e4.origin).length > 0) {
                if (Pi(o2.anchor.origin) && o2.anchor.origin.isEmpty()) {
                  o2.anchor.origin.remove();
                  const t4 = Pr();
                  t4.add(e4.origin.getKey()), ol(t4);
                }
              } else if ("merge-next-block" === t3.type && (e4.origin.isKeyboardSelectable() || !e4.origin.isInline()) && Pi(o2.anchor.origin) && o2.anchor.origin.isEmpty()) {
                o2.anchor.origin.remove();
                const t4 = Pr();
                t4.add(e4.origin.getKey()), ol(t4);
              } else e4.origin.remove();
              return;
            }
            break;
          }
        }
        if ("merge-block" === t3.type) {
          const { caret: e4, block: n3 } = t3;
          if (ia(n3).length > 0) return;
          return e4.origin.isEmpty() && !n3.isEmpty() && e4.origin.getParent() === n3.getParent() ? void e4.origin.remove(true) : (ou(this, Va(!e4.origin.isEmpty() && n3.isEmpty() ? iu(Ia(n3, e4.direction)) : o2.anchor, e4)), this.removeText());
        }
        for (let t4 = e3.getNode(); null !== t4; ) {
          if (null !== ta(t4)) return;
          if (Pi(t4) && t4.isShadowRoot()) break;
          t4 = t4.getParent();
        }
      }
      const r2 = this.focus;
      if (vr(this, t2, "character"), this.isCollapsed()) {
        if (t2 && 0 === e3.offset && mr(this, e3.getNode())) return;
      } else {
        const o3 = "text" === r2.type ? r2.getNode() : null;
        if (n2 = "text" === e3.type ? e3.getNode() : null, null !== o3 && o3.isSegmented()) {
          const e4 = r2.offset, i2 = o3.getTextContentSize();
          if (o3.is(n2) || t2 && e4 !== i2 || !t2 && 0 !== e4) return void kr(o3, t2, e4);
        } else if (null !== n2 && n2.isSegmented()) {
          const r3 = e3.offset, i2 = n2.getTextContentSize();
          if (n2.is(o3) || t2 && 0 !== r3 || !t2 && r3 !== i2) return void kr(n2, t2, r3);
        }
        (function(t3, e4) {
          const n3 = t3.anchor, o4 = t3.focus, r3 = n3.getNode();
          if (r3 === o4.getNode() && "text" === n3.type && "text" === o4.type) {
            const t4 = n3.offset, i2 = o4.offset, s2 = t4 < i2, l2 = s2 ? t4 : i2, c2 = s2 ? i2 : t4, a2 = c2 - 1;
            if (l2 !== a2) (function(t5) {
              return !(sl(t5) || Tr(t5));
            })(r3.getTextContent().slice(l2, c2)) && (e4 ? o4.set(o4.key, a2, o4.type) : n3.set(n3.key, a2, n3.type));
          }
        })(this, t2);
      }
    }
    if (this.removeText(), t2 && !e2 && this.isCollapsed() && "element" === this.anchor.type && 0 === this.anchor.offset) {
      const t3 = this.anchor.getNode();
      t3.isEmpty() && Bi(t3.getParent()) && null === t3.getPreviousSibling() && mr(this, t3), ar();
    }
  }
  deleteLine(t2) {
    const e2 = Er(this.anchor);
    if (null !== e2 && Ki(ea(e2))) return this.isCollapsed() || this.focus.set(this.anchor.key, this.anchor.offset, this.anchor.type), void this.deleteCharacter(t2);
    if (this.isCollapsed() && vr(this, t2, "lineboundary"), this.isCollapsed()) this.deleteCharacter(t2);
    else qc(this.anchor.getNode(), Sc) !== qc(this.focus.getNode(), Sc) ? (this.focus.set(this.anchor.key, this.anchor.offset, this.anchor.type), this.deleteCharacter(t2)) : this.removeText();
  }
  deleteWord(t2) {
    if (this.isCollapsed()) {
      const e2 = this.anchor, n2 = e2.getNode();
      if (this.forwardDeletion(e2, n2, t2)) return;
      vr(this, t2, "word");
    }
    this.isCollapsed() ? this.deleteCharacter(t2) : this.removeText();
  }
  isBackward() {
    const t2 = this._cachedIsBackward;
    if (null !== t2) return t2;
    const e2 = this.focus.isBefore(this.anchor);
    return ui() || (this._cachedIsBackward = e2), e2;
  }
  getStartEndPoints() {
    return [this.anchor, this.focus];
  }
};
function dr(t2) {
  return t2 instanceof cr;
}
function hr(t2, e2) {
  if (dr(t2)) {
    for (const n3 of t2.getNodes()) Ro(n3) && n3.setFormat(e2(n3.getFormat()));
    return;
  }
  if (t2.isCollapsed()) return t2.setFormat(e2(t2.format)), void Vs(null);
  const n2 = [];
  for (const o3 of t2.getNodes()) Xo(o3) ? n2.push(o3) : Pi(o3) ? o3.setTextFormat(e2(o3.getTextFormat())) : Ro(o3) && o3.setFormat(e2(o3.getFormat()));
  const o2 = n2.length;
  if (0 === o2) return t2.setFormat(e2(t2.format)), void Vs(null);
  const r2 = t2.anchor, i2 = t2.focus, s2 = t2.isBackward(), l2 = s2 ? i2 : r2, c2 = s2 ? r2 : i2;
  let a2 = 0, u2 = n2[0], f2 = "element" === l2.type ? 0 : l2.offset;
  if ("text" === l2.type && f2 === u2.getTextContentSize() && (a2 = 1, u2 = n2[1], f2 = 0), null == u2) return;
  const d2 = o2 - 1;
  let h2 = n2[d2];
  const g2 = "text" === c2.type ? c2.offset : h2.getTextContentSize();
  if (u2.is(h2)) {
    if (f2 === g2) return;
    const n3 = e2(u2.getFormat());
    if (Ks(u2) || 0 === f2 && g2 === u2.getTextContentSize()) u2.setFormat(n3);
    else {
      const t3 = u2.splitText(f2, g2), e3 = 0 === f2 ? t3[0] : t3[1];
      e3.setFormat(n3), "text" === l2.type && l2.set(e3.__key, 0, "text"), "text" === c2.type && c2.set(e3.__key, g2 - f2, "text");
    }
    t2.format = n3;
    return;
  }
  0 === f2 || Ks(u2) || ([, u2] = u2.splitText(f2), f2 = 0);
  const _2 = e2(u2.getFormat());
  u2.setFormat(_2);
  const p = e2(h2.getFormat());
  g2 > 0 && (g2 === h2.getTextContentSize() || Ks(h2) || ([h2] = h2.splitText(g2)), h2.setFormat(p));
  for (let t3 = a2 + 1; t3 < d2; t3++) {
    const o3 = n2[t3];
    o3.setFormat(e2(o3.getFormat()));
  }
  "text" === l2.type && l2.set(u2.__key, f2, "text"), "text" === c2.type && c2.set(h2.__key, g2, "text"), t2.format = _2 | p;
}
function _r(t2, e2, n2 = null) {
  const o2 = null === n2 && ur(t2) ? Ws(t2.format, e2, null) : n2;
  hr(t2, (t3) => Ws(t3, e2, o2));
}
function pr(t2) {
  const e2 = t2.offset;
  if ("text" === t2.type) return e2;
  const n2 = t2.getNode();
  return e2 === n2.getChildrenSize() ? n2.getTextContent().length : 0;
}
function yr(t2) {
  const e2 = t2.getStartEndPoints();
  if (null === e2) return [0, 0];
  const [n2, o2] = e2;
  return "element" === n2.type && "element" === o2.type && n2.key === o2.key && n2.offset === o2.offset ? [0, 0] : [pr(n2), pr(o2)];
}
function mr(t2, e2) {
  for (let n2 = e2; n2; n2 = n2.getParent()) {
    if (Pi(n2)) {
      if (n2.collapseAtStart(t2)) return true;
      if (Bl(n2)) break;
    }
    if (n2.getPreviousSibling()) break;
  }
  return false;
}
function xr(t2) {
  const e2 = t2.focus, n2 = t2.anchor, o2 = n2.key, r2 = n2.offset, i2 = n2.type;
  n2.set(e2.key, e2.offset, e2.type, true), e2.set(o2, r2, i2, true);
}
function Cr(t2, e2, n2, o2) {
  t2.modify(e2, n2, o2);
}
function Sr(t2, e2, n2) {
  const o2 = t2.getNodes(), r2 = o2.filter((t3) => Fl(t3, n2));
  if (0 === r2.length || r2.length === o2.length) return false;
  const i2 = e2 ? r2[0] : r2[r2.length - 1], s2 = Pi(i2) ? i2 : i2.getParentOrThrow();
  return e2 ? s2.selectStart() : s2.selectEnd(), true;
}
function vr(t2, e2, n2) {
  if (ei(t2, "extend", e2, n2)) return;
  const o2 = _i(), r2 = Jl(Il(o2));
  if (!r2 || "function" != typeof r2.modify) return;
  const i2 = o2._blockCursorElement, s2 = o2._rootElement, l2 = t2.anchor, c2 = t2.focus.getNode();
  null === s2 || null === i2 || !Pi(c2) || c2.isInline() || c2.canBeEmpty() || jl(i2, o2, s2);
  const a2 = (t3) => {
    const e3 = t3.getNode(), n3 = o2.getElementByKey(t3.key);
    return null !== n3 && "text" === t3.type && Xo(e3) ? wc(e3, n3, o2) : n3;
  }, u2 = l2.getNode(), f2 = a2(l2);
  if (null === f2) return;
  const d2 = l2.offset, h2 = t2.isCollapsed(), g2 = t2.focus, _2 = h2 ? f2 : a2(g2);
  if (null === _2) return;
  const p = g2.offset;
  if (Ur(r2, _2, p, _2, p), Cr(r2, "move", e2 ? "backward" : "forward", n2), 0 === r2.rangeCount) return;
  const y = tc(r2, s2) || r2.getRangeAt(0), m = y.startContainer, x2 = y.startOffset;
  if (h2 && "character" === n2 && "text" === l2.type && Xo(u2) && u2.isUnmergeable()) {
    if (d2 === (e2 ? 0 : u2.getTextContentSize())) {
      const n3 = Ia(u2, e2 ? "previous" : "next").getNodeAtCaret();
      if (Xo(n3)) {
        const o3 = e2 ? n3.getTextContentSize() - 1 : 1;
        t2.focus.set(n3.__key, o3, "text"), t2.dirty = true;
        return;
      }
    }
  }
  if (h2 && "character" === n2 && "text" === l2.type) {
    const n3 = e2 ? 0 : u2.getTextContentSize(), o3 = m === f2 ? x2 : d2 !== n3 ? n3 : -1;
    if (o3 >= 0) return void (o3 !== d2 && (t2.focus.set(l2.key, o3, "text"), t2.dirty = true));
  }
  const [C, S, v, T] = e2 ? [
    m,
    x2,
    f2,
    d2
  ] : [
    f2,
    d2,
    m,
    x2
  ], k = Bi(u2) ? u2 : Kl(u2);
  t2.applyDOMRange({
    collapsed: false,
    endContainer: v,
    endOffset: T,
    startContainer: C,
    startOffset: S
  }), t2.dirty = true, !Sr(t2, e2, k) && e2 && xr(t2), "lineboundary" === n2 && ei(t2, "extend", e2, n2, "decorators");
}
var Tr = (() => {
  try {
    const t2 = /* @__PURE__ */ new RegExp("\\p{Emoji}", "u"), e2 = t2.test.bind(t2);
    if (e2("\u2764\uFE0F") && e2("#\uFE0F\u20E3") && e2("\u{1F44D}")) return e2;
  } catch (t2) {
  }
  return () => false;
})();
function kr(t2, e2, n2) {
  const o2 = t2, r2 = o2.getTextContent().split(/(?=\s)/g), i2 = r2.length;
  let s2 = 0, l2 = 0;
  for (let t3 = 0; t3 < i2; t3++) {
    const o3 = t3 === i2 - 1;
    if (l2 = s2, s2 += r2[t3].length, e2 && s2 === n2 || s2 > n2 || o3) {
      r2.splice(t3, 1), o3 && (l2 = void 0);
      break;
    }
  }
  const c2 = r2.join("").trim();
  "" === c2 ? o2.remove() : (o2.setTextContent(c2), o2.select(l2, l2));
}
function br(e2, n2, o2, r2) {
  let i2, s2 = n2, l2 = false;
  if (gc(e2)) {
    let c2 = false;
    const a2 = e2.childNodes, u2 = a2.length, f2 = r2._blockCursorElement;
    s2 === u2 && u2 > 0 && (c2 = true, s2 = u2 - 1), void 0 !== Qs(e2, r2) || Rc(e2, r2) || (l2 = true);
    let d2 = a2[s2], h2 = false;
    if (d2 === f2) d2 = a2[s2 + 1], h2 = true;
    else if (null !== f2) {
      const t2 = f2.parentNode;
      if (e2 === t2) n2 > Array.prototype.indexOf.call(t2.children, f2) && s2--;
    }
    if (i2 = il(d2), Xo(i2)) s2 = Ka(i2, c2 ? "next" : "previous");
    else {
      let a3 = il(e2);
      if (null === a3) return null;
      if (Pi(a3)) {
        const l3 = r2.getElementByKey(a3.getKey());
        null === l3 && t(214);
        const u3 = kc(a3, l3, r2);
        [a3, s2] = u3.resolveChildIndex(a3, l3, e2, n2), Pi(a3) || t(215), c2 && s2 >= a3.getChildrenSize() && (s2 = Math.max(0, a3.getChildrenSize() - 1));
        let f3 = a3.getChildAtIndex(s2);
        if (Pi(f3) && (function(t2, e3, n3) {
          const o3 = t2.getParent();
          return null === n3 || null === o3 || !o3.canBeEmpty() || o3 !== n3.getNode();
        })(f3, 0, o2)) {
          const t2 = c2 ? f3.getLastDescendant() : f3.getFirstDescendant();
          null === t2 ? a3 = f3 : (f3 = t2, a3 = Pi(f3) ? f3 : f3.getParentOrThrow()), s2 = 0;
        }
        Xo(f3) ? (i2 = f3, a3 = null, s2 = Ka(f3, c2 ? "next" : "previous")) : f3 !== a3 && c2 && !h2 && (Pi(a3) || t(216), s2 = Math.min(a3.getChildrenSize(), s2 + 1));
      } else {
        const t2 = ea(a3), o3 = null !== t2 ? t2 : a3, i3 = o3.getIndexWithinParent(), l3 = r2.getElementByKey(a3.getKey());
        let c3 = "after";
        if (null !== l3 && il(e2) === a3) {
          const t3 = kc(a3, l3, r2);
          t3.element !== l3 ? c3 = t3.resolveLeafPosition(l3, e2, n2) : 0 === n2 && Ki(a3) && (c3 = "before");
        }
        s2 = "before" === c3 ? i3 : i3 + 1, a3 = o3.getParentOrThrow();
      }
      if (Pi(a3)) return [or(a3.__key, s2, "element"), l2];
    }
  } else i2 = il(e2);
  return Xo(i2) ? [or(i2.__key, Ka(i2, s2, "clamp"), "text"), l2] : null;
}
function Nr(t2, e2, n2) {
  const o2 = t2.offset, r2 = t2.getNode();
  if (0 === o2) {
    const o3 = r2.getPreviousSibling(), i2 = r2.getParent();
    if (e2) {
      if ((n2 || !e2) && null === o3 && Pi(i2) && i2.isInline()) {
        const e3 = i2.getPreviousSibling();
        Xo(e3) && t2.set(e3.__key, e3.getTextContent().length, "text");
      }
    } else Pi(o3) && !n2 && o3.isInline() ? t2.set(o3.__key, o3.getChildrenSize(), "element") : Xo(o3) && !r2.isUnmergeable() && t2.set(o3.__key, o3.getTextContent().length, "text");
  } else if (o2 === r2.getTextContent().length) {
    const o3 = r2.getNextSibling(), i2 = r2.getParent();
    if (e2 && Pi(o3) && o3.isInline()) t2.set(o3.__key, 0, "element");
    else if ((n2 || e2) && null === o3 && Pi(i2) && i2.isInline() && !i2.canInsertTextAfter() && i2.getTextContentSize() > 1) {
      const e3 = i2.getNextSibling();
      Xo(e3) && t2.set(e3.__key, 0, "text");
    }
  }
}
function Er(t2) {
  const e2 = Ys(t2.key);
  return null === e2 ? null : oa(e2);
}
function wr(t2, e2, n2) {
  const o2 = Er(t2), r2 = Er(e2);
  if (o2 === r2 || null !== o2 && null !== r2 && o2.is(r2)) return false;
  const i2 = n2(o2, r2);
  if (null !== o2) return Pi(o2) ? e2.set(o2.getKey(), i2 ? o2.getChildrenSize() : 0, "element") : e2.set(o2.getKey(), i2 ? o2.getTextContentSize() : 0, "text"), true;
  const s2 = ea(r2);
  if (null === s2) return false;
  const l2 = s2.getParent();
  if (null === l2) return false;
  const c2 = s2.getIndexWithinParent();
  return e2.set(l2.getKey(), i2 ? c2 + 1 : c2, "element"), true;
}
function Or(t2) {
  const e2 = wr(t2.anchor, t2.focus, (e3, n2) => (function(t3, e4, n3, o2) {
    if (null !== n3 && null !== o2) {
      const t4 = ea(n3), e5 = ea(o2);
      if (null !== t4 && t4.is(e5)) {
        for (const e6 of ra(t4).values()) {
          if (e6 === n3.getKey()) return true;
          if (e6 === o2.getKey()) return false;
        }
        return true;
      }
      return null === t4 || null === e5 || t4.isBefore(e5);
    }
    if (null !== n3) {
      const t4 = ea(n3), o3 = Ys(e4.key);
      return null === t4 || null === o3 || !(!t4.is(o3) && !t4.isParentOf(o3)) || t4.isBefore(o3);
    }
    const r2 = ea(o2), i2 = Ys(t3.key);
    return null !== r2 && null !== i2 && !r2.is(i2) && !r2.isParentOf(i2) && i2.isBefore(r2);
  })(t2.anchor, t2.focus, e3, n2));
  return e2 && (t2.dirty = true), e2;
}
function Mr(t2, e2, n2, o2, r2, i2) {
  if (null === t2 || null === n2 || !As(r2, t2, n2)) return null;
  const s2 = br(t2, e2, ur(i2) ? i2.anchor : null, r2);
  if (null === s2) return null;
  const l2 = br(n2, o2, ur(i2) ? i2.focus : null, r2);
  if (null === l2) return null;
  const [c2, a2] = s2, [u2, f2] = l2;
  if ("element" === c2.type && "element" === u2.type) {
    const e3 = il(t2), o3 = il(n2);
    if (Ki(e3) && Ki(o3)) return null;
  }
  const d2 = r2._slotsUsed && wr(c2, u2, () => 0 !== (t2.compareDocumentPosition(n2) & Node.DOCUMENT_POSITION_FOLLOWING));
  return (function(t3, e3) {
    if ("text" === t3.type && "text" === e3.type) {
      const n3 = t3.isBefore(e3), o3 = t3.is(e3);
      Nr(t3, n3, o3), Nr(e3, !n3, o3), o3 && e3.set(t3.key, t3.offset, t3.type);
    }
  })(c2, u2), [
    c2,
    u2,
    a2 || f2 || d2
  ];
}
function Ar(t2) {
  return Pi(t2) && !t2.isInline();
}
function Dr(t2, e2, n2, o2, r2, i2) {
  const s2 = hi(), l2 = new fr(or(t2, e2, r2), or(n2, o2, i2), 0, "");
  return l2.dirty = true, s2._selection = l2, l2;
}
function Fr() {
  return new fr(or("root", 0, "element"), or("root", 0, "element"), 0, "");
}
function Pr() {
  return new cr(/* @__PURE__ */ new Set());
}
function Lr(t2, e2, n2, o2) {
  const r2 = n2._window;
  if (null === r2) return null;
  const i2 = o2 || r2.event, s2 = i2 ? i2.type : void 0, l2 = "selectionchange" === s2, c2 = !it$1 && (l2 || "beforeinput" === s2 || "compositionstart" === s2 || "compositionend" === s2 || "click" === s2 && i2 && 3 === i2.detail || "drop" === s2 || void 0 === s2);
  let a2, u2, f2, d2;
  if (ur(t2) && !c2) return t2.clone();
  {
    if (null === e2) return null;
    const o3 = nc(e2, n2._rootElement);
    if (a2 = o3.anchorNode, u2 = o3.focusNode, f2 = o3.anchorOffset, d2 = o3.focusOffset, (l2 || void 0 === s2) && ur(t2) && !As(n2, a2, u2)) return t2.clone();
  }
  const h2 = Mr(a2, f2, u2, d2, n2, t2);
  if (null === h2) return null;
  const [g2, _2, p] = h2;
  let y = 0, m = "";
  if (ur(t2)) {
    const e3 = t2.anchor;
    if (g2.key === e3.key) y = t2.format, m = t2.style;
    else {
      const t3 = g2.getNode();
      Xo(t3) ? (y = t3.getFormat(), m = t3.getStyle()) : Pi(t3) && (y = t3.getTextFormat(), m = t3.getTextStyle());
    }
  }
  const x2 = new fr(g2, _2, y, m);
  return p && (x2.dirty = true), x2;
}
function Kr() {
  return hi()._selection;
}
function zr() {
  return _i()._editorState._selection;
}
function Br(t2, e2, n2, o2 = 1) {
  const r2 = t2.anchor, i2 = t2.focus, s2 = r2.getNode(), l2 = i2.getNode();
  if (!e2.is(s2) && !e2.is(l2)) return;
  const c2 = e2.__key;
  if (t2.isCollapsed()) {
    const e3 = r2.offset;
    if (n2 <= e3 && o2 > 0 || n2 < e3 && o2 < 0) {
      const n3 = Math.max(0, e3 + o2);
      r2.set(c2, n3, "element"), i2.set(c2, n3, "element"), Rr(t2);
    }
  } else {
    const s3 = t2.isBackward(), l3 = s3 ? i2 : r2, a2 = l3.getNode(), u2 = s3 ? r2 : i2, f2 = u2.getNode();
    if (e2.is(a2)) {
      const t3 = l3.offset;
      (n2 <= t3 && o2 > 0 || n2 < t3 && o2 < 0) && l3.set(c2, Math.max(0, t3 + o2), "element");
    }
    if (e2.is(f2)) {
      const t3 = u2.offset;
      (n2 <= t3 && o2 > 0 || n2 < t3 && o2 < 0) && u2.set(c2, Math.max(0, t3 + o2), "element");
    }
  }
  Rr(t2);
}
function Rr(t2) {
  const e2 = t2.anchor, n2 = e2.offset, o2 = t2.focus, r2 = o2.offset, i2 = e2.getNode(), s2 = o2.getNode();
  if (t2.isCollapsed()) {
    if (!Pi(i2)) return;
    const t3 = i2.getChildrenSize(), r3 = n2 >= t3, s3 = r3 ? i2.getChildAtIndex(t3 - 1) : i2.getChildAtIndex(n2);
    if (Xo(s3)) {
      let t4 = 0;
      r3 && (t4 = s3.getTextContentSize()), e2.set(s3.__key, t4, "text"), o2.set(s3.__key, t4, "text");
    }
    return;
  }
  if (Pi(i2)) {
    const t3 = i2.getChildrenSize(), o3 = n2 >= t3, r3 = o3 ? i2.getChildAtIndex(t3 - 1) : i2.getChildAtIndex(n2);
    if (Xo(r3)) {
      let t4 = 0;
      o3 && (t4 = r3.getTextContentSize()), e2.set(r3.__key, t4, "text");
    }
  }
  if (Pi(s2)) {
    const t3 = s2.getChildrenSize(), e3 = r2 >= t3, n3 = e3 ? s2.getChildAtIndex(t3 - 1) : s2.getChildAtIndex(r2);
    if (Xo(n3)) {
      let t4 = 0;
      e3 && (t4 = n3.getTextContentSize()), o2.set(n3.__key, t4, "text");
    }
  }
}
function Wr(t2, e2, n2, o2, r2) {
  let i2 = null, s2 = 0, l2 = null;
  null !== o2 ? (i2 = o2.__key, Xo(o2) ? (s2 = o2.getTextContentSize(), l2 = "text") : Pi(o2) && (s2 = o2.getChildrenSize(), l2 = "element")) : null !== r2 && (i2 = r2.__key, Xo(r2) ? l2 = "text" : Pi(r2) && (l2 = "element")), null !== i2 && null !== l2 ? t2.set(i2, s2, l2) : (s2 = e2.getIndexWithinParent(), -1 === s2 && (s2 = n2.getChildrenSize()), t2.set(n2.__key, s2, "element"));
}
function $r(t2, e2, n2, o2, r2) {
  "text" === t2.type ? t2.set(n2, t2.offset + (e2 ? 0 : r2), "text") : t2.offset > o2.getIndexWithinParent() && t2.set(t2.key, t2.offset - 1, "element");
}
function Ur(t2, e2, n2, o2, r2) {
  try {
    t2.setBaseAndExtent(e2, n2, o2, r2);
  } catch (t3) {
  }
}
function Hr(t2, e2, n2) {
  const o2 = El(t2, e2.getKey());
  if (Pi(e2)) {
    const r2 = kc(e2, o2, t2);
    return [r2.element, n2 + r2.getFirstChildOffset()];
  }
  return [o2, n2];
}
function jr(t2, e2, n2, o2, r2, s2) {
  const l2 = s2.getRootNode(), c2 = Bs(l2) || ql(l2) ? cc(l2) : null;
  if (r2.has("collaboration") && c2 !== s2 || null !== c2 && Os(c2, c2)) return;
  const a2 = nc(o2, s2);
  let u2;
  if (!ur(e2)) return void (null !== t2 && As(n2, a2.anchorNode, a2.focusNode) && o2.removeAllRanges());
  const f2 = e2.anchor, d2 = e2.focus, h2 = f2.getNode(), g2 = d2.getNode(), [_2, p] = Hr(n2, h2, f2.offset), [y, m] = Hr(n2, g2, d2.offset), x2 = e2.format, C = e2.style, S = e2.isCollapsed();
  let v = _2, T = y, k = false;
  if ("text" === f2.type ? (v = Xo(h2) ? wc(h2, _2, n2) : null, k = h2.getFormat() !== x2 || h2.getStyle() !== C) : ur(t2) && "text" === t2.anchor.type && (k = true), "text" === d2.type && (T = Xo(g2) ? wc(g2, y, n2) : null), null !== v && null !== T) {
    if (S && (null === t2 || k || ur(t2) && (t2.format !== x2 || t2.style !== C)) && (function(t3, e3, n3, o3, r3, i2) {
      t3._inputState.collapsedSelectionFormat = {
        format: e3,
        key: r3,
        offset: o3,
        style: n3,
        timeStamp: i2
      };
    })(n2, x2, C, p, f2.key, performance.now()), ("Range" !== o2.type || !S) && a2.anchorOffset === p && a2.focusOffset === m && a2.anchorNode === v && a2.focusNode === T) {
      if (null === c2 || !s2.contains(c2)) {
        const t3 = null !== c2 ? Fs(c2) : null;
        null !== t3 && t3 !== n2 || r2.has("skip-selection-focus") || s2.focus({ preventScroll: true });
      }
      if ("element" !== f2.type) return;
    }
    if (Ur(o2, v, p, T, m), i && e2.isCollapsed() && null !== s2 && !r2.has("skip-selection-focus")) {
      const t3 = lc(s2);
      if (null === t3 || !s2.contains(t3)) {
        const t4 = cc(s2.ownerDocument), e3 = null !== t4 ? Fs(t4) : null;
        null !== e3 && e3 !== n2 || s2.focus({ preventScroll: true });
      }
    }
    if (!r2.has("skip-scroll-into-view") && e2.isCollapsed() && null !== s2 && s2 === lc(s2)) {
      const t3 = ur(e2) && "element" === e2.anchor.type ? v.childNodes[p] || null : (void 0 === u2 && (u2 = ec(o2, s2)), u2);
      if (null !== t3) {
        let e3;
        if (zs(t3)) {
          const n3 = t3.ownerDocument.createRange();
          n3.selectNode(t3), e3 = n3.getBoundingClientRect();
        } else e3 = t3.getBoundingClientRect();
        (function(t4, e4, n3) {
          const o3 = Ol(n3), r3 = Pl(o3);
          if (null === o3 || null === r3) return;
          const i2 = n3.getBoundingClientRect();
          if (e4.bottom < i2.top) return;
          let { top: s3, bottom: l3 } = e4, c3 = 0, a3 = 0, u3 = n3;
          for (; null !== u3; ) {
            const e5 = u3 === o3.body;
            if (e5) {
              const e6 = r3.visualViewport;
              if (e6) {
                const t5 = e6.offsetTop;
                c3 = t5, a3 = t5 + e6.height;
              } else c3 = 0, a3 = Il(t4).innerHeight;
              const n4 = r3.getComputedStyle(o3.documentElement), i3 = parseFloat(n4.scrollPaddingTop), s4 = parseFloat(n4.scrollPaddingBottom);
              isFinite(i3) && (c3 += i3), isFinite(s4) && (a3 -= s4);
            } else {
              const t5 = u3 === n3 ? i2 : u3.getBoundingClientRect();
              c3 = t5.top, a3 = t5.bottom;
            }
            let f3 = 0;
            if (s3 < c3 ? f3 = -(c3 - s3) : l3 > a3 && (f3 = l3 - a3), 0 !== f3) if (e5) r3.scrollBy(0, f3);
            else {
              const t5 = u3.scrollTop;
              u3.scrollTop += f3;
              const e6 = u3.scrollTop - t5;
              s3 -= e6, l3 -= e6;
            }
            if (e5) break;
            u3 = wl(u3);
          }
        })(n2, e3, s2);
      }
    }
    (function(t3) {
      t3._inputState.isSelectionChangeFromDOMUpdate = true;
    })(n2);
  }
}
function Vr(t2, e2) {
  for (const n2 of t2.split(/(\r?\n|\t)/)) "\n" === n2 || "\r\n" === n2 ? e2.linebreak() : "	" === n2 ? e2.tab() : "" !== n2 && e2.text(n2);
}
function qr(t2) {
  const e2 = [];
  return Vr(t2, {
    linebreak: () => e2.push(qi()),
    tab: () => e2.push(tr()),
    text: (t3) => e2.push(Go(t3))
  }), e2;
}
function Gr(t2) {
  const e2 = [];
  for (const n2 of t2) Yi(n2) || (!Pi(n2) && !Ki(n2) || n2.isInline() ? e2.push(n2) : Pi(n2) && e2.push(...Gr(n2.getChildren())));
  return e2;
}
function Xr(e2) {
  let n2 = e2;
  e2.isCollapsed() || n2.removeText();
  const o2 = Kr();
  ur(o2) && (n2 = o2), ur(n2) || t(161);
  const r2 = n2.anchor;
  let i2 = r2.getNode(), s2 = r2.offset;
  for (; !Sc(i2) && null === ta(i2); ) {
    const t2 = i2;
    if ([i2, s2] = Qr(i2, s2), t2.is(i2)) break;
  }
  return s2;
}
function Qr(t2, e2) {
  const n2 = t2.getParent();
  if (!n2) {
    const t3 = es();
    return nl().append(t3), t3.select(), [nl(), 0];
  }
  if (Xo(t2)) {
    const o3 = t2.splitText(e2);
    if (0 === o3.length) return [n2, t2.getIndexWithinParent()];
    const r2 = 0 === e2 ? 0 : 1;
    return [n2, o3[0].getIndexWithinParent() + r2];
  }
  if (!Pi(t2) || 0 === e2) return [n2, t2.getIndexWithinParent()];
  const o2 = t2.getChildAtIndex(e2);
  if (o2) {
    const n3 = new fr(or(t2.__key, e2, "element"), or(t2.__key, e2, "element"), 0, ""), r2 = t2.insertNewAfter(n3);
    r2 && r2.append(o2, ...o2.getNextSiblings());
  }
  return [n2, t2.getIndexWithinParent() + 1];
}
function Zr(t2) {
  return Yi(t2) || Ll(t2) || Xo(t2) || t2.isParentRequired();
}
function ti(t2) {
  const e2 = es();
  let n2 = null;
  for (let o2 = 0; o2 < t2.length; o2++) {
    const r2 = t2[o2];
    if (Zr(r2)) {
      if (null === n2) {
        n2 = r2.createParentElementNode(), e2.append(n2);
        const i2 = t2[o2 + 1];
        if (Yi(r2) && (void 0 === i2 || !Zr(i2))) continue;
      }
      n2.append(r2);
    } else e2.append(r2), n2 = null;
  }
  return e2;
}
function ei(t2, e2, n2, o2, r2 = "decorators-and-blocks") {
  if ("move" === e2 && "character" === o2 && !t2.isCollapsed()) {
    const [e3, o3] = n2 === t2.isBackward() ? [t2.focus, t2.anchor] : [t2.anchor, t2.focus];
    return o3.set(e3.key, e3.offset, e3.type), true;
  }
  const i2 = tu(t2.focus, n2 ? "previous" : "next"), s2 = "lineboundary" === o2, l2 = "move" === e2;
  let c2 = i2, a2 = "decorators-and-blocks" === r2;
  if (!uu(c2)) {
    for (const t3 of c2) {
      a2 = false;
      const { origin: e3 } = t3;
      if (!Ki(e3) || e3.isIsolated() || (c2 = t3, !s2 || !e3.isInline())) break;
    }
    if (a2) for (const t3 of ja(i2).iterNodeCarets("extend" === e2 ? "shadowRoot" : "root")) {
      if (Aa(t3)) t3.origin.isInline() || (c2 = t3);
      else {
        if (Pi(t3.origin)) continue;
        Ki(t3.origin) && !t3.origin.isInline() && (c2 = t3);
      }
      break;
    }
  }
  if (c2 === i2) return false;
  if (l2 && !s2 && Ki(c2.origin) && c2.origin.isKeyboardSelectable()) {
    const t3 = Pr();
    return t3.add(c2.origin.getKey()), ol(t3), true;
  }
  return c2 = au(c2), l2 && eu(t2.anchor, c2), eu(t2.focus, c2), a2 || !s2;
}
var ni = null;
var oi = null;
var ri = false;
var ii = false;
var si = false;
var li = /* @__PURE__ */ new Set();
var ci = 0;
var ai = {
  characterData: true,
  childList: true,
  subtree: true
};
function ui() {
  return ri || null !== ni && ni._readOnly;
}
function fi() {
  ri && t(13);
}
function di() {
  ci > 99 && t(14);
}
function hi() {
  return null === ni && t(195, yi()), ni;
}
function gi(t2) {
  null !== hi() && null === oi && (oi = t2), oi !== t2 && e(378);
}
function _i() {
  return null === oi && t(337, yi()), oi;
}
function pi() {
  _i()._dirtyType = 2;
}
function yi() {
  let t2 = 0;
  const e2 = /* @__PURE__ */ new Set(), n2 = Cs.version;
  if ("undefined" != typeof window) for (const o3 of Xl(document)) {
    const r2 = Ps(o3);
    if (Ds(r2)) t2++;
    else if (r2) {
      let t3 = String(r2.constructor.version || "<0.17.1");
      t3 === n2 && (t3 += " (separately built, likely a bundler configuration issue)"), e2.add(t3);
    }
  }
  let o2 = ` Detected on the page: ${t2} compatible editor(s) with version ${n2}`;
  return e2.size && (o2 += ` and incompatible editors with versions ${Array.from(e2).join(", ")}`), o2;
}
function mi() {
  return oi;
}
function xi(t2, e2, n2) {
  const o2 = e2.__type, r2 = Ns(t2, o2);
  let i2 = n2.get(o2);
  void 0 === i2 && (i2 = Array.from(r2.transforms), n2.set(o2, i2));
  const s2 = i2.length;
  for (let t3 = 0; t3 < s2 && (i2[t3](e2), e2.isAttached()); t3++) ;
}
function Ci(t2, e2) {
  return void 0 !== t2 && t2.__key !== e2 && t2.isAttached();
}
function Si(t2, e2) {
  if (!e2) return;
  const n2 = t2._updateTags;
  let o2 = e2;
  Array.isArray(e2) || (o2 = [e2]);
  for (const t3 of o2) n2.add(t3);
}
function Ti(e2, n2) {
  const o2 = e2.type, r2 = n2.get(o2);
  void 0 === r2 && t(17, o2);
  const i2 = r2.klass;
  e2.type !== i2.getType() && t(18, i2.name);
  const s2 = i2.importJSON(e2), l2 = e2.children;
  if (Pi(s2) && Array.isArray(l2)) for (let t2 = 0; t2 < l2.length; t2++) {
    const e3 = Ti(l2[t2], n2);
    s2.append(e3);
  }
  const c2 = e2.$slots;
  if (c2) {
    Qc(s2) || t(379, i2.name);
    for (const t2 in c2) pa(s2, t2, Ti(c2[t2], n2));
  }
  return s2;
}
function ki(t2, e2, n2) {
  const o2 = ni, r2 = ri, i2 = oi;
  ni = e2, ri = true, oi = t2;
  try {
    return n2();
  } finally {
    ni = o2, ri = r2, oi = i2;
  }
}
function bi(t2, e2) {
  const n2 = si;
  si = true;
  try {
    (function(t3, e3) {
      const n3 = t3._pendingEditorState, o2 = t3._rootElement, r2 = t3._headless || null === o2;
      if (null === n3) return void (!t3._updating && t3._deferred.length > 0 && wi(t3, t3._deferred));
      const i2 = t3._editorState, s2 = i2._selection, l2 = n3._selection, c2 = 0 !== t3._dirtyType, a2 = ni, u2 = ri, f2 = oi, d2 = t3._updating, h2 = t3._observer;
      let g2 = null;
      if (t3._pendingEditorState = null, t3._editorState = n3, !r2 && c2 && null !== h2) {
        oi = t3, ni = n3, ri = false, t3._updating = true;
        try {
          const e4 = t3._dirtyType, o3 = t3._dirtyElements, r3 = t3._dirtyLeaves;
          h2.disconnect(), g2 = De$2(i2, n3, t3, e4, o3, r3);
        } catch (e4) {
          if (e4 instanceof Error && t3._onError(e4), ii) throw e4;
          gs(t3, null, o2, n3), gt$1(t3), t3._dirtyType = 2, ii = true, bi(t3, i2), ii = false;
          return;
        } finally {
          h2.observe(o2, ai), t3._updating = d2, ni = a2, ri = u2, oi = f2;
        }
      }
      n3._readOnly || (n3._readOnly = true);
      const _2 = t3._dirtyLeaves, p = t3._dirtyElements, y = t3._normalizedNodes, m = t3._updateTags;
      c2 && (t3._dirtyType = 0, t3._cloneNotNeeded.clear(), t3._dirtyLeaves = /* @__PURE__ */ new Set(), t3._dirtyElements = /* @__PURE__ */ new Map(), t3._normalizedNodes = /* @__PURE__ */ new Set());
      t3._updateTags = /* @__PURE__ */ new Set(), (function(t4, e4) {
        const n4 = t4._decorators;
        let o3 = t4._pendingDecorators || n4;
        const r3 = e4._nodeMap;
        let i3;
        for (i3 in o3) r3.has(i3) || (o3 === n4 && (o3 = tl(t4)), delete o3[i3]);
      })(t3, n3);
      const x2 = r2 ? null : Jl(Il(t3));
      if (t3._editable && null !== x2 && (c2 || null === l2 || l2.dirty || !l2.is(s2)) && null !== o2 && !m.has("skip-dom-selection")) {
        oi = t3, ni = n3;
        try {
          if (null !== h2 && h2.disconnect(), c2 || null === l2 || l2.dirty) {
            const e4 = t3._blockCursorElement;
            null !== e4 && jl(e4, t3, o2), jr(s2, l2, t3, x2, m, o2);
          }
          (function(t4, e4, n4) {
            let o3 = t4._blockCursorElement;
            if (ur(n4) && n4.isCollapsed() && "element" === n4.anchor.type && e4.contains(lc(e4))) {
              const r3 = n4.anchor, i3 = r3.getNode(), s3 = r3.offset;
              let l3 = false, c3 = null;
              if (s3 === i3.getChildrenSize()) Hl(i3.getChildAtIndex(s3 - 1)) && (l3 = true);
              else {
                const e5 = i3.getChildAtIndex(s3);
                if (null !== e5 && Hl(e5)) {
                  const n5 = e5.getPreviousSibling();
                  (null === n5 || Hl(n5)) && (l3 = true, c3 = t4.getElementByKey(e5.__key));
                }
              }
              if (l3) {
                const n5 = kc(i3, t4.getElementByKey(i3.__key), t4).element;
                null === o3 && (t4._blockCursorElement = o3 = (function(t5) {
                  const e5 = t5.theme, n6 = Zl().createElement("div");
                  n6.contentEditable = "false", n6.setAttribute("data-lexical-cursor", "true");
                  let o4 = e5.blockCursor;
                  if (void 0 !== o4) {
                    if ("string" == typeof o4) o4 = e5.blockCursor = ku(o4);
                    void 0 !== o4 && n6.classList.add(...o4);
                  }
                  return n6;
                })(t4._config)), e4.style.caretColor = "transparent", null === c3 ? n5.appendChild(o3) : n5.insertBefore(o3, c3);
                return;
              }
            }
            null !== o3 && jl(o3, t4, e4);
          })(t3, o2, l2);
        } finally {
          null !== h2 && h2.observe(o2, ai), oi = f2, ni = a2;
        }
      }
      null !== g2 && (function(t4, e4, n4, o3, r3) {
        const i3 = Array.from(t4._listeners.mutation), s3 = i3.length;
        for (let t5 = 0; t5 < s3; t5++) {
          const [s4, l3] = i3[t5];
          for (const t6 of l3) {
            const i4 = e4.get(t6);
            void 0 !== i4 && s4(i4, {
              dirtyLeaves: o3,
              prevEditorState: r3,
              updateTags: n4
            });
          }
        }
      })(t3, g2, m, _2, i2);
      ur(l2) || null === l2 || null !== s2 && s2.is(l2) || t3.dispatchCommand(Ie$2);
      const C = t3._pendingDecorators;
      null !== C && (t3._decorators = C, t3._pendingDecorators = null, Ni("decorator", t3, true, C));
      if ((function(t4, e4, n4) {
        const o3 = el(e4), r3 = el(n4);
        o3 !== r3 && Ni("textcontent", t4, true, r3);
      })(t3, e3 || i2, n3), Ni("update", t3, true, {
        dirtyElements: p,
        dirtyLeaves: _2,
        editorState: n3,
        mutatedNodes: g2,
        normalizedNodes: y,
        prevEditorState: e3 || i2,
        tags: m
      }), !d2) wi(t3, t3._deferred);
      (function(t4) {
        const e4 = t4._updates;
        if (0 === e4.length) return void (t4._cascadeCount = 0);
        if ((function(t5) {
          if (li.has(t5)) return;
          li.add(t5), setTimeout(() => {
            li.delete(t5), t5._cascadeCount = 0;
          }, 0);
        })(t4), t4._cascadeCount++ > 99) return t4._updates = [], t4._cascadeCount = 0, void t4._onWarn(/* @__PURE__ */ new Error(`One or more update listeners are endlessly enqueueing more updates. May have encountered infinite recursion caused by update listeners that trigger additional updates without a stop condition. Editor namespace: ${t4._config.namespace}`));
        const n4 = e4.shift();
        if (n4) {
          const [e5, o3] = n4;
          Mi(t4, e5, o3);
        }
      })(t3);
    })(t2, e2);
  } finally {
    si = n2;
  }
}
function Ni(t2, e2, n2, ...o2) {
  const r2 = e2._updating;
  e2._updating = n2;
  try {
    const n3 = e2._listeners[t2], r3 = Array.from(n3);
    for (const [t3, e3] of r3) {
      e3 && e3();
      const r4 = t3(...o2);
      n3.has(t3) ? n3.set(t3, r4) : r4 && r4();
    }
  } finally {
    e2._updating = r2;
  }
}
function Ei(t2, e2, n2, o2) {
  const r2 = ll(t2);
  let i2;
  if (!si) for (let t3 = 0; t3 < r2.length; t3++) r2[t3]._updating || (r2[t3]._cascadeCount = 0);
  for (let t3 = 4; t3 >= 0; t3--) for (let s2 = 0; s2 < r2.length; s2++) {
    const l2 = r2[s2];
    if (s2 > 0 && l2._updating) {
      i2 = l2;
      break;
    }
    const c2 = l2._commands.get(e2);
    if (void 0 !== c2) {
      const e3 = c2[t3];
      if (e3.size > 0) {
        let t4 = false;
        if (Ai(l2, () => {
          for (const r3 of e3) if (r3(n2, o2)) return void (t4 = true);
        }), t4) return t4;
      }
    }
  }
  return i2 && i2.update(() => {
    Ei(i2, e2, n2, o2);
  }), false;
}
function wi(t2, e2) {
  if (t2._deferred = [], 0 !== e2.length) {
    const n2 = t2._updating;
    t2._updating = true;
    try {
      for (let t3 = 0; t3 < e2.length; t3++) e2[t3]();
    } finally {
      t2._updating = n2;
    }
  }
}
function Oi(e2, n2) {
  const o2 = e2._updates;
  let r2 = n2 || false;
  for (; 0 !== o2.length; ) {
    const n3 = o2.shift();
    if (n3) {
      const [o3, i2] = n3, s2 = e2._pendingEditorState;
      let l2;
      void 0 !== i2 && (l2 = i2.onUpdate, i2.skipTransforms && (r2 = true), i2.discrete && (null === s2 && t(191), s2._flushSync = true), l2 && e2._deferred.push(l2), Si(e2, i2.tag)), null == s2 ? Mi(e2, o3, i2) : o3();
    }
  }
  return r2;
}
function Mi(e2, n2, o2) {
  const r2 = e2._updateTags;
  let i2, s2 = false, l2 = false;
  void 0 !== o2 && (i2 = o2.onUpdate, Si(e2, o2.tag), s2 = o2.skipTransforms || false, l2 = o2.discrete || false), i2 && e2._deferred.push(i2);
  const c2 = e2._editorState;
  let a2 = e2._pendingEditorState, u2 = false;
  (null === a2 || a2._readOnly) && (a2 = e2._pendingEditorState = Ri(a2 || c2), u2 = true), a2._flushSync = l2;
  const f2 = ni, d2 = ri, h2 = oi, g2 = e2._updating;
  ni = a2, ri = false, e2._updating = true, oi = e2;
  const _2 = e2._headless || null === e2.getRootElement();
  vs(null);
  try {
    u2 && (_2 ? null !== c2._selection && (a2._selection = c2._selection.clone()) : a2._selection = (function(t2, e3) {
      const n3 = t2.getEditorState()._selection, o3 = Jl(Il(t2));
      return ur(n3) || null == n3 ? Lr(n3, o3, t2, e3) : n3.clone();
    })(e2, o2 && o2.event || null));
    const r3 = e2._compositionKey;
    n2(), s2 = Oi(e2, s2), (function(t2, e3) {
      const n3 = e3.getEditorState()._selection, o3 = t2._selection;
      if (ur(o3)) {
        const t3 = o3.anchor, e4 = o3.focus;
        let r4;
        if ("text" === t3.type && (r4 = t3.getNode(), r4.selectionTransform(n3, o3)), "text" === e4.type) {
          const t4 = e4.getNode();
          r4 !== t4 && t4.selectionTransform(n3, o3);
        }
      }
    })(a2, e2), 0 !== e2._dirtyType && (s2 ? (function(t2, e3) {
      const n3 = e3._dirtyLeaves, o3 = t2._nodeMap;
      for (const t3 of n3) {
        const e4 = o3.get(t3);
        Xo(e4) && e4.isAttached() && e4.isSimpleText() && !e4.isUnmergeable() && Pt$1(e4);
      }
    })(a2, e2) : (function(t2, e3) {
      const n3 = e3._dirtyLeaves, o3 = e3._dirtyElements, r4 = t2._nodeMap, i4 = qs(), s3 = /* @__PURE__ */ new Map();
      let l3 = n3, c3 = l3.size, a3 = o3, u3 = a3.size;
      for (; c3 > 0 || u3 > 0; ) {
        if (c3 > 0) {
          e3._dirtyLeaves = /* @__PURE__ */ new Set();
          for (const t3 of l3) {
            const o4 = r4.get(t3);
            Xo(o4) && o4.isAttached() && o4.isSimpleText() && !o4.isUnmergeable() && Pt$1(o4), void 0 !== o4 && Ci(o4, i4) && xi(e3, o4, s3), n3.add(t3);
          }
          if (l3 = e3._dirtyLeaves, c3 = l3.size, c3 > 0) {
            ci++;
            continue;
          }
        }
        e3._dirtyLeaves = /* @__PURE__ */ new Set(), e3._dirtyElements = /* @__PURE__ */ new Map(), a3.delete("root") && a3.set("root", true);
        for (const t3 of a3) {
          const n4 = t3[0], l4 = t3[1];
          if (o3.set(n4, l4), !l4) continue;
          const c4 = r4.get(n4);
          void 0 !== c4 && Ci(c4, i4) && xi(e3, c4, s3);
        }
        l3 = e3._dirtyLeaves, c3 = l3.size, a3 = e3._dirtyElements, u3 = a3.size, ci++;
      }
      e3._dirtyLeaves = n3, e3._dirtyElements = o3;
    })(a2, e2), Oi(e2), (function(t2, e3, n3, o3) {
      const r4 = t2._nodeMap, i4 = e3._nodeMap, s3 = [];
      for (const [t3] of o3) {
        const e4 = i4.get(t3);
        void 0 !== e4 && (e4.isAttached() || (Pi(e4) && rt$1(e4, t3, r4, i4, s3, o3), r4.has(t3) || o3.delete(t3), s3.push(t3)));
      }
      for (const t3 of n3) {
        const e4 = i4.get(t3);
        void 0 === e4 || e4.isAttached() || (Qc(e4) && null !== e4.__slots && rt$1(e4, t3, r4, i4, s3, n3), r4.has(t3) || n3.delete(t3), s3.push(t3));
      }
      for (const t3 of s3) i4.delete(t3);
      const l3 = _i(), c3 = l3._compositionKey;
      null === c3 || i4.has(c3) || (l3._compositionKey = null);
    })(c2, a2, e2._dirtyLeaves, e2._dirtyElements));
    r3 !== e2._compositionKey && (a2._flushSync = true);
    const i3 = a2._selection;
    if (ur(i3)) {
      e2._slotsUsed && Or(i3);
      const n3 = a2._nodeMap, o3 = i3.anchor.key, r4 = i3.focus.key;
      void 0 !== n3.get(o3) && void 0 !== n3.get(r4) || t(19);
    } else dr(i3) && 0 === i3._nodes.size && (a2._selection = null);
  } catch (t2) {
    t2 instanceof Error && e2._onError(t2), e2._pendingEditorState = c2, e2._dirtyType = 2, e2._cloneNotNeeded.clear(), e2._dirtyLeaves = /* @__PURE__ */ new Set(), e2._dirtyElements.clear(), bi(e2);
    return;
  } finally {
    ni = f2, ri = d2, oi = h2, e2._updating = g2, ci = 0;
  }
  0 !== e2._dirtyType || e2._deferred.length > 0 || (function(t2, e3) {
    const n3 = e3.getEditorState()._selection, o3 = t2._selection;
    if (null !== o3) {
      if (o3.dirty || !o3.is(n3)) return true;
    } else if (null !== n3) return true;
    return false;
  })(a2, e2) ? a2._flushSync ? (a2._flushSync = false, bi(e2)) : u2 && ws(() => {
    bi(e2);
  }) : (a2._flushSync = false, u2 && (r2.clear(), e2._deferred = [], e2._pendingEditorState = null));
}
function Ai(t2, e2, n2) {
  oi === t2 && void 0 === n2 ? ui() ? Mi(t2, e2, n2) : e2() : Mi(t2, e2, n2);
}
function Di(t2) {
  if (Bl(t2)) {
    let e2 = null;
    for (const n2 of t2.getChildren()) e2 = n2.isInline() ? (e2 || n2.replace(n2.createParentElementNode())).append(n2) : null;
  }
}
var Fi = class extends _o {
  __first;
  __last;
  __size;
  __format;
  __style;
  __indent;
  __dir;
  __textFormat;
  __textStyle;
  __slotHost;
  __slots;
  $config() {
    return this.config(Symbol.for("ElementNode"), {
      $transform: Di,
      extends: _o
    });
  }
  constructor(t2) {
    super(t2), this.__first = null, this.__last = null, this.__size = 0, this.__format = 0, this.__style = "", this.__indent = 0, this.__dir = null, this.__textFormat = 0, this.__textStyle = "", this.__slotHost = null, this.__slots = null;
  }
  afterCloneFrom(e2) {
    super.afterCloneFrom(e2), this.__key === e2.__key && (this.__first = e2.__first, this.__last = e2.__last, this.__size = e2.__size, this.__slotHost = e2.__slotHost, null !== this.__slotHost && null !== this.__parent && t(384, this.__key, String(this.__slotHost), String(this.__parent)), this.__slots = e2.__slots), this.__indent = e2.__indent, this.__format = e2.__format, this.__style = e2.__style, this.__dir = e2.__dir, this.__textFormat = e2.__textFormat, this.__textStyle = e2.__textStyle;
  }
  getFormat() {
    return this.getLatest().__format;
  }
  getFormatType() {
    return W[this.getFormat()] || "";
  }
  getStyle() {
    return this.getLatest().__style;
  }
  getIndent() {
    return this.getLatest().__indent;
  }
  getChildren() {
    const t2 = [];
    let e2 = this.getFirstChild();
    for (; null !== e2; ) t2.push(e2), e2 = e2.getNextSibling();
    return t2;
  }
  getChildrenKeys() {
    const t2 = [];
    let e2 = this.getFirstChild();
    for (; null !== e2; ) t2.push(e2.__key), e2 = e2.getNextSibling();
    return t2;
  }
  getChildrenSize() {
    return this.getLatest().__size;
  }
  isEmpty() {
    return 0 === this.getChildrenSize() && 0 === ia(this).length;
  }
  isDirty() {
    const t2 = _i()._dirtyElements;
    return null !== t2 && t2.has(this.__key);
  }
  isLastChild() {
    const t2 = this.getLatest(), e2 = this.getParentOrThrow().getLastChild();
    return null !== e2 && e2.is(t2);
  }
  getAllTextNodes() {
    const t2 = [];
    for (const e3 of ia(this)) {
      const n2 = sa(this, e3);
      Pi(n2) && t2.push(...n2.getAllTextNodes());
    }
    let e2 = this.getFirstChild();
    for (; null !== e2; ) {
      if (Xo(e2) && t2.push(e2), Pi(e2)) {
        const n2 = e2.getAllTextNodes();
        t2.push(...n2);
      }
      e2 = e2.getNextSibling();
    }
    return t2;
  }
  getFirstDescendant() {
    let t2 = this.getFirstChild();
    for (; Pi(t2); ) {
      const e2 = t2.getFirstChild();
      if (null === e2) break;
      t2 = e2;
    }
    return t2;
  }
  getLastDescendant() {
    let t2 = this.getLastChild();
    for (; Pi(t2); ) {
      const e2 = t2.getLastChild();
      if (null === e2) break;
      t2 = e2;
    }
    return t2;
  }
  getDescendantByIndex(t2) {
    const e2 = this.getChildren(), n2 = e2.length;
    if (t2 >= n2) {
      const t3 = e2[n2 - 1];
      return Pi(t3) && t3.getLastDescendant() || t3 || null;
    }
    const o2 = e2[t2];
    return Pi(o2) && o2.getFirstDescendant() || o2 || null;
  }
  getFirstChild() {
    const t2 = this.getLatest().__first;
    return null === t2 ? null : Ys(t2);
  }
  getFirstChildOrThrow() {
    const e2 = this.getFirstChild();
    return null === e2 && t(45, this.__key), e2;
  }
  getLastChild() {
    const t2 = this.getLatest().__last;
    return null === t2 ? null : Ys(t2);
  }
  getLastChildOrThrow() {
    const e2 = this.getLastChild();
    return null === e2 && t(96, this.__key), e2;
  }
  getChildAtIndex(t2) {
    const e2 = this.getChildrenSize();
    let n2, o2;
    if (t2 < e2 / 2) {
      for (n2 = this.getFirstChild(), o2 = 0; null !== n2 && o2 <= t2; ) {
        if (o2 === t2) return n2;
        n2 = n2.getNextSibling(), o2++;
      }
      return null;
    }
    for (n2 = this.getLastChild(), o2 = e2 - 1; null !== n2 && o2 >= t2; ) {
      if (o2 === t2) return n2;
      n2 = n2.getPreviousSibling(), o2--;
    }
    return null;
  }
  getTextContent() {
    let t2 = ha(this);
    const e2 = this.getChildren(), n2 = e2.length;
    for (let o2 = 0; o2 < n2; o2++) {
      const r2 = e2[o2];
      t2 += r2.getTextContent(), Pi(r2) && o2 !== n2 - 1 && !r2.isInline() && (t2 += D$1);
    }
    return t2;
  }
  getTextContentSize() {
    let t2 = (function(t3) {
      let e3 = 0;
      for (const n3 of ia(t3)) {
        const o2 = sa(t3, n3);
        null !== o2 && (e3 += o2.getTextContentSize());
      }
      return e3;
    })(this);
    const e2 = this.getChildren(), n2 = e2.length;
    for (let o2 = 0; o2 < n2; o2++) {
      const r2 = e2[o2];
      t2 += r2.getTextContentSize(), Pi(r2) && o2 !== n2 - 1 && !r2.isInline() && (t2 += 2);
    }
    return t2;
  }
  getDirection() {
    return this.getLatest().__dir;
  }
  getTextFormat() {
    return this.getLatest().__textFormat;
  }
  hasFormat(t2) {
    if ("" !== t2) {
      const e2 = R$1[t2];
      return 0 !== (this.getFormat() & e2);
    }
    return false;
  }
  hasTextFormat(t2) {
    const e2 = z$1[t2];
    return 0 !== (this.getTextFormat() & e2);
  }
  getFormatFlags(t2, e2) {
    return Ws(this.getLatest().__textFormat, t2, e2);
  }
  getTextStyle() {
    return this.getLatest().__textStyle;
  }
  select(t2, e2) {
    fi();
    const n2 = Kr();
    let o2 = t2, r2 = e2;
    const i2 = this.getChildrenSize();
    if (!this.canBeEmpty()) {
      if (0 === t2 && 0 === e2) {
        const t3 = this.getFirstChild();
        if (Xo(t3) || Pi(t3)) return t3.select(0, 0);
      } else if (!(void 0 !== t2 && t2 !== i2 || void 0 !== e2 && e2 !== i2)) {
        const t3 = this.getLastChild();
        if (Xo(t3) || Pi(t3)) return t3.select();
      }
    }
    void 0 === o2 && (o2 = i2), void 0 === r2 && (r2 = i2);
    const s2 = this.__key;
    return ur(n2) ? (n2.anchor.set(s2, o2, "element"), n2.focus.set(s2, r2, "element"), n2.dirty = true, n2) : Dr(s2, o2, s2, r2, "element", "element");
  }
  selectStart() {
    const t2 = this.getFirstDescendant();
    return t2 ? t2.selectStart() : this.select();
  }
  selectEnd() {
    const t2 = this.getLastDescendant();
    return t2 ? t2.selectEnd() : this.select();
  }
  clear() {
    const t2 = this.getWritable();
    return this.getChildren().forEach((t3) => t3.remove()), t2;
  }
  append(...t2) {
    return this.splice(this.getChildrenSize(), 0, t2);
  }
  setDirection(t2) {
    const e2 = this.getWritable();
    return e2.__dir = t2, e2;
  }
  setFormat(t2) {
    return this.getWritable().__format = "" !== t2 && R$1[t2] || 0, this;
  }
  setStyle(t2) {
    return this.getWritable().__style = t2 || "", this;
  }
  setTextFormat(t2) {
    const e2 = this.getWritable();
    return e2.__textFormat = t2, e2;
  }
  setTextStyle(t2) {
    const e2 = this.getWritable();
    return e2.__textStyle = t2, e2;
  }
  setIndent(t2) {
    return this.getWritable().__indent = t2, this;
  }
  splice(e2, n2, o2) {
    ho(this) && t(324, this.__key, this.__type);
    const r2 = this.getChildrenSize(), i2 = this.getWritable();
    e2 + n2 <= r2 || t(226, String(e2), String(n2), String(r2));
    for (const t2 of o2) ;
    const s2 = i2.__key, l2 = [], c2 = [], a2 = this.getChildAtIndex(e2 + n2);
    let u2 = null, f2 = r2 - n2 + o2.length;
    if (0 !== e2) if (e2 === r2) u2 = this.getLastChild();
    else {
      const t2 = this.getChildAtIndex(e2);
      null !== t2 && (u2 = t2.getPreviousSibling());
    }
    if (n2 > 0) {
      let e3 = null === u2 ? this.getFirstChild() : u2.getNextSibling();
      for (let o3 = 0; o3 < n2; o3++) {
        null === e3 && t(100);
        const n3 = e3.getNextSibling(), o4 = e3.__key;
        Hs(e3.getWritable()), c2.push(o4), e3 = n3;
      }
    }
    let d2 = u2;
    for (const e3 of o2) {
      null !== d2 && e3.is(d2) && (u2 = d2 = d2.getPreviousSibling());
      const n3 = e3.getWritable();
      n3.__parent === s2 && f2--, Hs(n3);
      const o3 = e3.__key;
      if (null === d2) i2.__first = o3, n3.__prev = null;
      else {
        const t2 = d2.getWritable();
        t2.__next = o3, n3.__prev = t2.__key;
      }
      e3.__key === s2 && t(76), n3.__parent = s2, l2.push(o3), d2 = e3;
    }
    if (e2 + n2 === r2) {
      if (null !== d2) d2.getWritable().__next = null, i2.__last = d2.__key;
    } else if (null !== a2) {
      const t2 = a2.getWritable();
      if (null !== d2) {
        const e3 = d2.getWritable();
        t2.__prev = d2.__key, e3.__next = a2.__key;
      } else t2.__prev = null;
    }
    if (i2.__size = f2, c2.length) {
      const t2 = Kr();
      if (ur(t2)) {
        const e3 = new Set(c2), n3 = new Set(l2), { anchor: o3, focus: r3 } = t2;
        Ii(o3, e3, n3) && Wr(o3, o3.getNode(), this, u2, a2), Ii(r3, e3, n3) && Wr(r3, r3.getNode(), this, u2, a2), 0 !== f2 || this.canBeEmpty() || Bl(this) || this.remove();
      }
    }
    return i2;
  }
  getDOMSlot(t2) {
    return new G(t2);
  }
  exportDOM(t2) {
    const { element: e2 } = super.exportDOM(t2);
    if (gc(e2)) {
      const t3 = this.getIndent();
      t3 > 0 && (e2.style.paddingInlineStart = 40 * t3 + "px", e2.setAttribute("data-lexical-indent", String(t3)));
      const n2 = this.getDirection();
      n2 && (e2.dir = n2);
    }
    return { element: e2 };
  }
  exportJSON() {
    const t2 = {
      children: [],
      direction: this.getDirection(),
      format: this.getFormatType(),
      indent: this.getIndent(),
      ...super.exportJSON()
    }, e2 = this.getTextFormat(), n2 = this.getTextStyle();
    return 0 === e2 && "" === n2 || Bl(this) || this.getChildren().some(Xo) || (0 !== e2 && (t2.textFormat = e2), "" !== n2 && (t2.textStyle = n2)), t2;
  }
  updateFromJSON(t2) {
    return super.updateFromJSON(t2).setFormat(t2.format).setIndent(t2.indent).setDirection(t2.direction).setTextFormat(t2.textFormat || 0).setTextStyle(t2.textStyle || "");
  }
  insertNewAfter(t2, e2) {
    return null;
  }
  canIndent() {
    return true;
  }
  collapseAtStart(t2) {
    return false;
  }
  excludeFromCopy(t2) {
    return false;
  }
  canReplaceWith(t2) {
    return true;
  }
  canInsertAfter(t2) {
    return true;
  }
  canBeEmpty() {
    return true;
  }
  canInsertTextBefore() {
    return true;
  }
  canInsertTextAfter() {
    return true;
  }
  isInline() {
    return false;
  }
  isShadowRoot() {
    return false;
  }
  canMergeWith(t2) {
    return false;
  }
  extractWithChild(t2, e2, n2) {
    return false;
  }
  canMergeWhenEmpty() {
    return false;
  }
  reconcileObservedMutation(t2, e2) {
    const n2 = kc(this, t2, e2);
    let o2 = n2.getFirstChild();
    for (let t3 = this.getFirstChild(); t3; t3 = t3.getNextSibling()) {
      const r2 = e2.getElementByKey(t3.getKey());
      null !== r2 && (null == o2 ? (n2.insertChild(r2), o2 = r2) : o2 !== r2 && n2.replaceChild(r2, o2), o2 = o2.nextSibling);
    }
  }
};
function Pi(t2) {
  return t2 instanceof Fi;
}
function Ii(t2, e2, n2) {
  let o2 = t2.getNode();
  for (; o2; ) {
    const t3 = o2.__key;
    if (e2.has(t3) && !n2.has(t3)) return true;
    o2 = o2.getParent();
  }
  return false;
}
var Li = class extends _o {
  __slotHost;
  __slots;
  constructor(t2) {
    super(t2), this.__slotHost = null, this.__slots = null;
  }
  afterCloneFrom(e2) {
    super.afterCloneFrom(e2), this.__key === e2.__key && (this.__slotHost = e2.__slotHost, null !== this.__slotHost && null !== this.__parent && t(383, this.__key, String(this.__slotHost), String(this.__parent)), this.__slots = e2.__slots);
  }
  decorate(t2, e2) {
    return null;
  }
  isIsolated() {
    return false;
  }
  isInline() {
    return true;
  }
  isKeyboardSelectable() {
    return true;
  }
};
function Ki(t2) {
  return t2 instanceof Li;
}
var zi = class extends Fi {
  __cachedText;
  $config() {
    return this.config("root", { extends: Fi });
  }
  constructor() {
    super("root"), this.__cachedText = null;
  }
  getTopLevelElementOrThrow() {
    t(51);
  }
  getTextContent() {
    const t2 = this.__cachedText;
    return null === t2 || !ui() && 0 !== _i()._dirtyType ? super.getTextContent() : t2;
  }
  remove() {
    t(52);
  }
  replace(e2) {
    t(53);
  }
  insertBefore(e2) {
    t(54);
  }
  insertAfter(e2) {
    t(55);
  }
  updateDOM(t2, e2) {
    return false;
  }
  splice(e2, n2, o2) {
    for (const e3 of o2) Pi(e3) || Ki(e3) || t(282);
    return super.splice(e2, n2, o2);
  }
  static importJSON(t2) {
    return nl().updateFromJSON(t2);
  }
  collapseAtStart() {
    return true;
  }
};
function Bi(t2) {
  return t2 instanceof zi;
}
function Ri(t2) {
  return new Hi(nt$2(t2._nodeMap), null, t2._slotsUsed);
}
function Wi() {
  return new Hi(/* @__PURE__ */ new Map([["root", new zi()]]), null, false);
}
function $i(e2) {
  const n2 = e2.exportJSON(), o2 = e2.constructor;
  if (n2.type !== o2.getType() && t(130, o2.name), Pi(e2)) {
    const r3 = n2.children;
    Array.isArray(r3) || t(59, o2.name);
    const i2 = e2.getChildren();
    for (let t2 = 0; t2 < i2.length; t2++) {
      const e3 = $i(i2[t2]);
      r3.push(e3);
    }
  }
  const r2 = ia(e2);
  if (r2.length > 0) {
    const i2 = {};
    for (const n3 of r2) {
      const r3 = sa(e2, n3);
      null === r3 && t(366, o2.name, n3), i2[n3] = $i(r3);
    }
    n2.$slots = i2;
  }
  return n2;
}
function Ui(t2) {
  return t2 instanceof Hi;
}
var Hi = class Hi2 {
  _nodeMap;
  _selection;
  _flushSync;
  _readOnly;
  _parsed;
  _slotsUsed;
  constructor(t2, e2 = null, n2 = false) {
    this._nodeMap = t2, this._selection = e2 || null, this._flushSync = false, this._readOnly = false, this._parsed = false, this._slotsUsed = n2;
  }
  isEmpty() {
    return 1 === this._nodeMap.size && null === this._selection;
  }
  read(t2, e2) {
    return ki(e2 && e2.editor || null, this, t2);
  }
  clone(t2) {
    const e2 = new Hi2(this._nodeMap, void 0 === t2 ? this._selection : t2, this._slotsUsed);
    return e2._readOnly = true, e2;
  }
  toJSON() {
    return ki(null, this, () => ({ root: $i(nl()) }));
  }
};
var ji = class extends Fi {
  $config() {
    return this.config("artificial", { extends: Fi });
  }
  createDOM(t2) {
    return Zl().createElement("div");
  }
};
var Ji = class extends _o {
  $config() {
    return this.config("linebreak", { importDOM: { br: (t2) => Gi(t2) || Xi(t2) ? null : {
      conversion: Vi,
      priority: 0
    } } });
  }
  getTextContent() {
    return "\n";
  }
  createDOM() {
    return Zl().createElement("br");
  }
  updateDOM() {
    return false;
  }
  isInline() {
    return true;
  }
};
function Vi(t2) {
  return { node: qi() };
}
function qi() {
  return Wl(new Ji());
}
function Yi(t2) {
  return t2 instanceof Ji;
}
function Gi(t2) {
  const e2 = t2.parentElement;
  if (null !== e2 && Cc(e2)) {
    const n2 = e2.firstChild;
    if (n2 === t2 || n2.nextSibling === t2 && Qi(n2)) {
      const n3 = e2.lastChild;
      if (n3 === t2 || n3.previousSibling === t2 && Qi(n3)) return true;
    }
  }
  return false;
}
function Xi(t2) {
  const e2 = t2.parentElement;
  if (null !== e2 && Cc(e2)) {
    const n2 = e2.firstChild;
    if (n2 === t2 || n2.nextSibling === t2 && Qi(n2)) return false;
    const o2 = e2.lastChild;
    if (o2 === t2 || o2.previousSibling === t2 && Qi(o2)) return true;
  }
  return false;
}
function Qi(t2) {
  return zs(t2) && /^( |\t|\r?\n)+$/.test(t2.textContent || "");
}
var Zi = class extends Fi {
  $config() {
    return this.config("paragraph", {
      extends: Fi,
      importDOM: { p: () => ({
        conversion: ts,
        priority: 0
      }) }
    });
  }
  createDOM(t2) {
    const e2 = Zl().createElement("p"), n2 = Cl(t2.theme, "paragraph");
    if (void 0 !== n2) e2.classList.add(...n2);
    return e2;
  }
  updateDOM(t2, e2, n2) {
    return false;
  }
  exportDOM(t2) {
    const { element: e2 } = super.exportDOM(t2);
    if (gc(e2)) {
      this.isEmpty() && e2.append(Zl().createElement("br"));
      const t3 = this.getFormatType();
      t3 && (e2.style.textAlign = t3);
    }
    return { element: e2 };
  }
  exportJSON() {
    const t2 = super.exportJSON();
    if (void 0 === t2.textFormat || void 0 === t2.textStyle) {
      const e2 = this.getChildren().find(Xo);
      e2 ? (t2.textFormat = e2.getFormat(), t2.textStyle = e2.getStyle()) : (t2.textFormat = this.getTextFormat(), t2.textStyle = this.getTextStyle());
    }
    return t2;
  }
  insertNewAfter(t2, e2) {
    const n2 = es();
    n2.setTextFormat(t2.format), n2.setTextStyle(t2.style);
    const o2 = this.getDirection();
    return n2.setDirection(o2), n2.setFormat(this.getFormatType()), n2.setStyle(this.getStyle()), this.insertAfter(n2, e2), n2;
  }
  collapseAtStart() {
    const t2 = this.getChildren();
    if (0 === t2.length || Xo(t2[0]) && "" === t2[0].getTextContent().trim()) {
      if (null !== this.getNextSibling()) return this.selectNext(), this.remove(), true;
      if (null !== this.getPreviousSibling()) return this.selectPrevious(), this.remove(), true;
    }
    return false;
  }
};
function ts(t2) {
  const e2 = es();
  if (Lc(e2, t2), Pc(t2, e2), "" === e2.getFormatType()) {
    const n2 = t2.getAttribute("align");
    n2 && n2 && n2 in R$1 && e2.setFormat(n2);
  }
  return Ic(e2, t2), { node: e2 };
}
function es() {
  return Wl(new Zi());
}
function ns(t2) {
  return t2 instanceof Zi;
}
function os(t2) {
  console.warn(t2);
}
function gs(t2, e2, n2, o2, r2) {
  const i2 = t2._keyToDOMMap;
  i2.clear(), t2._editorState = Wi(), t2._pendingEditorState = o2, t2._compositionKey = null, t2._dirtyType = 0, t2._cloneNotNeeded.clear(), t2._dirtyLeaves = /* @__PURE__ */ new Set(), t2._dirtyElements.clear(), t2._normalizedNodes = /* @__PURE__ */ new Set(), r2 && r2.preserveUpdateQueue || (t2._updateTags = /* @__PURE__ */ new Set(), t2._updates = [], t2._cascadeCount = 0), t2._blockCursorElement = null, null !== t2._inputState.handledSelectionCommandTimeoutId && clearTimeout(t2._inputState.handledSelectionCommandTimeoutId), t2._inputState = {
    collapsedSelectionFormat: {
      format: 0,
      key: "root",
      offset: 0,
      style: "",
      timeStamp: 0
    },
    compositionEndData: "",
    compositionPhase: "idle",
    hadOrphanedCompositionEvents: false,
    handledSelectionCommandTimeoutId: null,
    isInsertLineBreak: false,
    isInsertTextAfterHandledSelectionCommand: false,
    isSelectionChangeFromDOMUpdate: false,
    isSelectionChangeFromMouseDown: false,
    lastBeforeInputInsertTextTimeStamp: 0,
    lastKeyCode: null,
    lastKeyDownTimeStamp: 0,
    postDeleteSelectionToRestore: null,
    unprocessedBeforeInputData: null
  };
  const s2 = t2._observer;
  null !== s2 && (s2.disconnect(), t2._observer = null), null !== e2 && (e2.textContent = "", (function(t3, e3) {
    const n3 = `__lexicalKey_${e3._key}`;
    delete t3[n3];
  })(e2, t2)), null !== n2 && (n2.textContent = "", i2.set("root", n2), Xs(n2, t2, "root"));
}
function _s(t2) {
  const e2 = /* @__PURE__ */ new Set(), n2 = /* @__PURE__ */ new Set();
  for (const { klass: o2, ownNodeConfig: r2 } of jc(t2)) {
    const t3 = o2.transform;
    if (!n2.has(t3)) {
      n2.add(t3);
      const r3 = o2.transform();
      r3 && e2.add(r3);
    }
    if (r2) {
      const t4 = r2.$transform;
      t4 && e2.add(t4);
    }
  }
  return e2;
}
var ps = {
  $createDOM: (t2, e2) => t2.createDOM(e2._config, e2),
  $decorateDOM: (t2, e2, n2, o2) => {
  },
  $exportDOM: (t2, e2) => {
    const n2 = Es(e2, t2.getType());
    return n2 && void 0 !== n2.exportDOM ? n2.exportDOM(e2, t2) : t2.exportDOM(e2);
  },
  $extractWithChild: (t2, e2, n2, o2, r2) => Pi(t2) && t2.extractWithChild(e2, n2, o2),
  $getDOMSlot: (t2, e2, n2) => t2.getDOMSlot(e2),
  $getSlotTargetElement: (t2, e2, n2, o2) => null,
  $shouldExclude: (t2, e2, n2) => Pi(t2) && t2.excludeFromCopy("html"),
  $shouldInclude: (t2, e2, n2) => !e2 || t2.isSelected(e2),
  $updateDOM: (t2, e2, n2, o2) => t2.updateDOM(e2, n2, o2._config)
};
function ys(e2) {
  const n2 = e2 || {}, o2 = mi(), r2 = n2.theme || {}, i2 = void 0 === e2 ? o2 : n2.parentEditor || null, s2 = n2.disableEvents || false, l2 = Wi(), c2 = n2.namespace || (null !== i2 ? i2._config.namespace : cl()), a2 = n2.editorState, u2 = [
    zi,
    Wo,
    Ji,
    Zo,
    Zi,
    ji,
    ...n2.nodes || []
  ], { onError: f2, onWarn: d2, html: h2 } = n2, g2 = void 0 === n2.editable || n2.editable;
  let _2;
  if (void 0 === e2 && null !== o2) _2 = o2._nodes;
  else {
    _2 = /* @__PURE__ */ new Map();
    for (let e3 = 0; e3 < u2.length; e3++) {
      let o3 = u2[e3], r3 = null, i3 = null;
      if (o3 && "object" == typeof o3) {
        const t2 = o3;
        o3 = t2.replace, r3 = t2.with, i3 = t2.withKlass || null;
      }
      if ("function" != typeof o3 || !o3.prototype || !(o3 === _o || o3.prototype instanceof _o)) {
        let r4 = "<unknown>";
        try {
          r4 = JSON.parse(Z$1);
        } catch (t2) {
        }
        t(365, String(e3 - u2.length + (n2.nodes ? n2.nodes.length : 0)), "function" == typeof o3 ? `${o3.name}${"function" == typeof o3.getType ? ` (type ${String(o3.getType())})` : ""}` : String(o3), String(r4));
      }
      Hc(o3);
      const s3 = o3.getType(), l3 = _s(o3);
      _2.set(s3, {
        exportDOM: h2 && h2.export ? h2.export.get(o3) : void 0,
        klass: o3,
        replace: r3,
        replaceWithKlass: i3,
        sharedNodeState: vt$1(u2[e3]),
        transforms: l3
      });
    }
  }
  const p = new Cs(l2, i2, _2, {
    disableEvents: s2,
    dom: {
      ...ps,
      ...e2 && e2.dom
    },
    namespace: c2,
    theme: r2
  }, f2 || console.error, d2 || os, (function(t2, e3) {
    const n3 = /* @__PURE__ */ new Map(), o3 = /* @__PURE__ */ new Set(), r3 = (t3) => {
      Object.keys(t3).forEach((e4) => {
        let o4 = n3.get(e4);
        void 0 === o4 && (o4 = [], n3.set(e4, o4)), o4.push(t3[e4]);
      });
    };
    return t2.forEach((t3) => {
      const e4 = t3.klass.importDOM;
      if (null == e4 || o3.has(e4)) return;
      o3.add(e4);
      const n4 = e4.call(t3.klass);
      null !== n4 && r3(n4);
    }), e3 && r3(e3), n3;
  })(_2, h2 ? h2.import : void 0), g2, e2);
  return void 0 !== a2 && (p._pendingEditorState = a2, p._dirtyType = 2), (function(t2) {
    t2.registerCommand(ze$2, Yn, 0), t2.registerCommand(Be$2, Gn, 0), t2.registerCommand(Re, Xn, 0), t2.registerCommand(We$2, Qn, 0), t2.registerCommand(tn$2, eo, 0);
  })(p), p;
}
function ms(t2, e2) {
  const n2 = t2.get(e2);
  t2.delete(e2), n2 && n2();
}
function xs(t2, e2, n2) {
  return t2.set(e2, n2), ms.bind(null, t2, e2);
}
var Cs = class {
  static version;
  _headless;
  _parentEditor;
  _rootElement;
  _editorState;
  _pendingEditorState;
  _compositionKey;
  _deferred;
  _keyToDOMMap;
  _updates;
  _updating;
  _cascadeCount;
  _listeners;
  _commands;
  _nodes;
  _decorators;
  _pendingDecorators;
  _config;
  _dirtyType;
  _cloneNotNeeded;
  _dirtyLeaves;
  _dirtyElements;
  _normalizedNodes;
  _updateTags;
  _observer;
  _key;
  _onError;
  _onWarn;
  _htmlConversions;
  _window;
  _editable;
  _blockCursorElement;
  _slotsUsed;
  _inputState;
  _createEditorArgs;
  constructor(t2, e2, n2, o2, r2, i2, s2, l2, c2) {
    this._createEditorArgs = c2, this._parentEditor = e2, this._rootElement = null, this._editorState = t2, this._pendingEditorState = null, this._compositionKey = null, this._deferred = [], this._keyToDOMMap = new ot$1(), this._updates = [], this._updating = false, this._cascadeCount = 0, this._listeners = {
      decorator: /* @__PURE__ */ new Map(),
      editable: /* @__PURE__ */ new Map(),
      mutation: /* @__PURE__ */ new Map(),
      root: /* @__PURE__ */ new Map(),
      textcontent: /* @__PURE__ */ new Map(),
      update: /* @__PURE__ */ new Map()
    }, this._commands = /* @__PURE__ */ new Map(), this._config = o2, this._nodes = n2, this._decorators = {}, this._pendingDecorators = null, this._dirtyType = 0, this._cloneNotNeeded = /* @__PURE__ */ new Set(), this._dirtyLeaves = /* @__PURE__ */ new Set(), this._dirtyElements = /* @__PURE__ */ new Map(), this._normalizedNodes = /* @__PURE__ */ new Set(), this._updateTags = /* @__PURE__ */ new Set(), this._observer = null, this._key = cl(), this._onError = r2, this._onWarn = i2, this._htmlConversions = s2, this._editable = l2, this._headless = null !== e2 && e2._headless, this._window = null, this._blockCursorElement = null, this._slotsUsed = false, this._inputState = {
      collapsedSelectionFormat: {
        format: 0,
        key: "root",
        offset: 0,
        style: "",
        timeStamp: 0
      },
      compositionEndData: "",
      compositionPhase: "idle",
      hadOrphanedCompositionEvents: false,
      handledSelectionCommandTimeoutId: null,
      isInsertLineBreak: false,
      isInsertTextAfterHandledSelectionCommand: false,
      isSelectionChangeFromDOMUpdate: false,
      isSelectionChangeFromMouseDown: false,
      lastBeforeInputInsertTextTimeStamp: 0,
      lastKeyCode: null,
      lastKeyDownTimeStamp: 0,
      postDeleteSelectionToRestore: null,
      unprocessedBeforeInputData: null
    };
  }
  isComposing() {
    return null != this._compositionKey;
  }
  registerUpdateListener(t2) {
    return xs(this._listeners.update, t2);
  }
  registerEditableListener(t2) {
    return xs(this._listeners.editable, t2);
  }
  registerDecoratorListener(t2) {
    return xs(this._listeners.decorator, t2);
  }
  registerTextContentListener(t2) {
    return xs(this._listeners.textcontent, t2);
  }
  registerRootListener(t2) {
    const e2 = this._listeners.root;
    return Eu(xs(e2, t2, t2(this._rootElement, null) || void 0), () => (function(t3, e3, n2) {
      const o2 = t3.get(e3);
      o2 && o2(), t3.set(e3, e3(...n2) || void 0);
    })(e2, t2, [null, this._rootElement]));
  }
  registerCommand(e2, n2, o2) {
    void 0 === o2 && t(35);
    const r2 = this._commands;
    r2.has(e2) || r2.set(e2, [
      new tt(),
      new tt(),
      new tt(),
      new tt(),
      new tt()
    ]);
    const i2 = r2.get(e2);
    void 0 === i2 && t(36, String(e2));
    const s2 = (function(t2) {
      return 7 & t2;
    })(o2), l2 = i2[s2];
    return s2 !== o2 ? l2.addFront(n2) : l2.addBack(n2), () => {
      l2.delete(n2), i2.every((t2) => 0 === t2.size) && r2.delete(e2);
    };
  }
  registerMutationListener(t2, e2, n2) {
    const o2 = this.resolveRegisteredNodeAfterReplacements(this.getRegisteredNode(t2)).klass, r2 = this._listeners.mutation;
    let i2 = r2.get(e2);
    void 0 === i2 && (i2 = /* @__PURE__ */ new Set(), r2.set(e2, i2)), i2.add(o2);
    const s2 = n2 && n2.skipInitialization;
    return void 0 !== s2 && s2 || this.initializeMutationListener(e2, o2), () => {
      i2.delete(o2), 0 === i2.size && r2.delete(e2);
    };
  }
  getRegisteredNode(e2) {
    const n2 = this._nodes.get(e2.getType());
    return void 0 === n2 && t(37, e2.name), n2;
  }
  resolveRegisteredNodeAfterReplacements(t2) {
    for (; t2.replaceWithKlass; ) t2 = this.getRegisteredNode(t2.replaceWithKlass);
    return t2;
  }
  initializeMutationListener(t2, e2) {
    const n2 = this._editorState, o2 = Ac(n2).get(e2.getType());
    if (!o2) return;
    const r2 = /* @__PURE__ */ new Map();
    for (const t3 of o2.keys()) r2.set(t3, "created");
    r2.size > 0 && t2(r2, {
      dirtyLeaves: /* @__PURE__ */ new Set(),
      prevEditorState: n2,
      updateTags: /* @__PURE__ */ new Set(["registerMutationListener"])
    });
  }
  registerNodeTransformToKlass(t2, e2) {
    const n2 = this.getRegisteredNode(t2);
    return n2.transforms.add(e2), n2;
  }
  registerNodeTransform(t2, e2) {
    const n2 = this.registerNodeTransformToKlass(t2, e2), o2 = [n2], r2 = n2.replaceWithKlass;
    if (null != r2) {
      const t3 = this.registerNodeTransformToKlass(r2, e2);
      o2.push(t3);
    }
    return (function(t3, e3) {
      const n3 = Ac(t3.getEditorState()), o3 = [];
      for (const t4 of e3) {
        const e4 = n3.get(t4);
        e4 && o3.push(e4);
      }
      if (0 === o3.length) return;
      t3.update(() => {
        for (const t4 of o3) for (const e4 of t4.keys()) {
          const t5 = Ys(e4);
          t5 && t5.markDirty();
        }
      }, null === t3._pendingEditorState ? { tag: xo } : void 0);
    })(this, o2.map((t3) => t3.klass.getType())), () => {
      o2.forEach((t3) => t3.transforms.delete(e2));
    };
  }
  hasNode(t2) {
    return this._nodes.has(t2.getType());
  }
  hasNodes(t2) {
    return t2.every(this.hasNode.bind(this));
  }
  dispatchCommand(t2, ...e2) {
    return Nl(this, t2, ...e2);
  }
  getDecorators() {
    return this._decorators;
  }
  getRootElement() {
    return this._rootElement;
  }
  getKey() {
    return this._key;
  }
  setRootElement(t2) {
    const e2 = this._rootElement;
    if (t2 !== e2) {
      const n2 = Cl(this._config.theme, "root"), o2 = this._pendingEditorState || this._editorState;
      if (this._rootElement = t2, gs(this, e2, t2, o2, { preserveUpdateQueue: true }), null !== e2 && (this._config.disableEvents || co(e2), null != n2 && e2.classList.remove(...n2)), null !== t2) {
        const e3 = Pl(t2), o3 = t2.style;
        o3.userSelect = "text", o3.whiteSpace = "pre-wrap", o3.wordBreak = "break-word", t2.setAttribute("data-lexical-editor", "true"), this._window = e3, this._dirtyType = 2, gt$1(this), this._updateTags.add(xo), bi(this), this._config.disableEvents || (function(t3, e4) {
          const n3 = t3.ownerDocument;
          Ln.set(t3, n3);
          let o4 = Kn.get(n3);
          void 0 === o4 && (o4 = {
            editors: /* @__PURE__ */ new Set(),
            hasShadowEditor: void 0
          }, Kn.set(n3, o4)), o4.editors.add(e4), o4.hasShadowEditor = void 0, t3.__lexicalEditor = e4;
          const r2 = no(t3);
          r2.push(zn.register(n3));
          for (let n4 = 0; n4 < In.length; n4++) {
            const [o5, i2] = In[n4], s2 = "function" == typeof i2 ? (t4) => {
              so(t4) || (io(t4), (e4.isEditable() || "click" === o5) && i2(t4, e4));
            } : (t4) => {
              if (so(t4)) return;
              io(t4);
              const n5 = e4.isEditable();
              switch (o5) {
                case "cut":
                  return n5 && Nl(e4, Tn, t4);
                case "copy":
                  return Nl(e4, vn$2, t4);
                case "paste":
                  return n5 && Nl(e4, Je$2, t4);
                case "dragstart":
                  return n5 && Nl(e4, xn$1, t4);
                case "dragover":
                  return n5 && Nl(e4, Cn$1, t4);
                case "dragend":
                  return n5 && Nl(e4, Sn$2, t4);
                case "focus":
                  return n5 && Nl(e4, On$1, t4);
                case "blur":
                  return n5 && Nl(e4, Mn$1, t4);
                case "drop":
                  return n5 && Nl(e4, yn$1, t4);
              }
            };
            r2.push(Fn(t3, o5, s2));
          }
        })(t2, this), null != n2 && t2.classList.add(...n2);
      } else this._window = null, this._updateTags.add(xo), bi(this);
      Ni("root", this, false, t2, e2);
    }
  }
  getElementByKey(t2) {
    return this._keyToDOMMap.get(t2) || null;
  }
  getEditorState() {
    return this._editorState;
  }
  setEditorState(e2, n2) {
    e2.isEmpty() && t(38);
    let o2 = e2;
    o2._readOnly && (o2 = Ri(e2), o2._selection = e2._selection ? e2._selection.clone() : null), ht$2(this);
    const r2 = this._pendingEditorState, i2 = void 0 !== n2 ? n2.tag : null;
    null === r2 || r2.isEmpty() || (null != i2 && this._updateTags.add(i2), bi(this)), this._pendingEditorState = o2, this._dirtyType = 2, this._dirtyElements.set("root", false), this._compositionKey = null, this._slotsUsed = this._slotsUsed || e2._slotsUsed, Ai(this, () => {
      if (i2 && this._updateTags.add(i2), e2._parsed) for (const [t2, e3] of o2._nodeMap.entries()) Pi(e3) ? this._dirtyElements.set(t2, true) : this._dirtyLeaves.add(t2);
    }, { discrete: !this._updating || void 0 });
  }
  parseEditorState(t2, e2) {
    return (function(t3, e3, n2) {
      const o2 = Wi(), r2 = ni, i2 = ri, s2 = oi, l2 = e3._dirtyElements, c2 = e3._dirtyLeaves, a2 = e3._cloneNotNeeded, u2 = e3._dirtyType;
      e3._dirtyElements = /* @__PURE__ */ new Map(), e3._dirtyLeaves = /* @__PURE__ */ new Set(), e3._cloneNotNeeded = /* @__PURE__ */ new Set(), e3._dirtyType = 0, ni = o2, ri = false, oi = e3, vs(null);
      try {
        const r3 = e3._nodes;
        Ti(t3.root, r3), n2 && n2(), o2._readOnly = true, o2._parsed = true;
      } catch (t4) {
        t4 instanceof Error && e3._onError(t4);
      } finally {
        e3._dirtyElements = l2, e3._dirtyLeaves = c2, e3._cloneNotNeeded = a2, e3._dirtyType = u2, ni = r2, ri = i2, oi = s2;
      }
      return o2;
    })("string" == typeof t2 ? JSON.parse(t2) : t2, this, e2);
  }
  read(...t2) {
    const [e2, n2] = 1 === t2.length ? ["force-commit", t2[0]] : t2;
    "force-commit" === e2 && bi(this);
    return ("pending" === e2 ? this._pendingEditorState || this._editorState : this.getEditorState()).read(n2, { editor: this });
  }
  update(t2, e2) {
    (function(t3, e3, n2) {
      t3._updating ? t3._updates.push([e3, n2]) : Mi(t3, e3, n2);
    })(this, t2, e2);
  }
  focus(t2, e2 = {}) {
    const n2 = this._rootElement;
    null !== n2 && (n2.setAttribute("autocapitalize", "off"), Ai(this, () => {
      const o2 = Kr(), r2 = nl();
      null !== o2 ? o2.dirty || ol(o2.clone()) : 0 !== r2.getChildrenSize() && ("rootStart" === e2.defaultSelection ? r2.selectStart() : r2.selectEnd()), Al("focus"), Dl(() => {
        n2.removeAttribute("autocapitalize"), t2 && t2();
      });
    }), null === this._pendingEditorState && n2.removeAttribute("autocapitalize"));
  }
  blur() {
    const t2 = this._rootElement;
    null !== t2 && t2.blur();
    const e2 = Jl(this._window);
    null !== e2 && e2.removeAllRanges();
  }
  isEditable() {
    return this._editable;
  }
  setEditable(t2) {
    this._editable !== t2 && (this._editable = t2, Ni("editable", this, true, t2), this._slotsUsed && this.update(() => pi()));
  }
  toJSON() {
    return { editorState: this._editorState.toJSON() };
  }
};
Cs.version = Z$1;
var Ss = null;
function vs(t2) {
  Ss = t2;
}
var Ts = Symbol("INTERNAL_SKIP_AFTER_CLONE_FROM");
var ks = 1;
function Ns(e2, n2) {
  const o2 = Es(e2, n2);
  return void 0 === o2 && t(30, n2), o2;
}
function Es(t2, e2) {
  return t2._nodes.get(e2);
}
var ws = "function" == typeof queueMicrotask ? queueMicrotask : (t2) => {
  Promise.resolve().then(t2);
};
function Os(t2, e2) {
  const n2 = void 0 !== e2 ? e2 : (() => {
    const e3 = t2.getRootNode();
    return Bs(e3) || ql(e3) ? cc(e3) : null;
  })();
  if (!gc(n2)) return false;
  if (n2.hasAttribute("data-lexical-slot")) return false;
  const o2 = Zs(n2), r2 = n2.nodeName;
  return po(o2) && ("INPUT" === r2 || "TEXTAREA" === r2 || "true" === n2.contentEditable && null == Ps(n2));
}
function As(t2, e2, n2) {
  const o2 = t2.getRootElement();
  if (!o2) return false;
  try {
    if (!e2 || !o2.contains(e2) || !o2.contains(n2)) return false;
  } catch (t3) {
    return false;
  }
  return Fs(e2) === t2 && t2.read("latest", () => !Os(e2));
}
function Ds(t2) {
  return t2 instanceof Cs;
}
function Fs(t2) {
  let e2 = t2;
  for (; null != e2; ) {
    const t3 = Ps(e2);
    if (Ds(t3)) return t3;
    e2 = wl(e2);
  }
  return null;
}
function Ps(t2) {
  return t2 ? t2.__lexicalEditor : null;
}
function Ls(t2) {
  return er(t2) || t2.isToken();
}
function Ks(t2) {
  return Ls(t2) || t2.isSegmented();
}
function zs(t2) {
  return _c(t2) && 3 === t2.nodeType;
}
function Bs(t2) {
  return _c(t2) && 9 === t2.nodeType;
}
function Rs(t2) {
  let e2 = t2;
  for (; null != e2; ) {
    if (zs(e2)) return e2;
    e2 = e2.firstChild;
  }
  return null;
}
function Ws(t2, e2, n2) {
  const o2 = z$1[e2];
  if (null !== n2 && (t2 & o2) === (n2 & o2)) return t2;
  let r2 = t2 ^ o2;
  return "subscript" === e2 ? r2 &= ~z$1.superscript : "superscript" === e2 ? r2 &= ~z$1.subscript : "lowercase" === e2 ? (r2 &= ~z$1.uppercase, r2 &= ~z$1.capitalize) : "uppercase" === e2 ? (r2 &= ~z$1.lowercase, r2 &= ~z$1.capitalize) : "capitalize" === e2 && (r2 &= ~z$1.lowercase, r2 &= ~z$1.uppercase), r2;
}
function Us(t2, e2) {
  const n2 = (function() {
    const t3 = Ss;
    return Ss = null, t3;
  })();
  if (null != (e2 = e2 || n2 && n2.__key)) return void (t2.__key = e2);
  fi(), di();
  const o2 = _i(), r2 = hi(), i2 = "" + ks++;
  r2._nodeMap.set(i2, t2), Pi(t2) ? o2._dirtyElements.set(i2, true) : o2._dirtyLeaves.add(i2), o2._cloneNotNeeded.add(i2), 0 === o2._dirtyType && (o2._dirtyType = 1), t2.__key = i2;
}
function Hs(e2) {
  null !== ta(e2) && t(380, e2.__key, String(ta(e2)));
  const n2 = e2.getParent();
  if (null !== n2) {
    const t2 = e2.getWritable(), o2 = n2.getWritable(), r2 = e2.getPreviousSibling(), i2 = e2.getNextSibling(), s2 = null !== i2 ? i2.__key : null, l2 = null !== r2 ? r2.__key : null, c2 = null !== r2 ? r2.getWritable() : null, a2 = null !== i2 ? i2.getWritable() : null;
    null === r2 && (o2.__first = s2), null === i2 && (o2.__last = l2), null !== c2 && (c2.__next = s2), null !== a2 && (a2.__prev = l2), t2.__prev = null, t2.__next = null, t2.__parent = null, o2.__size--;
  }
}
function Js(e2) {
  di(), ho(e2) && t(323, e2.__key, e2.__type);
  const n2 = e2.getLatest(), o2 = null !== n2.__parent ? n2.__parent : Zc(n2) ? n2.__slotHost : null, r2 = hi(), i2 = _i(), s2 = r2._nodeMap, l2 = i2._dirtyElements;
  null !== o2 && (function(t2, e3, n3) {
    let o3 = t2;
    for (; null !== o3; ) {
      if (n3.has(o3)) return;
      const t3 = e3.get(o3);
      if (void 0 === t3) break;
      n3.set(o3, false), o3 = null !== t3.__parent ? t3.__parent : Zc(t3) ? t3.__slotHost : null;
    }
  })(o2, s2, l2);
  const c2 = n2.__key;
  0 === i2._dirtyType && (i2._dirtyType = 1), Pi(e2) ? l2.set(c2, true) : i2._dirtyLeaves.add(c2);
}
function Vs(t2) {
  fi();
  const e2 = _i(), n2 = e2._compositionKey;
  if (t2 !== n2) {
    if (e2._compositionKey = t2, null !== n2) {
      const t3 = Ys(n2);
      null !== t3 && t3.getWritable();
    }
    if (null !== t2) {
      const e3 = Ys(t2);
      null !== e3 && e3.getWritable();
    }
  }
}
function qs() {
  if (ui()) return null;
  return _i()._compositionKey;
}
function Ys(t2, e2) {
  const n2 = (e2 || hi())._nodeMap.get(t2);
  return void 0 === n2 ? null : n2;
}
function Gs(t2, e2) {
  const n2 = Qs(t2, _i());
  return void 0 !== n2 ? Ys(n2, e2) : null;
}
function Xs(t2, e2, n2) {
  t2[`__lexicalKey_${e2._key}`] = n2;
}
function Qs(t2, e2) {
  return t2[`__lexicalKey_${e2._key}`];
}
function Zs(t2, e2) {
  let n2 = t2;
  for (; null != n2; ) {
    const t3 = Gs(n2, e2);
    if (null !== t3) return t3;
    n2 = wl(n2);
  }
  return null;
}
function tl(t2) {
  const e2 = t2._decorators, n2 = Object.assign({}, e2);
  return t2._pendingDecorators = n2, n2;
}
function el(t2) {
  return t2.read(() => nl().getTextContent());
}
function nl() {
  return hi()._nodeMap.get("root");
}
function ol(t2) {
  fi();
  const e2 = hi();
  null !== t2 && (t2.dirty = true, t2.setCachedNodes(null), ur(t2) && _i()._slotsUsed && Or(t2)), e2._selection = t2;
}
function rl() {
  fi();
  ht$2(_i());
}
function il(t2) {
  const e2 = (function(t3, e3) {
    let n2 = t3;
    for (; null != n2; ) {
      const t4 = Qs(n2, e3);
      if (void 0 !== t4) return t4;
      n2 = wl(n2);
    }
    return null;
  })(t2, _i());
  return null === e2 ? null : Ys(e2);
}
function sl(t2) {
  return /[\uD800-\uDBFF][\uDC00-\uDFFF]/g.test(t2);
}
function ll(t2) {
  const e2 = [];
  for (let n2 = t2; null !== n2; n2 = n2._parentEditor) e2.push(n2);
  return e2;
}
function cl() {
  return Math.random().toString(36).replace(/[^a-z]+/g, "").substring(0, 5);
}
function al(t2) {
  return zs(t2) ? t2.nodeValue : null;
}
function ul(t2, e2, n2) {
  const o2 = Jl(Il(e2));
  if (null === o2) return;
  const r2 = nc(o2, e2._rootElement), i2 = r2.anchorNode;
  let { anchorOffset: s2, focusOffset: l2 } = r2;
  if (null !== i2) {
    let e3 = al(i2);
    const o3 = Zs(i2);
    if (null !== e3 && Xo(o3)) {
      if ((e3 === A || e3 === F) && n2) {
        const t3 = n2.length;
        e3 = n2, s2 = t3, l2 = t3;
      }
      null !== e3 && fl(o3, e3, s2, l2, t2);
    }
  }
}
function fl(t2, e2, n2, o2, r2) {
  let i2 = t2;
  if (i2.isAttached() && (r2 || !i2.isDirty())) {
    const s2 = i2.isComposing();
    if (i2.isToken() && s2) return;
    let c2 = e2;
    if ((s2 || r2) && (e2.endsWith(A) && (c2 = e2.slice(0, -A.length)), r2)) {
      const t3 = F;
      let e3;
      for (; -1 !== (e3 = c2.indexOf(t3)); ) c2 = c2.slice(0, e3) + c2.slice(e3 + t3.length), null !== n2 && n2 > e3 && (n2 = Math.max(e3, n2 - t3.length)), null !== o2 && o2 > e3 && (o2 = Math.max(e3, o2 - t3.length));
    }
    const u2 = i2.getTextContent();
    if (r2 || c2 !== u2) {
      const e3 = Kr();
      if ("" === c2) {
        if (Vs(null), a || l || d$1) i2.remove();
        else {
          const t3 = _i();
          dl(i2, "", e3), setTimeout(() => {
            t3.update(() => {
              i2.isAttached() && "" === i2.getTextContent() && i2.remove();
            });
          }, 20);
        }
        return;
      }
      const r3 = i2.getParent(), u3 = zr(), f2 = i2.getTextContentSize(), h2 = qs(), g2 = i2.getKey();
      if (i2.isToken() && !s2 || null !== h2 && g2 === h2 && !s2 || ur(u3) && (null !== r3 && !r3.canInsertTextBefore() && 0 === u3.anchor.offset || u3.anchor.key === t2.__key && 0 === u3.anchor.offset && !i2.canInsertTextBefore() && !s2 || u3.focus.key === t2.__key && u3.focus.offset === f2 && !i2.canInsertTextAfter() && !s2)) return void i2.markDirty();
      if (!ur(e3) || null === n2 || null === o2) return void dl(i2, c2, e3);
      if (e3.setTextNodeRange(i2, n2, i2, o2), i2.isSegmented()) {
        const t3 = Go(i2.getTextContent());
        i2.replace(t3), i2 = t3;
      }
      dl(i2, c2, e3);
    }
  }
}
function dl(t2, e2, n2) {
  if (t2.setTextContent(e2), ur(n2)) {
    const e3 = t2.getKey();
    let o2 = false;
    for (const r2 of ["anchor", "focus"]) {
      const i2 = n2[r2];
      "text" === i2.type && i2.key === e3 && (i2.offset = Ka(t2, i2.offset, "clamp"), o2 = true);
    }
    o2 && (n2._cachedNodes = null, n2._cachedIsBackward = null);
  }
}
function hl(t2, e2, n2) {
  const o2 = e2[n2] || false;
  return "any" === o2 || o2 === t2[n2];
}
function gl(t2, e2) {
  return hl(t2, e2, "altKey") && hl(t2, e2, "ctrlKey") && hl(t2, e2, "shiftKey") && hl(t2, e2, "metaKey");
}
function _l(t2, e2, n2) {
  if (!gl(t2, n2)) return false;
  if (t2.key.toLowerCase() === e2.toLowerCase()) return true;
  if (e2.length > 1) return false;
  if (1 === t2.key.length && t2.key.charCodeAt(0) <= 127) return false;
  if (t2.code.startsWith("Digit") && /^\d$/.test(e2)) return t2.code === `Digit${e2}`;
  const o2 = "Key" + e2.toUpperCase();
  return t2.code === o2;
}
var pl = {
  ctrlKey: !r$1,
  metaKey: r$1
};
var yl = {
  altKey: r$1,
  ctrlKey: !r$1
};
function ml(t2) {
  return "Backspace" === t2.key;
}
function xl(t2) {
  const e2 = nl();
  if (ur(t2)) {
    const e3 = t2.anchor, n2 = t2.focus, o2 = e3.getNode();
    if (Bi(o2)) return e3.set(o2.getKey(), 0, "element"), n2.set(o2.getKey(), o2.getChildrenSize(), "element"), It(t2), t2;
    const r2 = o2.getTopLevelElementOrThrow(), i2 = r2.getParent();
    if (null === i2) return Pi(r2) && (e3.set(r2.getKey(), 0, "element"), n2.set(r2.getKey(), r2.getChildrenSize(), "element"), It(t2)), t2;
    const s2 = i2;
    return e3.set(s2.getKey(), 0, "element"), n2.set(s2.getKey(), s2.getChildrenSize(), "element"), It(t2), t2;
  }
  {
    const t3 = e2.select(0, e2.getChildrenSize());
    return ol(It(t3)), t3;
  }
}
function Cl(t2, e2) {
  void 0 === t2.__lexicalClassNameCache && (t2.__lexicalClassNameCache = {});
  const n2 = t2.__lexicalClassNameCache, o2 = n2[e2];
  if (void 0 !== o2) return o2;
  const r2 = t2[e2];
  if ("string" == typeof r2) {
    const t3 = ku(r2);
    return n2[e2] = t3, t3;
  }
  return r2;
}
function Sl(e2, n2, o2, r2, i2) {
  if (0 === o2.size) return;
  const s2 = r2.__type, l2 = r2.__key, c2 = n2.get(s2);
  void 0 === c2 && t(33, s2);
  const a2 = c2.klass;
  let u2 = e2.get(a2);
  void 0 === u2 && (u2 = /* @__PURE__ */ new Map(), e2.set(a2, u2));
  const f2 = u2.get(l2), d2 = "destroyed" === f2 && "created" === i2;
  (void 0 === f2 || d2) && u2.set(l2, d2 ? "updated" : i2);
}
function Tl(t2, e2, n2) {
  const o2 = t2.getParent();
  let r2 = n2, i2 = t2;
  return null !== o2 && (e2 && 0 === n2 ? (r2 = i2.getIndexWithinParent(), i2 = o2) : e2 || n2 !== i2.getChildrenSize() || (r2 = i2.getIndexWithinParent() + 1, i2 = o2)), i2.getChildAtIndex(e2 ? r2 - 1 : r2);
}
function kl(t2, e2) {
  const n2 = t2.offset;
  if ("element" === t2.type) return Tl(t2.getNode(), e2, n2);
  {
    const o2 = t2.getNode();
    if (e2 && 0 === n2 || !e2 && n2 === o2.getTextContentSize()) {
      const t3 = e2 ? o2.getPreviousSibling() : o2.getNextSibling();
      return null === t3 ? Tl(o2.getParentOrThrow(), e2, o2.getIndexWithinParent() + (e2 ? 0 : 1)) : t3;
    }
  }
  return null;
}
function bl(t2) {
  const e2 = Il(t2).event, n2 = e2 && e2.inputType;
  return "insertFromPaste" === n2 || "insertFromPasteAsQuotation" === n2;
}
function Nl(t2, e2, ...n2) {
  return Ei(t2, e2, n2[0], t2);
}
function El(e2, n2) {
  const o2 = e2._keyToDOMMap.get(n2);
  return void 0 === o2 && t(75, n2), o2;
}
function wl(t2) {
  const e2 = t2.assignedSlot || t2.parentElement;
  if (null !== e2) return e2;
  const n2 = t2.parentNode;
  return ql(n2) ? n2.host : null;
}
function Ol(t2) {
  return Bs(t2) ? t2 : gc(t2) ? t2.ownerDocument : null;
}
function Al(t2) {
  fi();
  _i()._updateTags.add(t2);
}
function Dl(t2) {
  fi();
  _i()._deferred.push(t2);
}
function Fl(t2, e2) {
  let n2 = t2.getParent();
  for (; null !== n2; ) {
    if (n2.is(e2)) return true;
    n2 = n2.getParent();
  }
  return false;
}
function Pl(t2) {
  const e2 = Ol(t2);
  return e2 ? e2.defaultView : null;
}
function Il(e2) {
  const n2 = e2._window;
  return null === n2 && t(78), n2;
}
function Ll(t2) {
  return Pi(t2) && t2.isInline() || Ki(t2) && t2.isInline();
}
function Kl(t2) {
  let e2 = t2.getLatest();
  for (; null !== e2; ) {
    if (null !== ta(e2) && Pi(e2)) return e2;
    const t3 = e2.getParentOrThrow();
    if (Bl(t3)) return t3;
    e2 = t3;
  }
  return e2;
}
function zl(t2) {
  return Pi(t2) && t2.isShadowRoot();
}
function Bl(t2) {
  return Bi(t2) || zl(t2);
}
function Rl(t2, e2 = false) {
  const n2 = t2.constructor.clone(t2, Ts);
  return Us(n2, null), n2.afterCloneFrom(t2), e2 || n2.resetOnCopyNodeFrom(t2), n2;
}
function Wl(e2) {
  const n2 = _i(), o2 = e2.getType(), r2 = Es(n2, o2);
  void 0 === r2 && t(200, e2.constructor.name, o2);
  const { replace: i2, replaceWithKlass: s2 } = r2;
  if (null !== i2) {
    const n3 = i2(e2), r3 = n3.constructor;
    return null !== s2 ? n3 instanceof s2 || t(201, s2.name, s2.getType(), r3.name, r3.getType(), e2.constructor.name, o2) : n3 instanceof e2.constructor && r3 !== e2.constructor || t(202, r3.name, r3.getType(), e2.constructor.name, o2), n3.__key === e2.__key && t(203, e2.constructor.name, o2, r3.name, r3.getType()), n3;
  }
  return e2;
}
function $l(e2, n2) {
  !Bi(e2.getParent()) || Pi(n2) || Ki(n2) || t(99);
}
function Ul(e2) {
  const n2 = Ys(e2);
  return null === n2 && t(63, e2), n2;
}
function Hl(t2) {
  if (!t2 || t2.isInline()) return false;
  if (Ki(t2)) return true;
  if (Pi(t2)) {
    if (t2.isShadowRoot()) {
      const e2 = t2.getParent();
      return !(Pi(e2) && e2.isShadowRoot());
    }
    return !t2.canBeEmpty();
  }
  return false;
}
function jl(t2, e2, n2) {
  n2.style.removeProperty("caret-color"), e2._blockCursorElement = null;
  const o2 = t2.parentElement;
  null !== o2 && o2.removeChild(t2);
}
function Jl(t2) {
  return n ? (t2 || window).getSelection() : null;
}
function Vl(t2) {
  const e2 = Pl(t2);
  return e2 ? e2.getSelection() : null;
}
function ql(t2) {
  return pc(t2) && "host" in t2;
}
var Yl = [];
function Gl(t2) {
  const e2 = t2.getRootNode();
  if (e2 === t2 || !ql(e2)) return Yl;
  const n2 = [e2];
  let o2 = e2.host;
  for (; ; ) {
    const t3 = o2.getRootNode();
    if (t3 === o2 || !ql(t3)) break;
    n2.push(t3), o2 = t3.host;
  }
  return n2;
}
function* Xl(t2) {
  const e2 = [t2];
  let n2;
  for (; n2 = e2.pop(); ) {
    yield* n2.querySelectorAll('[data-lexical-editor="true"]');
    const t3 = (Bs(n2) ? n2 : n2.ownerDocument).createTreeWalker(n2, NodeFilter.SHOW_ELEMENT);
    let o2;
    for (; o2 = t3.nextNode(); ) o2.shadowRoot && e2.push(o2.shadowRoot);
  }
}
function Ql(t2) {
  return null !== t2 ? t2.ownerDocument : document;
}
function Zl() {
  const t2 = mi();
  return Ql(null !== t2 ? t2._rootElement : null);
}
function tc(t2, e2) {
  if (null === e2 || "function" != typeof t2.getComposedRanges) return null;
  const n2 = Gl(e2);
  if (0 === n2.length) return null;
  const o2 = t2.getComposedRanges;
  try {
    const e3 = o2.call(t2, { shadowRoots: n2 })[0];
    if (void 0 !== e3) return e3;
  } catch (t3) {
  }
  try {
    const e3 = o2.apply(t2, n2)[0];
    if (void 0 !== e3) return e3;
  } catch (t3) {
  }
  return null;
}
function ec(t2, e2) {
  const n2 = tc(t2, e2);
  if (null !== n2) {
    const t3 = rc(n2);
    if (null !== t3) return t3;
  }
  return t2.rangeCount > 0 ? t2.getRangeAt(0) : null;
}
function nc(t2, e2) {
  const n2 = tc(t2, e2);
  return null === n2 ? t2 : ic(n2, sc(t2));
}
function rc(t2) {
  const e2 = t2.startContainer.ownerDocument;
  if (null === e2) return null;
  const n2 = e2.createRange();
  try {
    return n2.setStart(t2.startContainer, t2.startOffset), n2.setEnd(t2.endContainer, t2.endOffset), n2;
  } catch (t3) {
    return null;
  }
}
function ic(t2, e2) {
  const { startContainer: n2, startOffset: o2, endContainer: r2, endOffset: i2 } = t2;
  return "backward" === e2 ? {
    anchorNode: r2,
    anchorOffset: i2,
    direction: e2,
    focusNode: n2,
    focusOffset: o2
  } : {
    anchorNode: n2,
    anchorOffset: o2,
    direction: e2,
    focusNode: r2,
    focusOffset: i2
  };
}
function sc(t2) {
  return t2.direction;
}
function lc(t2) {
  const e2 = t2.getRootNode();
  return Bs(e2) || ql(e2) ? e2.activeElement : null;
}
function cc(t2) {
  let e2 = t2.activeElement;
  for (; null !== e2 && null !== e2.shadowRoot; ) {
    const t3 = e2.shadowRoot.activeElement;
    if (null === t3) break;
    e2 = t3;
  }
  return e2;
}
function ac(t2) {
  const e2 = t2.target;
  if (null !== e2 && gc(e2) && null !== e2.shadowRoot && "function" == typeof t2.composedPath) {
    const e3 = t2.composedPath();
    if (e3.length > 0) return e3[0];
  }
  return e2;
}
function gc(t2) {
  return _c(t2) && 1 === t2.nodeType;
}
function _c(t2) {
  return "object" == typeof t2 && null !== t2 && "nodeType" in t2 && "number" == typeof t2.nodeType;
}
function pc(t2) {
  return _c(t2) && 11 === t2.nodeType;
}
var yc = /^(a|abbr|acronym|b|cite|code|del|em|i|ins|kbd|label|mark|output|q|ruby|s|samp|span|strong|sub|sup|time|u|tt|var|#text)$/i;
function mc(t2) {
  return !(!gc(t2) || !t2.style.display.startsWith("inline")) || yc.test(t2.nodeName);
}
var xc = /^(address|article|aside|blockquote|canvas|dd|div|dl|dt|fieldset|figcaption|figure|footer|form|h1|h2|h3|h4|h5|h6|header|hr|li|main|nav|noscript|ol|p|pre|section|table|td|tfoot|ul|video)$/i;
function Cc(t2) {
  return (!gc(t2) || !t2.style.display.startsWith("inline")) && xc.test(t2.nodeName);
}
function Sc(t2) {
  if (Ki(t2) && !t2.isInline()) return true;
  if (!Pi(t2) || Bl(t2)) return false;
  const e2 = t2.getFirstChild(), n2 = null === e2 || Yi(e2) || Xo(e2) || e2.isInline();
  return !t2.isInline() && false !== t2.canBeEmpty() && n2;
}
function vc() {
  return _i();
}
function Tc(t2 = vc()) {
  return t2._config.dom || ps;
}
function kc(e2, n2, o2 = vc()) {
  const r2 = Tc(o2).$getDOMSlot(e2, n2, o2);
  return Pi(e2) && (Ec(r2) || t(344, e2.getKey(), e2.getType())), r2;
}
function Ec(t2) {
  return t2 instanceof G;
}
function wc(t2, e2, n2 = vc()) {
  return Rs(kc(t2, e2, n2).element);
}
var Oc = /* @__PURE__ */ new WeakMap();
var Mc = /* @__PURE__ */ new Map();
function Ac(e2) {
  if (!e2._readOnly && e2.isEmpty()) return Mc;
  e2._readOnly || t(192);
  let n2 = Oc.get(e2);
  return n2 || (n2 = (function(t2) {
    const e3 = /* @__PURE__ */ new Map();
    for (const [n3, o2] of t2._nodeMap) {
      const t3 = o2.__type;
      let r2 = e3.get(t3);
      r2 || (r2 = /* @__PURE__ */ new Map(), e3.set(t3, r2)), r2.set(n3, o2);
    }
    return e3;
  })(e2), Oc.set(e2, n2)), n2;
}
function Dc(t2) {
  const e2 = t2.constructor.clone(t2, Ts);
  return e2.afterCloneFrom(t2), e2;
}
function Fc(t2) {
  return (e2 = Dc(t2))[fo] = true, e2;
  var e2;
}
function Pc(t2, e2) {
  const n2 = t2.getAttribute("data-lexical-indent");
  if (null !== n2) {
    const t3 = parseInt(n2, 10);
    if (Number.isFinite(t3) && t3 >= 0) return void e2.setIndent(t3);
  }
  const o2 = parseInt(t2.style.paddingInlineStart, 10) || 0, r2 = Math.round(o2 / 40);
  e2.setIndent(r2);
}
function Ic(t2, e2) {
  const n2 = e2.getAttribute("dir");
  return "ltr" === n2 || "rtl" === n2 ? t2.setDirection(n2) : t2;
}
function Lc(t2, e2) {
  const n2 = e2.style.textAlign;
  return n2 && n2 in R$1 ? t2.setFormat(n2) : t2;
}
function Kc(t2, e2) {
  t2.__lexicalUnmanaged = true, e2 && void 0 !== e2.captureSelection && (t2.__lexicalCapturedSelection = e2.captureSelection);
}
function zc(t2) {
  return true === t2.__lexicalUnmanaged;
}
function Bc(t2, e2 = vc()) {
  const n2 = e2.isEditable();
  t2.contentEditable = n2 ? "true" : "false", n2 ? t2.__lexicalEditor = e2 : delete t2.__lexicalEditor;
}
function Rc(t2, e2) {
  let n2 = t2;
  for (; null != n2; ) {
    if (true === n2.__lexicalCapturedSelection) return true;
    if (gc(n2) && n2.hasAttribute("data-lexical-slot")) return false;
    if (void 0 !== Qs(n2, e2)) return false;
    n2 = wl(n2);
  }
  return false;
}
function Wc(t2, e2) {
  return (function(t3, e3) {
    return Object.prototype.hasOwnProperty.call(t3, e3);
  })(t2, e2) && t2[e2] !== _o[e2];
}
var $c = /* @__PURE__ */ new WeakMap();
var Uc = Symbol("lexical.synthesizedGetType");
function Hc(e2) {
  const n2 = $c.get(e2);
  if (n2) return n2;
  const o2 = null != e2.prototype && j in e2.prototype ? e2.prototype[j]() : void 0, r2 = (function(e3) {
    if (!(e3 === _o || e3.prototype instanceof _o)) {
      let n3 = "<unknown>", o3 = "<unknown>";
      try {
        n3 = e3.getType();
      } catch (t2) {
      }
      try {
        Cs.version && (o3 = JSON.parse(Cs.version));
      } catch (t2) {
      }
      t(290, e3.name, n3, o3);
    }
    return e3 === Li || e3 === Fi || e3 === _o;
  })(e2), i2 = !r2 && Wc(e2, "getType") ? e2.getType : void 0, s2 = i2 && !(Uc in i2) ? i2.call(e2) : void 0;
  let l2, c2 = s2;
  if (o2) if (s2) l2 = o2[s2];
  else {
    for (const [t2, e3] of Object.entries(o2)) c2 = t2, l2 = e3;
    if (!l2) for (const t2 of Object.getOwnPropertySymbols(o2)) {
      const e3 = o2[t2];
      if (e3) {
        l2 = e3;
        break;
      }
    }
  }
  if (!r2 && c2) {
    if (!Wc(e2, "getType")) {
      const t2 = e2, n3 = function() {
        return this !== t2 ? _o.getType.call(this) : c2;
      };
      n3[Uc] = true, e2.getType = n3;
    }
    if (Wc(e2, "clone") || (e2.clone = (t2, n3) => {
      vs(t2);
      const o3 = new e2();
      return n3 !== Ts && o3.afterCloneFrom(t2), o3;
    }), Wc(e2, "importJSON") || (e2.importJSON = l2 && l2.$importJSON || ((t2) => new e2().updateFromJSON(t2))), !Wc(e2, "importDOM") && l2) {
      const { importDOM: t2 } = l2;
      t2 && (e2.importDOM = () => t2);
    }
  }
  const a2 = {
    klass: e2,
    ownNodeConfig: l2,
    ownNodeType: c2
  };
  return $c.set(e2, a2), a2;
}
function* jc(t2) {
  for (let e2 = t2; e2 && (e2 === _o || po(e2.prototype)); ) {
    const t3 = Hc(e2);
    yield t3, e2 = t3.ownNodeConfig && t3.ownNodeConfig.extends || Gc(e2);
  }
}
var qc = (t2, e2) => {
  let n2 = t2;
  for (; null != n2 && !Bi(n2); ) {
    if (e2(n2)) return n2;
    n2 = n2.getParent();
  }
  return null;
};
function Yc(e2, n2) {
  const o2 = [];
  let r2 = e2.__first;
  for (; null !== r2; ) {
    const e3 = null === n2 ? Ys(r2) : n2.get(r2);
    e3 ?? t(174), o2.push(r2), r2 = e3.__next;
  }
  return o2;
}
function Gc(t2) {
  const e2 = Object.getPrototypeOf(t2);
  if ("function" == typeof e2 && e2 !== Function.prototype) return e2;
  const n2 = t2.prototype && Object.getPrototypeOf(t2.prototype);
  return n2 ? n2.constructor : null;
}
var Xc = /* @__PURE__ */ new Map();
function Qc(t2) {
  return Pi(t2) || Ki(t2);
}
function Zc(t2) {
  return Pi(t2) || Ki(t2);
}
function ta(t2) {
  const e2 = t2.getLatest();
  return Zc(e2) ? e2.__slotHost : null;
}
function ea(e2) {
  const n2 = ta(e2);
  if (null === n2) return null;
  const o2 = Ys(n2);
  return Pi(o2) || Ki(o2) || t(370), o2;
}
function na(t2) {
  const e2 = ea(t2);
  if (null === e2) return null;
  const n2 = t2.getLatest().__key;
  for (const [t3, o2] of ra(e2)) if (o2 === n2) return t3;
  return null;
}
function oa(t2) {
  let e2 = t2.getLatest();
  for (; null !== e2; ) {
    if (null !== ta(e2)) return e2;
    e2 = e2.getParent();
  }
  return null;
}
function ra(t2) {
  const e2 = t2.getLatest();
  return Qc(e2) && null !== e2.__slots ? e2.__slots : Xc;
}
function ia(t2) {
  return Array.from(ra(t2).keys());
}
function sa(t2, e2) {
  const n2 = ra(t2).get(e2);
  return void 0 === n2 ? null : Ys(n2);
}
var la = [
  "__proto__",
  "constructor",
  "prototype"
];
var ca = Symbol("slotMapOwner");
function aa(t2) {
  let e2 = t2.__slots;
  return null !== e2 && e2[ca] === t2 || (e2 = new Map(e2), e2[ca] = t2, t2.__slots = e2), e2;
}
var ua = /* @__PURE__ */ new WeakMap();
var fa = [];
function da(t2) {
  for (const { ownNodeConfig: e2 } of jc(t2)) {
    const t3 = e2 && e2.slots;
    if (t3) return t3;
  }
  return fa;
}
function ha(t2) {
  let e2 = "";
  for (const n2 of ia(t2)) {
    const o2 = sa(t2, n2);
    null !== o2 && (e2 += o2.getTextContent());
  }
  return e2;
}
function ga(t2, e2, n2) {
  const o2 = n2.get(t2), r2 = n2.get(e2);
  return void 0 !== o2 ? void 0 !== r2 ? o2 - r2 : -1 : void 0 !== r2 ? 1 : t2 < e2 ? -1 : t2 > e2 ? 1 : 0;
}
function _a(e2) {
  const n2 = e2.__slots;
  if (null === n2 || n2.size < 2) return;
  const o2 = (function(e3) {
    let n3 = ua.get(e3);
    if (void 0 === n3) {
      const o3 = da(e3), r3 = /* @__PURE__ */ new Map();
      for (const n4 of o3) la.includes(n4) && t(371, e3.name, n4), r3.has(n4) && t(372, e3.name, n4), r3.set(n4, r3.size);
      n3 = r3, ua.set(e3, n3);
    }
    return n3;
  })(e2.constructor);
  let r2 = null, i2 = true;
  for (const t2 of n2.keys()) {
    if (null !== r2 && ga(r2, t2, o2) > 0) {
      i2 = false;
      break;
    }
    r2 = t2;
  }
  if (i2) return;
  const s2 = Array.from(n2).sort(([t2], [e3]) => ga(t2, e3, o2));
  n2.clear();
  for (const [t2, e3] of s2) n2.set(t2, e3);
}
function pa(e2, n2, o2) {
  "__proto__" !== n2 && "constructor" !== n2 && "prototype" !== n2 || t(373, n2);
  const r2 = e2.getLatest();
  if (null !== r2.__slots && r2.__slots.get(n2) === o2.getLatest().__key) return r2;
  (!Pi(o2) && !Ki(o2) || o2.isInline()) && t(374, o2.__key);
  const i2 = e2.getWritable(), s2 = aa(i2), l2 = s2.get(n2);
  void 0 !== l2 && xa(l2);
  const c2 = o2.getWritable(), a2 = ea(c2);
  if (null !== a2) {
    const t2 = na(c2);
    null !== t2 && aa(a2.getWritable()).delete(t2), c2.__slotHost = null;
  }
  return Hs(c2), c2.__slotHost = i2.__key, s2.set(n2, c2.__key), _a(i2), (function() {
    const t2 = vc();
    t2._slotsUsed = true, t2._pendingEditorState && (t2._pendingEditorState._slotsUsed = true);
  })(), i2;
}
function ya(t2, e2) {
  const n2 = t2.getWritable();
  if (null === n2.__slots) return n2;
  const o2 = n2.__slots.get(e2);
  return void 0 !== o2 && (xa(o2), aa(n2).delete(e2)), n2;
}
function xa(e2) {
  const n2 = Ys(e2);
  if (null === n2) return;
  const o2 = n2.getWritable();
  Zc(o2) || t(377, e2), o2.__slotHost = null, o2.remove();
}
var Ca = {
  next: "previous",
  previous: "next"
};
var Sa = class {
  origin;
  constructor(t2) {
    this.origin = t2;
  }
  [Symbol.iterator]() {
    return qa({
      hasNext: Ma,
      initial: this.getAdjacentCaret(),
      map: (t2) => t2,
      step: (t2) => t2.getAdjacentCaret()
    });
  }
  getAdjacentCaret() {
    return Ia(this.getNodeAtCaret(), this.direction);
  }
  getSiblingCaret() {
    return Ia(this.origin, this.direction);
  }
  remove() {
    const t2 = this.getNodeAtCaret();
    return t2 && t2.remove(), this;
  }
  replaceOrInsert(t2, e2) {
    const n2 = this.getNodeAtCaret();
    return t2.is(this.origin) || t2.is(n2) || (null === n2 ? this.insert(t2) : n2.replace(t2, e2)), this;
  }
  splice(e2, n2, o2 = "next") {
    const r2 = o2 === this.direction ? n2 : Array.from(n2).reverse();
    let i2 = this;
    const s2 = this.getParentAtCaret(), l2 = /* @__PURE__ */ new Map();
    for (let t2 = i2.getAdjacentCaret(); null !== t2 && l2.size < e2; t2 = t2.getAdjacentCaret()) {
      const e3 = t2.origin.getWritable();
      l2.set(e3.getKey(), e3);
    }
    for (const e3 of r2) {
      if (l2.size > 0) {
        const n3 = i2.getNodeAtCaret();
        if (n3) if (l2.delete(n3.getKey()), l2.delete(e3.getKey()), n3.is(e3) || i2.origin.is(e3)) ;
        else {
          const t2 = e3.getParent();
          t2 && t2.is(s2) && e3.remove(), n3.replace(e3);
        }
        else null === n3 && t(263, Array.from(l2).join(" "));
      } else i2.insert(e3);
      i2 = Ia(e3, this.direction);
    }
    for (const t2 of l2.values()) t2.remove();
    return this;
  }
};
var va = class va2 extends Sa {
  type = "child";
  getLatest() {
    const t2 = this.origin.getLatest();
    return t2 === this.origin ? this : Ba(t2, this.direction);
  }
  getParentCaret(t2 = "root") {
    return Ia(ba(this.getParentAtCaret(), t2), this.direction);
  }
  getFlipped() {
    const t2 = ka(this.direction);
    return Ia(this.getNodeAtCaret(), t2) || Ba(this.origin, t2);
  }
  getParentAtCaret() {
    return this.origin;
  }
  getChildCaret() {
    return this;
  }
  isSameNodeCaret(t2) {
    return t2 instanceof va2 && this.direction === t2.direction && this.origin.is(t2.origin);
  }
  isSamePointCaret(t2) {
    return this.isSameNodeCaret(t2);
  }
};
var Ta = {
  root: Bi,
  shadowRoot: Bl
};
function ka(t2) {
  return Ca[t2];
}
function ba(t2, e2 = "root") {
  return null === t2 || Ta[e2](t2) ? null : null === ta(t2) ? t2 : null;
}
var Na = class Na2 extends Sa {
  type = "sibling";
  getLatest() {
    const t2 = this.origin.getLatest();
    return t2 === this.origin ? this : Ia(t2, this.direction);
  }
  getSiblingCaret() {
    return this;
  }
  getParentAtCaret() {
    return this.origin.getParent();
  }
  getChildCaret() {
    return Pi(this.origin) ? Ba(this.origin, this.direction) : null;
  }
  getParentCaret(t2 = "root") {
    return Ia(ba(this.getParentAtCaret(), t2), this.direction);
  }
  getFlipped() {
    const t2 = ka(this.direction);
    return Ia(this.getNodeAtCaret(), t2) || Ba(this.origin.getParentOrThrow(), t2);
  }
  isSamePointCaret(t2) {
    return t2 instanceof Na2 && this.direction === t2.direction && this.origin.is(t2.origin);
  }
  isSameNodeCaret(t2) {
    return (t2 instanceof Na2 || t2 instanceof Ea) && this.direction === t2.direction && this.origin.is(t2.origin);
  }
};
var Ea = class Ea2 extends Sa {
  type = "text";
  offset;
  constructor(t2, e2) {
    super(t2), this.offset = e2;
  }
  getLatest() {
    const t2 = this.origin.getLatest();
    return t2 === this.origin ? this : La(t2, this.direction, this.offset);
  }
  getParentAtCaret() {
    return this.origin.getParent();
  }
  getChildCaret() {
    return null;
  }
  getParentCaret(t2 = "root") {
    return Ia(ba(this.getParentAtCaret(), t2), this.direction);
  }
  getFlipped() {
    return La(this.origin, ka(this.direction), this.offset);
  }
  isSamePointCaret(t2) {
    return t2 instanceof Ea2 && this.direction === t2.direction && this.origin.is(t2.origin) && this.offset === t2.offset;
  }
  isSameNodeCaret(t2) {
    return (t2 instanceof Na || t2 instanceof Ea2) && this.direction === t2.direction && this.origin.is(t2.origin);
  }
  getSiblingCaret() {
    return Ia(this.origin, this.direction);
  }
};
function wa(t2) {
  return t2 instanceof Ea;
}
function Ma(t2) {
  return t2 instanceof Na;
}
function Aa(t2) {
  return t2 instanceof va;
}
var Da = {
  next: class extends Ea {
    direction = "next";
    getNodeAtCaret() {
      return this.origin.getNextSibling();
    }
    insert(t2) {
      return this.origin.insertAfter(t2), this;
    }
  },
  previous: class extends Ea {
    direction = "previous";
    getNodeAtCaret() {
      return this.origin.getPreviousSibling();
    }
    insert(t2) {
      return this.origin.insertBefore(t2), this;
    }
  }
};
var Fa = {
  next: class extends Na {
    direction = "next";
    getNodeAtCaret() {
      return this.origin.getNextSibling();
    }
    insert(t2) {
      return this.origin.insertAfter(t2), this;
    }
  },
  previous: class extends Na {
    direction = "previous";
    getNodeAtCaret() {
      return this.origin.getPreviousSibling();
    }
    insert(t2) {
      return this.origin.insertBefore(t2), this;
    }
  }
};
var Pa = {
  next: class extends va {
    direction = "next";
    getNodeAtCaret() {
      return this.origin.getFirstChild();
    }
    insert(t2) {
      return this.origin.splice(0, 0, [t2]), this;
    }
  },
  previous: class extends va {
    direction = "previous";
    getNodeAtCaret() {
      return this.origin.getLastChild();
    }
    insert(t2) {
      return this.origin.splice(this.origin.getChildrenSize(), 0, [t2]), this;
    }
  }
};
function Ia(t2, e2) {
  return t2 ? new Fa[e2](t2) : null;
}
function La(t2, e2, n2) {
  return t2 ? new Da[e2](t2, Ka(t2, n2)) : null;
}
function Ka(t2, n2, o2 = "error") {
  const r2 = t2.getTextContentSize();
  let i2 = "next" === n2 ? r2 : "previous" === n2 ? 0 : n2;
  return (i2 < 0 || i2 > r2) && ("clamp" !== o2 && e(284, String(n2), String(r2), t2.getKey()), i2 = i2 < 0 ? 0 : r2), i2;
}
function za(t2, e2) {
  return new Ua(t2, e2);
}
function Ba(t2, e2) {
  return Pi(t2) ? new Pa[e2](t2) : null;
}
function Ra(t2) {
  return t2 && t2.getChildCaret() || t2;
}
function Wa(t2) {
  return t2 && Ra(t2.getAdjacentCaret());
}
var $a = class $a2 {
  type = "node-caret-range";
  direction;
  anchor;
  focus;
  constructor(t2, e2, n2) {
    this.anchor = t2, this.focus = e2, this.direction = n2;
  }
  getLatest() {
    const t2 = this.anchor.getLatest(), e2 = this.focus.getLatest();
    return t2 === this.anchor && e2 === this.focus ? this : new $a2(t2, e2, this.direction);
  }
  isCollapsed() {
    return this.anchor.isSamePointCaret(this.focus);
  }
  getTextSlices() {
    const t2 = (t3) => {
      const e3 = this[t3].getLatest();
      return wa(e3) ? (function(t4, e4) {
        const { direction: n3, origin: o2 } = t4;
        return za(t4, Ka(o2, "focus" === e4 ? ka(n3) : n3) - t4.offset);
      })(e3, t3) : null;
    }, e2 = t2("anchor"), n2 = t2("focus");
    if (e2 && n2) {
      const { caret: t3 } = e2, { caret: o2 } = n2;
      if (t3.isSameNodeCaret(o2)) return [za(t3, o2.offset - t3.offset), null];
    }
    return [e2, n2];
  }
  iterNodeCarets(t2 = "root") {
    const e2 = wa(this.anchor) ? this.anchor.getSiblingCaret() : this.anchor.getLatest(), n2 = this.focus.getLatest(), o2 = wa(n2), r2 = (e3) => e3.isSameNodeCaret(n2) ? null : Wa(e3) || e3.getParentCaret(t2);
    return qa({
      hasNext: (t3) => null !== t3 && !(o2 && n2.isSameNodeCaret(t3)),
      initial: e2.isSameNodeCaret(n2) ? null : r2(e2),
      map: (t3) => t3,
      step: r2
    });
  }
  [Symbol.iterator]() {
    return this.iterNodeCarets("root");
  }
};
var Ua = class {
  type = "slice";
  caret;
  distance;
  constructor(t2, e2) {
    this.caret = t2, this.distance = e2;
  }
  getSliceIndices() {
    const { distance: t2, caret: { offset: e2 } } = this, n2 = e2 + t2;
    return n2 < e2 ? [n2, e2] : [e2, n2];
  }
  getTextContent() {
    const [t2, e2] = this.getSliceIndices();
    return this.caret.origin.getTextContent().slice(t2, e2);
  }
  getTextContentSize() {
    return Math.abs(this.distance);
  }
  removeTextSlice() {
    const { caret: { origin: t2, direction: e2 } } = this, [n2, o2] = this.getSliceIndices(), r2 = t2.getTextContent();
    return La(t2.setTextContent(r2.slice(0, n2) + r2.slice(o2)), e2, n2);
  }
};
function ja(t2) {
  return Va(t2, Ia(nl(), t2.direction));
}
function Ja(t2) {
  return Va(t2, t2);
}
function Va(e2, n2) {
  return e2.direction !== n2.direction && t(265), new $a(e2, n2, e2.direction);
}
function qa(t2) {
  const { initial: e2, hasNext: n2, step: o2, map: r2 } = t2;
  let i2 = e2;
  return {
    [Symbol.iterator]() {
      return this;
    },
    next() {
      if (!n2(i2)) return {
        done: true,
        value: void 0
      };
      const t3 = {
        done: false,
        value: r2(i2)
      };
      return i2 = o2(i2), t3;
    }
  };
}
function Ya(e2, n2) {
  const o2 = Za(e2.origin, n2.origin);
  switch (null === o2 && t(275, e2.origin.getKey(), n2.origin.getKey()), o2.type) {
    case "same": {
      const t2 = "text" === e2.type, o3 = "text" === n2.type;
      return t2 && o3 ? (function(t3, e3) {
        return Math.sign(t3 - e3);
      })(e2.offset, n2.offset) : e2.type === n2.type ? 0 : t2 ? -1 : o3 ? 1 : "child" === e2.type ? -1 : 1;
    }
    case "ancestor":
      return "child" === e2.type ? -1 : 1;
    case "descendant":
      return "child" === n2.type ? 1 : -1;
    case "branch":
      return Ga(o2);
  }
}
function Ga(t2) {
  const { a: e2, b: n2 } = t2, o2 = e2.__key, r2 = n2.__key;
  let i2 = e2, s2 = n2;
  for (; i2 && s2; i2 = i2.getNextSibling(), s2 = s2.getNextSibling()) {
    if (i2.__key === r2) return -1;
    if (s2.__key === o2) return 1;
  }
  return null === i2 ? 1 : -1;
}
function Xa(t2, e2) {
  return e2.is(t2);
}
function Qa(t2) {
  return Pi(t2) ? [t2.getLatest(), null] : [t2.getParent(), t2.getLatest()];
}
function Za(e2, n2) {
  if (e2.is(n2)) return {
    commonAncestor: e2,
    type: "same"
  };
  const o2 = /* @__PURE__ */ new Map();
  for (let [t2, n3] = Qa(e2); t2; n3 = t2, t2 = t2.getParent()) o2.set(t2, n3);
  for (let [r2, i2] = Qa(n2); r2; i2 = r2, r2 = r2.getParent()) {
    const s2 = o2.get(r2);
    if (void 0 !== s2) return null === s2 ? (Xa(e2, r2) || t(276), {
      commonAncestor: r2,
      type: "ancestor"
    }) : null === i2 ? (Xa(n2, r2) || t(277), {
      commonAncestor: r2,
      type: "descendant"
    }) : ((Pi(s2) || Xa(e2, s2)) && (Pi(i2) || Xa(n2, i2)) && r2.is(s2.getParent()) && r2.is(i2.getParent()) || t(278), {
      a: s2,
      b: i2,
      commonAncestor: r2,
      type: "branch"
    });
  }
  return null;
}
function tu(e2, n2) {
  const { type: o2, key: r2, offset: i2 } = e2, s2 = Ul(e2.key);
  return "text" === o2 ? (Xo(s2) || t(266, s2.getType(), r2), La(s2, n2, i2)) : (Pi(s2) || t(267, s2.getType(), r2), hu(s2, e2.offset, n2));
}
function eu(e2, n2) {
  const { origin: o2, direction: r2 } = n2, i2 = "next" === r2;
  wa(n2) ? e2.set(o2.getKey(), n2.offset, "text") : Ma(n2) ? Xo(o2) ? e2.set(o2.getKey(), Ka(o2, r2), "text") : e2.set(o2.getParentOrThrow().getKey(), o2.getIndexWithinParent() + (i2 ? 1 : 0), "element") : (Aa(n2) && Pi(o2) || t(268), e2.set(o2.getKey(), i2 ? 0 : o2.getChildrenSize(), "element"));
}
function nu(t2) {
  const e2 = Kr(), n2 = ur(e2) ? e2 : Fr();
  return ou(n2, t2), ol(n2), n2;
}
function ou(t2, e2) {
  eu(t2.anchor, e2.anchor), eu(t2.focus, e2.focus);
}
function ru(t2) {
  const { anchor: e2, focus: n2 } = t2, o2 = tu(e2, "next"), r2 = tu(n2, "next"), i2 = Ya(o2, r2) <= 0 ? "next" : "previous";
  return Va(fu(o2, i2), fu(r2, i2));
}
function iu(t2) {
  const { direction: e2, origin: n2 } = t2, o2 = Ia(n2, ka(e2)).getNodeAtCaret();
  return o2 ? Ia(o2, e2) : Ba(n2.getParentOrThrow(), e2);
}
function su(t2, e2 = "root") {
  const n2 = [t2];
  for (let o2 = Aa(t2) ? t2.getParentCaret(e2) : t2.getSiblingCaret(); null !== o2; o2 = o2.getParentCaret(e2)) n2.push(iu(o2));
  return n2;
}
function lu(t2) {
  return !!t2 && t2.origin.isAttached();
}
function cu(e2, n2 = "removeEmptySlices") {
  if (e2.isCollapsed()) return e2;
  const o2 = "root", r2 = "next";
  let i2 = n2;
  const s2 = du(e2, r2), l2 = su(s2.anchor, o2), c2 = su(s2.focus.getFlipped(), o2), a2 = /* @__PURE__ */ new Set(), u2 = [];
  for (const t2 of s2.iterNodeCarets(o2)) if (Aa(t2)) a2.add(t2.origin.getKey());
  else if (Ma(t2)) {
    const { origin: e3 } = t2;
    Pi(e3) && !a2.has(e3.getKey()) || u2.push(e3);
  }
  const f2 = /* @__PURE__ */ new Set();
  for (const t2 of u2) {
    const e3 = t2.getParent();
    null === e3 || a2.has(e3.getKey()) || f2.add(e3), Hs(t2);
  }
  for (const t2 of f2) !t2.canBeEmpty() && !Bl(t2) && t2.isEmpty() && t2.isAttached() && t2.remove();
  for (const t2 of s2.getTextSlices()) {
    if (!t2) continue;
    const { origin: e3 } = t2.caret, n3 = e3.getTextContentSize(), o3 = iu(Ia(e3, r2)), s3 = e3.getMode();
    if (Math.abs(t2.distance) === n3 && "removeEmptySlices" === i2 || "token" === s3 && 0 !== t2.distance) o3.remove();
    else if (0 !== t2.distance) {
      i2 = "removeEmptySlices";
      let e4 = t2.removeTextSlice();
      const n4 = t2.caret.origin;
      if ("segmented" === s3) {
        const t3 = e4.origin, n5 = Go(t3.getTextContent()).setStyle(t3.getStyle()).setFormat(t3.getFormat());
        o3.replaceOrInsert(n5), e4 = La(n5, r2, e4.offset);
      }
      n4.is(l2[0].origin) && (l2[0] = e4), n4.is(c2[0].origin) && (c2[0] = e4.getFlipped());
    }
  }
  let d2, h2;
  for (const t2 of l2) if (lu(t2)) {
    d2 = au(t2);
    break;
  }
  for (const t2 of c2) if (lu(t2)) {
    h2 = au(t2);
    break;
  }
  const g2 = (function(t2, e3, n3) {
    if (!t2 || !e3) return null;
    const o3 = t2.getParentAtCaret(), r3 = e3.getParentAtCaret();
    if (!o3 || !r3) return null;
    const i3 = o3.getParents().reverse();
    i3.push(o3);
    const s3 = r3.getParents().reverse();
    s3.push(r3);
    const l3 = Math.min(i3.length, s3.length);
    let c3;
    for (c3 = 0; c3 < l3 && i3[c3] === s3[c3]; c3++) ;
    const a3 = (t3, e4) => {
      let n4;
      for (let o4 = c3; o4 < t3.length; o4++) {
        const r4 = t3[o4];
        if (Bl(r4)) return;
        !n4 && e4(r4) && (n4 = r4);
      }
      return n4;
    }, u3 = a3(i3, Sc), f3 = u3 && a3(s3, (t3) => n3.has(t3.getKey()) && Sc(t3));
    if (f3 && ia(f3).length > 0) return null;
    return u3 && f3 ? [u3, f3] : null;
  })(d2, h2, a2);
  if (g2) {
    const [t2, e3] = g2;
    Ba(t2, "previous").splice(0, e3.getChildren());
    let n3 = e3.getParent();
    for (e3.remove(true); n3 && n3.isEmpty(); ) {
      const t3 = n3;
      n3 = n3.getParent(), t3.remove(true);
    }
  } else if (h2) {
    const t2 = (function(t3) {
      if (Aa(t3)) {
        const e4 = t3.origin;
        if (Sc(e4)) return e4;
      } else {
        const e4 = t3.getParentAtCaret();
        if (e4 && Sc(e4)) return e4;
      }
      return null;
    })(h2), e3 = t2 && t2.getParent(), n3 = t2 && t2.getParents().findLast(zl);
    if (t2 && e3 && !Bi(e3) && t2.isEmpty() && a2.has(t2.getKey()) && 0 === ia(t2).length && (!n3 || a2.has(n3.getKey()))) {
      t2.remove(true);
      let n4 = e3;
      for (; n4 && !Bi(n4) && n4.isEmpty(); ) {
        const t3 = n4.getParent();
        if (t3 && Bi(t3) && t3.getChildrenSize() <= 1) break;
        const e4 = n4;
        n4 = t3, e4.remove(true);
      }
    }
  }
  const _2 = [
    d2,
    h2,
    ...l2,
    ...c2
  ].find(lu);
  if (_2) return Ja(fu(au(_2), e2.direction));
  t(269, JSON.stringify(l2.map((t2) => t2.origin.__key)));
}
function au(t2) {
  const e2 = (function(t3) {
    let e3 = t3;
    for (; Aa(e3); ) {
      const t4 = Wa(e3);
      if (!Aa(t4)) break;
      e3 = t4;
    }
    return e3;
  })(t2.getLatest()), { direction: n2 } = e2;
  if (Xo(e2.origin)) return wa(e2) ? e2 : La(e2.origin, n2, n2);
  const o2 = e2.getAdjacentCaret();
  return Ma(o2) && Xo(o2.origin) ? La(o2.origin, n2, ka(n2)) : e2;
}
function uu(t2) {
  return wa(t2) && t2.offset !== Ka(t2.origin, t2.direction);
}
function fu(t2, e2) {
  return t2.direction === e2 ? t2 : t2.getFlipped();
}
function du(t2, e2) {
  return t2.direction === e2 ? t2 : Va(fu(t2.focus, e2), fu(t2.anchor, e2));
}
function hu(t2, e2, n2) {
  let o2 = Ba(t2, "next");
  for (let t3 = 0; t3 < e2; t3++) {
    const t4 = o2.getAdjacentCaret();
    if (null === t4) break;
    o2 = t4;
  }
  return fu(o2, n2);
}
function _u(e2) {
  const { origin: n2, offset: o2, direction: r2 } = e2;
  if (o2 === Ka(n2, r2)) return e2.getSiblingCaret();
  if (o2 === Ka(n2, ka(r2))) return iu(e2.getSiblingCaret());
  const [i2] = n2.splitText(o2);
  return Xo(i2) || t(281), fu(Ia(i2, "next"), r2);
}
function pu(t2, e2) {
  return true;
}
function yu(t2, { $copyElementNode: e2 = Rl, $splitTextPointCaretNext: n2 = _u, rootMode: o2 = "shadowRoot", $shouldSplit: r2 = pu, removeEmptyDestination: i2 = false } = {}) {
  if (wa(t2)) return n2(t2);
  const s2 = t2.getParentCaret(o2);
  if (s2) {
    const { origin: n3 } = s2;
    if (Aa(t2)) {
      const t3 = iu(s2);
      if (i2 && n3.isEmpty()) return n3.remove(), t3;
      if (!n3.canBeEmpty() || !r2(n3, "first")) return t3;
    }
    const o3 = (function(t3) {
      const e3 = [];
      for (let n4 = t3.getAdjacentCaret(); n4; n4 = n4.getAdjacentCaret()) e3.push(n4.origin);
      return e3;
    })(t2);
    (o3.length > 0 || !i2 && n3.canBeEmpty() && r2(n3, "last")) && s2.insert(e2(n3).splice(0, 0, o3));
  }
  return s2;
}
function mu(e2, n2, o2) {
  let r2 = fu(n2, "next");
  wa(r2) && (0 === r2.offset ? r2 = Ia(r2.origin, "previous").getFlipped() : r2.offset === r2.origin.getTextContentSize() && (r2 = Ia(r2.origin, "next"))), r2.origin.is(e2) && (Ma(r2) || t(342, e2.getKey(), e2.getType()), r2 = iu(r2)), (e2.is(r2.getNodeAtCaret()) || e2.is(r2.getFlipped().getNodeAtCaret())) && e2.remove(true);
  for (let t2 = r2; t2; t2 = yu(t2, o2)) r2 = t2;
  return wa(r2) && t(283), r2.insert(e2.isInline() ? es().append(e2) : e2), fu(Ia(e2.getLatest(), "next"), n2.direction);
}
function xu(t2) {
  return t2;
}
function vu(t2) {
  return t2;
}
function Tu(t2, e2) {
  if (!e2 || t2 === e2) return t2;
  for (const n2 in e2) if (t2[n2] !== e2[n2]) return {
    ...t2,
    ...e2
  };
  return t2;
}
function ku(...t2) {
  const e2 = [];
  for (const n2 of t2) if (n2 && "string" == typeof n2) for (const [t3] of n2.matchAll(/\S+/g)) e2.push(t3);
  return e2;
}
function Eu(...t2) {
  return () => {
    for (let e2 = t2.length - 1; e2 >= 0; e2--) t2[e2]();
    t2.length = 0;
  };
}
function R(e2) {
  const t2 = vc().getElementByKey(e2.getKey());
  if (null === t2) return null;
  const o2 = t2.ownerDocument.defaultView;
  return null === o2 ? null : o2.getComputedStyle(t2);
}
function O$2(e2) {
  return R(Bi(e2) ? e2 : e2.getParentOrThrow());
}
function L(e2, t2, n2 = "self") {
  const o2 = e2.getStartEndPoints();
  if (t2.isSelected(e2) && !Ks(t2) && null !== o2) {
    const [l2, r2] = o2, i2 = e2.isBackward(), s2 = l2.getNode(), c2 = r2.getNode(), g2 = t2.is(s2), a2 = t2.is(c2);
    if (g2 || a2) {
      const [o3, l3] = yr(e2), r3 = s2.is(c2), g3 = t2.is(i2 ? c2 : s2), a3 = t2.is(i2 ? s2 : c2);
      let d2, p = 0;
      if (r3) p = o3 > l3 ? l3 : o3, d2 = o3 > l3 ? o3 : l3;
      else if (g3) p = i2 ? l3 : o3, d2 = void 0;
      else if (a3) p = 0, d2 = i2 ? o3 : l3;
      const h2 = t2.__text.slice(p, d2);
      h2 !== t2.__text && ("clone" === n2 && (t2 = Fc(t2)), t2.__text = h2);
    }
  }
  return t2;
}
function Z(e2) {
  const t2 = ee$2(e2);
  return null !== t2 && "vertical-rl" === t2.writingMode;
}
function ee$2(e2) {
  const t2 = e2.anchor.getNode();
  return Pi(t2) ? R(t2) : O$2(t2);
}
function te$2(e2, n2) {
  let o2 = Z(e2) ? !n2 : n2;
  oe$2(e2) && (o2 = !o2);
  const l2 = tu(e2.focus, o2 ? "previous" : "next");
  if (uu(l2)) return false;
  if (wa(l2) && !er(l2.origin) && l2.origin.isUnmergeable()) {
    const e3 = l2.getNodeAtCaret();
    if (Xo(e3) && !er(e3)) return true;
  }
  for (const e3 of ja(l2)) {
    if (Aa(e3)) return !e3.origin.isInline();
    if (!Pi(e3.origin)) {
      if (Ki(e3.origin)) return true;
      break;
    }
  }
  return false;
}
function ne$2(e2, t2, n2, o2) {
  e2.modify(t2 ? "extend" : "move", n2, o2);
}
function oe$2(e2) {
  const t2 = ee$2(e2);
  return null !== t2 && "rtl" === t2.direction;
}
function le$1(e2, t2, n2) {
  const o2 = oe$2(e2);
  let l2;
  l2 = Z(e2) || o2 ? !n2 : n2, ne$2(e2, t2, l2, "character");
}
function Mt(t2, e2) {
  return null !== t2 && Object.getPrototypeOf(t2).constructor.name === e2.name;
}
var Kt$1 = Symbol.for("preact-signals");
function $t$1() {
  if (Bt$1 > 1) return void Bt$1--;
  let t2, e2 = false;
  for ((function() {
    let t3 = Wt$1;
    for (Wt$1 = void 0; void 0 !== t3; ) t3.S.v === t3.v && (t3.S.i = t3.i), t3 = t3.o;
  })(); void 0 !== zt$1; ) {
    let n2 = zt$1;
    for (zt$1 = void 0, Vt$1++; void 0 !== n2; ) {
      const i2 = n2.u;
      if (n2.u = void 0, n2.f &= -3, !(8 & n2.f) && qt$1(n2)) try {
        n2.c();
      } catch (n3) {
        e2 || (t2 = n3, e2 = true);
      }
      n2 = i2;
    }
  }
  if (Vt$1 = 0, Bt$1--, e2) throw t2;
}
var Tt$1;
var zt$1;
function Ut$1(t2) {
  const e2 = Tt$1;
  Tt$1 = void 0;
  try {
    return t2();
  } finally {
    Tt$1 = e2;
  }
}
var Wt$1;
var Bt$1 = 0;
var Vt$1 = 0;
var Zt$1 = 0;
var Ht$1 = 0;
function Jt$1(t2) {
  if (void 0 === Tt$1) return;
  let e2 = t2.n;
  return void 0 === e2 || e2.t !== Tt$1 ? (e2 = {
    i: 0,
    S: t2,
    p: Tt$1.s,
    n: void 0,
    t: Tt$1,
    e: void 0,
    x: void 0,
    r: e2
  }, void 0 !== Tt$1.s && (Tt$1.s.n = e2), Tt$1.s = e2, t2.n = e2, 32 & Tt$1.f && t2.S(e2), e2) : -1 === e2.i ? (e2.i = 0, void 0 !== e2.n && (e2.n.p = e2.p, void 0 !== e2.p && (e2.p.n = e2.n), e2.p = Tt$1.s, e2.n = void 0, Tt$1.s.n = e2, Tt$1.s = e2), e2) : void 0;
}
function Xt$1(t2, e2) {
  this.v = t2, this.i = 0, this.n = void 0, this.t = void 0, this.l = 0, this.W = null == e2 ? void 0 : e2.watched, this.Z = null == e2 ? void 0 : e2.unwatched, this.name = null == e2 ? void 0 : e2.name;
}
function qt$1(t2) {
  for (let e2 = t2.s; void 0 !== e2; e2 = e2.n) if (e2.S.i !== e2.i || !e2.S.h() || e2.S.i !== e2.i) return true;
  return false;
}
function Qt$1(t2) {
  for (let e2 = t2.s; void 0 !== e2; e2 = e2.n) {
    const n2 = e2.S.n;
    if (void 0 !== n2 && (e2.r = n2), e2.S.n = e2, e2.i = -1, void 0 === e2.n) {
      t2.s = e2;
      break;
    }
  }
}
function te$1(t2) {
  let e2, n2 = t2.s;
  for (; void 0 !== n2; ) {
    const t3 = n2.p;
    -1 === n2.i ? (n2.S.U(n2), void 0 !== t3 && (t3.n = n2.n), void 0 !== n2.n && (n2.n.p = t3)) : e2 = n2, n2.S.n = n2.r, void 0 !== n2.r && (n2.r = void 0), n2 = t3;
  }
  t2.s = e2;
}
function ee$1(t2, e2) {
  Xt$1.call(this, void 0), this.x = t2, this.s = void 0, this.g = Ht$1 - 1, this.f = 4, this.W = null == e2 ? void 0 : e2.watched, this.Z = null == e2 ? void 0 : e2.unwatched, this.name = null == e2 ? void 0 : e2.name;
}
function ie$1(t2) {
  const e2 = t2.m;
  if (t2.m = void 0, "function" == typeof e2) {
    Bt$1++;
    const n2 = Tt$1;
    Tt$1 = void 0;
    try {
      e2();
    } catch (e3) {
      throw t2.f &= -2, t2.f |= 8, oe$1(t2), e3;
    } finally {
      Tt$1 = n2, $t$1();
    }
  }
}
function oe$1(t2) {
  for (let e2 = t2.s; void 0 !== e2; e2 = e2.n) e2.S.U(e2);
  t2.x = void 0, t2.s = void 0, ie$1(t2);
}
function se$1(t2) {
  if (Tt$1 !== this) throw new Error("Out-of-order effect");
  te$1(this), Tt$1 = t2, this.f &= -2, 8 & this.f && oe$1(this), $t$1();
}
function re$1(t2, e2) {
  this.x = t2, this.m = void 0, this.s = void 0, this.u = void 0, this.f = 32, this.name = null == e2 ? void 0 : e2.name;
}
function ce$1(t2, e2) {
  const n2 = new re$1(t2, e2);
  try {
    n2.c();
  } catch (t3) {
    throw n2.d(), t3;
  }
  const i2 = n2.d.bind(n2);
  return i2[Symbol.dispose] = i2, i2;
}
Xt$1.prototype.brand = Kt$1, Xt$1.prototype.h = function() {
  return true;
}, Xt$1.prototype.S = function(t2) {
  const e2 = this.t;
  e2 !== t2 && void 0 === t2.e && (t2.x = e2, this.t = t2, void 0 !== e2 ? e2.e = t2 : Ut$1(() => {
    var t3;
    null == (t3 = this.W) || t3.call(this);
  }));
}, Xt$1.prototype.U = function(t2) {
  if (void 0 !== this.t) {
    const e2 = t2.e, n2 = t2.x;
    void 0 !== e2 && (e2.x = n2, t2.e = void 0), void 0 !== n2 && (n2.e = e2, t2.x = void 0), t2 === this.t && (this.t = n2, void 0 === n2 && Ut$1(() => {
      var t3;
      null == (t3 = this.Z) || t3.call(this);
    }));
  }
}, Xt$1.prototype.subscribe = function(t2) {
  return ce$1(() => {
    const e2 = this.value, n2 = Tt$1;
    Tt$1 = void 0;
    try {
      t2(e2);
    } finally {
      Tt$1 = n2;
    }
  }, { name: "sub" });
}, Xt$1.prototype.valueOf = function() {
  return this.value;
}, Xt$1.prototype.toString = function() {
  return this.value + "";
}, Xt$1.prototype.toJSON = function() {
  return this.value;
}, Xt$1.prototype.peek = function() {
  const t2 = Tt$1;
  Tt$1 = void 0;
  try {
    return this.value;
  } finally {
    Tt$1 = t2;
  }
}, Object.defineProperty(Xt$1.prototype, "value", {
  get() {
    const t2 = Jt$1(this);
    return void 0 !== t2 && (t2.i = this.i), this.v;
  },
  set(t2) {
    if (t2 !== this.v) {
      if (Vt$1 > 100) throw new Error("Cycle detected");
      (function(t3) {
        0 !== Bt$1 && 0 === Vt$1 && t3.l !== Zt$1 && (t3.l = Zt$1, Wt$1 = {
          S: t3,
          v: t3.v,
          i: t3.i,
          o: Wt$1
        });
      })(this), this.v = t2, this.i++, Ht$1++, Bt$1++;
      try {
        for (let t3 = this.t; void 0 !== t3; t3 = t3.x) t3.t.N();
      } finally {
        $t$1();
      }
    }
  }
}), ee$1.prototype = new Xt$1(), ee$1.prototype.h = function() {
  if (this.f &= -3, 1 & this.f) return false;
  if (32 == (36 & this.f)) return true;
  if (this.f &= -5, this.g === Ht$1) return true;
  if (this.g = Ht$1, this.f |= 1, this.i > 0 && !qt$1(this)) return this.f &= -2, true;
  const t2 = Tt$1;
  try {
    Qt$1(this), Tt$1 = this;
    const t3 = this.x();
    (16 & this.f || this.v !== t3 || 0 === this.i) && (this.v = t3, this.f &= -17, this.i++);
  } catch (t3) {
    this.v = t3, this.f |= 16, this.i++;
  }
  return Tt$1 = t2, te$1(this), this.f &= -2, true;
}, ee$1.prototype.S = function(t2) {
  if (void 0 === this.t) {
    this.f |= 36;
    for (let t3 = this.s; void 0 !== t3; t3 = t3.n) t3.S.S(t3);
  }
  Xt$1.prototype.S.call(this, t2);
}, ee$1.prototype.U = function(t2) {
  if (void 0 !== this.t && (Xt$1.prototype.U.call(this, t2), void 0 === this.t)) {
    this.f &= -33;
    for (let t3 = this.s; void 0 !== t3; t3 = t3.n) t3.S.U(t3);
  }
}, ee$1.prototype.N = function() {
  if (!(2 & this.f)) {
    this.f |= 6;
    for (let t2 = this.t; void 0 !== t2; t2 = t2.x) t2.t.N();
  }
}, Object.defineProperty(ee$1.prototype, "value", { get() {
  if (1 & this.f) throw new Error("Cycle detected");
  const t2 = Jt$1(this);
  if (this.h(), void 0 !== t2 && (t2.i = this.i), 16 & this.f) throw this.v;
  return this.v;
} }), re$1.prototype.c = function() {
  const t2 = this.S();
  try {
    if (8 & this.f) return;
    if (void 0 === this.x) return;
    const t3 = this.x();
    "function" == typeof t3 && (this.m = t3);
  } finally {
    t2();
  }
}, re$1.prototype.S = function() {
  if (1 & this.f) throw new Error("Cycle detected");
  this.f |= 1, this.f &= -9, ie$1(this), Qt$1(this), Bt$1++;
  const t2 = Tt$1;
  return Tt$1 = this, se$1.bind(this, t2);
}, re$1.prototype.N = function() {
  2 & this.f || (this.f |= 2, this.u = zt$1, zt$1 = this);
}, re$1.prototype.d = function() {
  this.f |= 8, 1 & this.f || oe$1(this);
}, re$1.prototype.dispose = function() {
  this.d();
};
function ve$1(t2) {
  return ("function" == typeof t2.nodes ? t2.nodes() : t2.nodes) || [];
}
function Ie$1(t2, ...e2) {
  const n2 = new URL("https://lexical.dev/docs/error"), i2 = new URLSearchParams();
  i2.append("code", t2);
  for (const t3 of e2) i2.append("v", t3);
  throw n2.search = i2.toString(), Error(`Minified Lexical error #${t2}; visit ${n2.toString()} for the full message or use the non-minified dev environment for full errors and additional helpful warnings.`);
}
var Fe$1;
try {
  Fe$1 = "0.49.0+prod.esm";
} catch (t2) {
}
var Me$1 = Fe$1 ?? '"<unknown>+source"';
var ke$1 = /* @__PURE__ */ new Set([
  "__proto__",
  "constructor",
  "prototype"
]);
function _e$1(t2, e2) {
  if (t2 && e2 && !Array.isArray(e2) && "object" == typeof t2 && "object" == typeof e2) {
    const n2 = t2, i2 = e2;
    for (const t3 in i2) !ke$1.has(t3) && Object.prototype.hasOwnProperty.call(i2, t3) && (n2[t3] = _e$1(n2[t3], i2[t3]));
    return t2;
  }
  return e2;
}
var Ae$1 = 0;
var Pe$1 = 1;
var Le$1 = 2;
var Ke$1 = 3;
var $e$1 = 4;
var je$1 = 5;
var Te$1 = 6;
var ze$1 = 7;
function Ue$1(t2) {
  return t2.id === Ae$1;
}
function We$1(t2) {
  return t2.id === Le$1;
}
function Be$1(t2) {
  return (function(t3) {
    return t3.id === Pe$1;
  })(t2) || Ie$1(305, String(t2.id), String(Pe$1)), Object.assign(t2, { id: Le$1 });
}
var Ve$1 = /* @__PURE__ */ new Set();
var Ge$1 = class {
  builder;
  configs;
  _dependency;
  _peerNameSet;
  extension;
  state;
  _signal;
  constructor(t2, e2) {
    this.builder = t2, this.extension = e2, this.configs = /* @__PURE__ */ new Set(), this.state = { id: Ae$1 };
  }
  mergeConfigs() {
    let t2 = this.extension.config || {};
    const e2 = this.extension.mergeConfig ? this.extension.mergeConfig.bind(this.extension) : Tu;
    for (const n2 of this.configs) t2 = e2(t2, n2);
    return t2;
  }
  init(t2) {
    const e2 = this.state;
    We$1(e2) || Ie$1(306, String(e2.id));
    const n2 = {
      getDependency: this.getInitDependency.bind(this),
      getDirectDependentNames: this.getDirectDependentNames.bind(this),
      getPeer: this.getInitPeer.bind(this),
      getPeerNameSet: this.getPeerNameSet.bind(this)
    }, i2 = {
      ...n2,
      getDependency: this.getDependency.bind(this),
      getInitResult: this.getInitResult.bind(this),
      getPeer: this.getPeer.bind(this)
    }, o2 = (function(t3, e3, n3) {
      return Object.assign(t3, {
        config: e3,
        id: Ke$1,
        registerState: n3
      });
    })(e2, this.mergeConfigs(), n2);
    let s2;
    this.state = o2, this.extension.init && (s2 = this.extension.init(t2, o2.config, n2)), this.state = (function(t3, e3, n3) {
      return Object.assign(t3, {
        id: $e$1,
        initResult: e3,
        registerState: n3
      });
    })(o2, s2, i2);
  }
  build(t2) {
    const e2 = this.state;
    let n2;
    e2.id !== $e$1 && Ie$1(307, String(e2.id), String(je$1)), this.extension.build && (n2 = this.extension.build(t2, e2.config, e2.registerState));
    const i2 = {
      ...e2.registerState,
      getOutput: () => n2,
      getSignal: this.getSignal.bind(this)
    };
    this.state = (function(t3, e3, n3) {
      return Object.assign(t3, {
        id: je$1,
        output: e3,
        registerState: n3
      });
    })(e2, n2, i2);
  }
  register(t2, e2) {
    this._signal = e2;
    const n2 = this.state;
    n2.id !== je$1 && Ie$1(308, String(n2.id), String(je$1));
    const i2 = this.extension.register && this.extension.register(t2, n2.config, n2.registerState);
    return this.state = (function(t3) {
      return Object.assign(t3, { id: Te$1 });
    })(n2), () => {
      const t3 = this.state;
      t3.id !== ze$1 && Ie$1(309, String(n2.id), String(ze$1)), this.state = (function(t4) {
        return Object.assign(t4, { id: je$1 });
      })(t3), i2 && i2();
    };
  }
  afterRegistration(t2) {
    const e2 = this.state;
    let n2;
    return e2.id !== Te$1 && Ie$1(310, String(e2.id), String(Te$1)), this.extension.afterRegistration && (n2 = this.extension.afterRegistration(t2, e2.config, e2.registerState)), this.state = (function(t3) {
      return Object.assign(t3, { id: ze$1 });
    })(e2), n2;
  }
  getSignal() {
    return void 0 === this._signal && Ie$1(311), this._signal;
  }
  getInitResult() {
    void 0 === this.extension.init && Ie$1(312, this.extension.name);
    const t2 = this.state;
    return (function(t3) {
      return t3.id >= $e$1;
    })(t2) || Ie$1(313, String(t2.id), String($e$1)), t2.initResult;
  }
  getInitPeer(t2) {
    const e2 = this.builder.extensionNameMap.get(t2);
    return e2 ? e2.getExtensionInitDependency() : void 0;
  }
  getExtensionInitDependency() {
    const t2 = this.state;
    return (function(t3) {
      return t3.id >= Ke$1;
    })(t2) || Ie$1(314, String(t2.id), String(Ke$1)), { config: t2.config };
  }
  getPeer(t2) {
    const e2 = this.builder.extensionNameMap.get(t2);
    return e2 ? e2.getExtensionDependency() : void 0;
  }
  getInitDependency(t2) {
    const e2 = this.builder.getExtensionRep(t2);
    return void 0 === e2 && Ie$1(315, this.extension.name, t2.name), e2.getExtensionInitDependency();
  }
  getDependency(t2) {
    const e2 = this.builder.getExtensionRep(t2);
    return void 0 === e2 && Ie$1(315, this.extension.name, t2.name), e2.getExtensionDependency();
  }
  getState() {
    const t2 = this.state;
    return (function(t3) {
      return t3.id >= ze$1;
    })(t2) || Ie$1(316, String(t2.id), String(ze$1)), t2;
  }
  getDirectDependentNames() {
    return this.builder.incomingEdges.get(this.extension.name) || Ve$1;
  }
  getPeerNameSet() {
    let t2 = this._peerNameSet;
    return t2 || (t2 = new Set((this.extension.peerDependencies || []).map(([t3]) => t3)), this._peerNameSet = t2), t2;
  }
  getExtensionDependency() {
    if (!this._dependency) {
      const t2 = this.state;
      (function(t3) {
        return t3.id >= je$1;
      })(t2) || Ie$1(317, this.extension.name), this._dependency = {
        config: t2.config,
        init: t2.initResult,
        output: t2.output
      };
    }
    return this._dependency;
  }
};
var Ze$1 = { tag: xo };
function He$1() {
  const t2 = nl();
  t2.isEmpty() && t2.append(es());
}
var Je$1 = /* @__PURE__ */ xu({
  config: /* @__PURE__ */ vu({
    setOptions: Ze$1,
    updateOptions: Ze$1
  }),
  init: ({ $initialEditorState: t2 = He$1 }) => ({
    $initialEditorState: t2,
    initialized: false
  }),
  afterRegistration(t2, { updateOptions: e2, setOptions: n2 }, i2) {
    const o2 = i2.getInitResult();
    if (!o2.initialized) {
      o2.initialized = true;
      const { $initialEditorState: i3 } = o2;
      if (Ui(i3)) t2.setEditorState(i3, n2);
      else if ("function" == typeof i3) t2.update(() => {
        i3(t2);
      }, e2);
      else if (i3 && ("string" == typeof i3 || "object" == typeof i3)) {
        const e3 = t2.parseEditorState(i3);
        t2.setEditorState(e3, n2);
      }
    }
    return () => {
    };
  },
  name: "@lexical/extension/InitialState",
  nodes: [
    zi,
    Wo,
    Ji,
    Zo,
    Zi
  ]
});
var Xe$1 = Symbol.for("@lexical/extension/LexicalBuilder");
function qe$1() {
}
function Qe$1(t2) {
  throw t2;
}
function tn$1(t2) {
  return Array.isArray(t2) ? t2 : [t2];
}
var en$2 = Me$1;
var nn$1 = class nn$12 {
  roots;
  extensionNameMap;
  outgoingConfigEdges;
  incomingEdges;
  conflicts;
  _sortedExtensionReps;
  PACKAGE_VERSION;
  constructor(t2) {
    this.outgoingConfigEdges = /* @__PURE__ */ new Map(), this.incomingEdges = /* @__PURE__ */ new Map(), this.extensionNameMap = /* @__PURE__ */ new Map(), this.conflicts = /* @__PURE__ */ new Map(), this.PACKAGE_VERSION = en$2, this.roots = t2;
    for (const e2 of t2) this.addExtension(e2);
  }
  static fromExtensions(t2) {
    const e2 = [tn$1(Je$1)];
    for (const n2 of t2) e2.push(tn$1(n2));
    return new nn$12(e2);
  }
  static maybeFromEditor(t2) {
    const e2 = t2[Xe$1];
    return e2 && (e2.PACKAGE_VERSION !== en$2 && Ie$1(292, e2.PACKAGE_VERSION, en$2), e2 instanceof nn$12 || Ie$1(293)), e2;
  }
  static fromEditor(t2) {
    const e2 = nn$12.maybeFromEditor(t2);
    return void 0 === e2 && Ie$1(294), e2;
  }
  constructEditor() {
    const { $initialEditorState: t2, onError: e2, onWarn: n2, ...i2 } = this.buildCreateEditorArgs(), o2 = Object.assign(ys({
      ...i2,
      ...e2 ? { onError: (t3) => {
        e2(t3, o2);
      } } : {},
      ...n2 ? { onWarn: (t3) => {
        n2(t3, o2);
      } } : {}
    }), { [Xe$1]: this });
    for (const t3 of this.sortedExtensionReps()) t3.build(o2);
    return o2;
  }
  buildEditor() {
    let t2 = qe$1;
    function e2() {
      try {
        t2();
      } finally {
        t2 = qe$1;
      }
    }
    const n2 = Object.assign(this.constructEditor(), {
      dispose: e2,
      [Symbol.dispose]: e2
    });
    return t2 = Eu(this.registerEditor(n2), () => n2.setRootElement(null)), n2;
  }
  hasExtensionByName(t2) {
    return this.extensionNameMap.has(t2);
  }
  getExtensionRep(t2) {
    const e2 = this.extensionNameMap.get(t2.name);
    if (e2) return e2.extension !== t2 && Ie$1(295, t2.name), e2;
  }
  addEdge(t2, e2, n2) {
    const i2 = this.outgoingConfigEdges.get(t2);
    i2 ? i2.set(e2, n2) : this.outgoingConfigEdges.set(t2, /* @__PURE__ */ new Map([[e2, n2]]));
    const o2 = this.incomingEdges.get(e2);
    o2 ? o2.add(t2) : this.incomingEdges.set(e2, /* @__PURE__ */ new Set([t2]));
  }
  addExtension(t2) {
    void 0 !== this._sortedExtensionReps && Ie$1(296);
    const [n2] = tn$1(t2);
    "string" != typeof n2.name && Ie$1(297, typeof n2.name);
    let i2 = this.extensionNameMap.get(n2.name);
    if (void 0 !== i2 && i2.extension !== n2 && Ie$1(298, n2.name), !i2) {
      i2 = new Ge$1(this, n2), this.extensionNameMap.set(n2.name, i2);
      const t3 = this.conflicts.get(n2.name);
      "string" == typeof t3 && Ie$1(299, n2.name, t3);
      for (const t4 of n2.conflictsWith || []) this.extensionNameMap.has(t4) && Ie$1(299, n2.name, t4), this.conflicts.set(t4, n2.name);
      for (const t4 of n2.dependencies || []) {
        const e2 = tn$1(t4);
        this.addEdge(n2.name, e2[0].name, e2.slice(1)), this.addExtension(e2);
      }
      for (const [t4, e2] of n2.peerDependencies || []) this.addEdge(n2.name, t4, e2 ? [e2] : []);
    }
  }
  sortedExtensionReps() {
    if (this._sortedExtensionReps) return this._sortedExtensionReps;
    const t2 = [], e2 = (n2, i2) => {
      let o2 = n2.state;
      if (We$1(o2)) return;
      const s2 = n2.extension.name;
      var r2;
      Ue$1(o2) || Ie$1(300, s2, i2 || "[unknown]"), Ue$1(r2 = o2) || Ie$1(304, String(r2.id), String(Ae$1)), o2 = Object.assign(r2, { id: Pe$1 }), n2.state = o2;
      const c2 = this.outgoingConfigEdges.get(s2);
      if (c2) for (const t3 of c2.keys()) {
        const n3 = this.extensionNameMap.get(t3);
        n3 && e2(n3, s2);
      }
      o2 = Be$1(o2), n2.state = o2, t2.push(n2);
    };
    for (const t3 of this.extensionNameMap.values()) Ue$1(t3.state) && e2(t3);
    for (const e3 of t2) for (const [t3, n2] of this.outgoingConfigEdges.get(e3.extension.name) || []) if (n2.length > 0) {
      const e4 = this.extensionNameMap.get(t3);
      if (e4) for (const t4 of n2) e4.configs.add(t4);
    }
    for (const [t3, ...e3] of this.roots) if (e3.length > 0) {
      const n2 = this.extensionNameMap.get(t3.name);
      void 0 === n2 && Ie$1(301, t3.name);
      for (const t4 of e3) n2.configs.add(t4);
    }
    return this._sortedExtensionReps = t2, this._sortedExtensionReps;
  }
  registerEditor(t2) {
    const e2 = this.sortedExtensionReps(), n2 = new AbortController(), i2 = [() => n2.abort()], o2 = n2.signal;
    for (const n3 of e2) {
      const e3 = n3.register(t2, o2);
      e3 && i2.push(e3);
    }
    for (const n3 of e2) {
      const e3 = n3.afterRegistration(t2);
      e3 && i2.push(e3);
    }
    return Eu(...i2);
  }
  buildCreateEditorArgs() {
    const t2 = {}, e2 = /* @__PURE__ */ new Set(), n2 = /* @__PURE__ */ new Map(), i2 = /* @__PURE__ */ new Map(), o2 = {}, s2 = {}, r2 = this.sortedExtensionReps();
    for (const c3 of r2) {
      const { extension: r3 } = c3;
      if (void 0 !== r3.onError && (t2.onError = r3.onError), void 0 !== r3.onWarn && (t2.onWarn = r3.onWarn), void 0 !== r3.disableEvents && (t2.disableEvents = r3.disableEvents), void 0 !== r3.parentEditor && (t2.parentEditor = r3.parentEditor), void 0 !== r3.editable && (t2.editable = r3.editable), void 0 !== r3.namespace && (t2.namespace = r3.namespace), void 0 !== r3.$initialEditorState && (t2.$initialEditorState = r3.$initialEditorState), r3.nodes) for (const t3 of ve$1(r3)) {
        if ("function" != typeof t3) {
          const e3 = n2.get(t3.replace);
          e3 && Ie$1(302, r3.name, t3.replace.name, e3.extension.name), n2.set(t3.replace, c3);
        }
        e2.add(t3);
      }
      if (r3.html) {
        if (r3.html.export) for (const [t3, e3] of r3.html.export.entries()) i2.set(t3, e3);
        r3.html.import && Object.assign(o2, r3.html.import);
      }
      r3.theme && _e$1(s2, r3.theme);
    }
    Object.keys(s2).length > 0 && (t2.theme = s2), e2.size && (t2.nodes = [...e2]);
    const c2 = Object.keys(o2).length > 0, a2 = i2.size > 0;
    (c2 || a2) && (t2.html = {}, c2 && (t2.html.import = o2), a2 && (t2.html.export = i2));
    for (const e3 of r2) e3.init(t2);
    return t2.onError || (t2.onError = Qe$1), t2;
  }
};
function sn$1(t2, e2) {
  const n2 = nn$1.maybeFromEditor(t2);
  if (!n2) return;
  const i2 = n2.extensionNameMap.get(e2);
  return i2 ? i2.getExtensionDependency() : void 0;
}
Date.now;
function nt$1(t2, ...e2) {
  const n2 = new URL("https://lexical.dev/docs/error"), o2 = new URLSearchParams();
  o2.append("code", t2);
  for (const t3 of e2) o2.append("v", t3);
  throw n2.search = o2.toString(), Error(`Minified Lexical error #${t2}; visit ${n2.toString()} for the full message or use the non-minified dev environment for full errors and additional helpful warnings.`);
}
var ot;
function rt(t2, e2) {
  const { key: n2 } = e2;
  return t2 && n2 in t2 ? t2[n2] : e2.defaultValue;
}
function st(t2) {
  return ot && ot.editor === t2 ? ot : void 0;
}
function ct(t2, e2) {
  if ("cfg" in e2) {
    const { cfg: n2, updater: o2 } = e2;
    return [n2, o2(rt(t2, n2))];
  }
  return e2;
}
function lt(t2, e2) {
  let n2 = e2;
  for (const o2 of t2) {
    const [t3, r2] = ct(n2, o2), s2 = t3.key;
    if (n2 === e2 && rt(n2, t3) === r2) continue;
    const i2 = n2 === e2 || void 0 === n2 ? ut(e2) : n2;
    i2[s2] = r2, n2 = i2;
  }
  return n2;
}
function ut(t2) {
  return Object.create(t2 || null);
}
function ft(t2, e2) {
  return [t2, e2];
}
function dt(t2, n2, o2, r2 = vc()) {
  const s2 = ot, i2 = st(r2);
  try {
    return ot = {
      ...i2,
      editor: r2,
      [t2]: n2
    }, o2();
  } finally {
    ot = s2;
  }
}
function pt$1(t2, n2 = () => {
}) {
  return (o2, r2 = vc()) => (e2) => {
    const s2 = st(r2), i2 = s2 && s2[t2], c2 = lt(o2, i2 || n2(r2));
    return c2 && c2 !== i2 ? dt(t2, c2, e2, r2) : e2();
  };
}
function ht$1(t2, e2, o2, r2) {
  return Object.assign(mt$2(Symbol(e2), {
    isEqual: r2,
    parse: o2
  }), { [t2]: true });
}
var yt$1 = "@lexical/html/DOM";
var xt$1 = Symbol.for("@lexical/html/DOMExportContext");
var St = "@lexical/html/DOMImport";
var $t = Symbol.for("@lexical/html/DOMImportContext");
function Ct(t2, e2, n2) {
  return ht$1(xt$1, t2, e2, n2);
}
var kt = /* @__PURE__ */ Ct("isExport", Boolean);
function Dt(t2) {
  const e2 = sn$1(t2, yt$1);
  return e2 ? e2.output.defaults : void 0;
}
function Ot(t2) {
  const e2 = sn$1(t2, yt$1);
  return e2 ? e2.output.runtime : void 0;
}
function Nt(t2 = vc()) {
  const n2 = Ot(t2);
  return n2 ? n2.getSessionConfig() : Tc(t2);
}
var Et = pt$1(xt$1, Dt);
var re = Symbol.for("@lexical/html/SelectorImpl");
function se(t2, e2) {
  const n2 = {
    kind: "element",
    predicate: (o2 = e2, 0 === o2.length ? gc : 1 === o2.length ? o2[0] : (t3, e3) => {
      for (const n3 of o2) if (!n3(t3, e3)) return false;
      return true;
    }),
    tags: t2
  };
  var o2;
  const s2 = (n3) => se(t2, [...e2, n3]);
  return {
    [re]: n2,
    attr: (t3, e3, n3) => s2(le(t3, e3, n3)),
    classAll: (...t3) => s2(ce(t3)),
    classAny: (...t3) => s2((function(t4) {
      const e3 = ie(t4);
      if (0 === e3.length) return () => false;
      return (t5) => {
        if (!gc(t5)) return false;
        const n3 = t5.classList;
        for (const t6 of e3) if (n3.contains(t6)) return true;
        return false;
      };
    })(t3)),
    styleAny: (t3, e3, n3) => s2((function(t4, e4, n4) {
      if ("string" == typeof e4) return (n5) => gc(n5) && n5.style.getPropertyValue(t4) === e4;
      if (e4 instanceof RegExp) {
        const o3 = n4 && n4.capture, s3 = e4;
        return (e5, n5) => {
          if (!gc(e5)) return false;
          const i2 = e5.style.getPropertyValue(t4);
          if (!i2) return false;
          const c2 = i2.match(s3);
          return null !== c2 && (void 0 !== o3 && (n5[o3] = c2), true);
        };
      }
      nt$1(362, JSON.stringify(t4));
    })(t3, e3, n3))
  };
}
function ie(t2) {
  const e2 = [];
  for (const n2 of t2) n2 && e2.push(n2);
  return e2;
}
function ce(t2) {
  const e2 = ie(t2);
  return 0 === e2.length ? () => true : (t3) => {
    if (!gc(t3)) return false;
    const n2 = t3.classList;
    for (const t4 of e2) if (!n2.contains(t4)) return false;
    return true;
  };
}
function le(t2, e2, n2) {
  if (true === e2) return (e3) => gc(e3) && e3.hasAttribute(t2);
  if ("string" == typeof e2) return (n3) => gc(n3) && n3.getAttribute(t2) === e2;
  if (e2 instanceof RegExp) {
    const o2 = n2 && n2.capture, s2 = e2;
    return (e3, n3) => {
      if (!gc(e3)) return false;
      const i2 = e3.getAttribute(t2);
      if (null == i2) return false;
      const c2 = i2.match(s2);
      return null !== c2 && (void 0 !== o2 && (n3[o2] = c2), true);
    };
  }
  nt$1(361, JSON.stringify(t2));
}
var ue = {
  kind: "text",
  predicate: zs,
  tags: /* @__PURE__ */ new Set()
};
var fe = { [re]: ue };
var ae = {
  kind: "comment",
  predicate: (t2) => 8 === t2.nodeType,
  tags: /* @__PURE__ */ new Set()
};
var de = { [re]: ae };
var pe = {
  any: () => se(/* @__PURE__ */ new Set(), []),
  comment: () => de,
  tag(...t2) {
    t2.length > 0 || nt$1(363);
    const e2 = /* @__PURE__ */ new Set();
    for (const n2 of t2) e2.add(n2.toUpperCase());
    return se(e2, []);
  },
  text: () => fe
};
function Ne(t2) {
  const e2 = sn$1(t2, St);
  return e2 ? e2.output.defaults : void 0;
}
var Ie = pt$1($t, Ne);
var Le = pe;
Le.tag("b", "strong", "em", "i", "code", "mark", "s", "sub", "sup", "u", "span");
Le.text();
Le.tag("script", "style");
Le.tag("br");
Le.tag("p"), Le.tag("hr"), Le.any();
var cn = Object.freeze([]);
var an = Object.freeze({});
pe.any();
pe.any, pe.comment, pe.tag, pe.text;
function Dn(t2, n2 = null, o2 = vc()) {
  return Et([ft(kt, true)], o2)(() => {
    const e2 = nl(), r2 = Nt(o2), s2 = ur(n2) ? oa(n2.anchor.getNode()) : null, i2 = t2.append.bind(t2);
    for (const t3 of (Pi(s2) ? s2 : e2).getChildren()) Mn(o2, t3, i2, n2, r2);
    return t2;
  });
}
function On(t2, e2 = null) {
  return ("undefined" == typeof document || "undefined" == typeof window && void 0 === global.window) && nt$1(338), gi(t2), Dn(Zl().createElement("div"), e2, t2).innerHTML;
}
function Mn(e2, n2, o2, i2 = null, c2 = Tc(e2)) {
  let l2 = c2.$shouldInclude(n2, i2, e2);
  const u2 = c2.$shouldExclude(n2, i2, e2);
  let f2 = n2;
  null !== i2 && Xo(n2) && (f2 = L(i2, n2, "clone"));
  const { element: d2, after: p, append: g2, $getChildNodes: m } = c2.$exportDOM(f2, e2);
  if (!d2) return false;
  const y = Zl().createDocumentFragment(), S = m ? m() : Pi(f2) ? f2.getChildren() : [], $2 = l2 && dr(i2) && Pi(n2) ? null : i2, v = y.append.bind(y);
  for (const t2 of S) {
    const o3 = Mn(e2, t2, v, $2, c2);
    !l2 && o3 && c2.$extractWithChild(n2, t2, i2, "html", e2) && (l2 = true);
  }
  if (l2 && !u2) {
    if ((gc(d2) || pc(d2)) && (g2 ? g2(y) : d2.append(y)), o2(d2), p) {
      const t2 = p.call(f2, d2);
      t2 && (pc(d2) ? d2.replaceChildren(t2) : d2.replaceWith(t2));
    }
  } else o2(y);
  return l2;
}
function et(r2, i2, l2 = null) {
  const c2 = Ql(l2), s2 = l2 ? Gl(l2) : [], u2 = null !== l2 && s2.length > 0;
  if (u2 && "function" == typeof c2.caretPositionFromPoint) {
    const t2 = c2.caretPositionFromPoint(r2, i2, { shadowRoots: s2 });
    if (null !== t2 && (function(t3, e2) {
      for (let n2 = t3; null !== n2; ) {
        if (n2 === e2) return true;
        n2 = wl(n2);
      }
      return false;
    })(t2.offsetNode, l2)) return {
      node: t2.offsetNode,
      offset: t2.offset
    };
  }
  if (u2) {
    const t2 = l2.getRootNode();
    if (ql(t2)) {
      const e2 = t2.elementFromPoint(r2, i2);
      if (null !== e2 && l2.contains(e2)) {
        const t3 = (function(t4, e3, n2, o2) {
          const r3 = o2.createRange(), i3 = (t5) => e3 < t5.top ? t5.top - e3 : e3 > t5.bottom ? e3 - t5.bottom : 0, l3 = (e4) => t4 < e4.left ? e4.left - t4 : t4 > e4.right ? t4 - e4.right : 0, c3 = o2.createTreeWalker(n2, NodeFilter.SHOW_TEXT);
          let s3 = null, u3 = Infinity, a2 = Infinity;
          for (let t5 = c3.nextNode(); t5; t5 = c3.nextNode()) {
            r3.selectNodeContents(t5);
            for (const e4 of r3.getClientRects()) {
              const n3 = i3(e4), o3 = l3(e4);
              (n3 < u3 || n3 === u3 && o3 < a2) && (u3 = n3, a2 = o3, s3 = t5);
            }
          }
          if (null === s3) return null;
          let f2 = 0, p = Infinity, d2 = Infinity;
          for (let e4 = 0; e4 <= s3.length; e4++) {
            r3.setStart(s3, e4), r3.collapse(true);
            const n3 = r3.getBoundingClientRect(), o3 = i3(n3), l4 = Math.abs(t4 - n3.left);
            (o3 < p || o3 === p && l4 < d2) && (p = o3, d2 = l4, f2 = e4);
          }
          return {
            node: s3,
            offset: f2
          };
        })(r2, i2, e2, c2);
        if (null !== t3) return t3;
      }
    }
  }
  if ("function" == typeof c2.caretRangeFromPoint) {
    const t2 = c2.caretRangeFromPoint(r2, i2);
    return null === t2 ? null : {
      node: t2.startContainer,
      offset: t2.startOffset
    };
  }
  if ("function" == typeof c2.caretPositionFromPoint) {
    const t2 = c2.caretPositionFromPoint(r2, i2);
    return null === t2 ? null : {
      node: t2.offsetNode,
      offset: t2.offset
    };
  }
  return null;
}
function nt(t2, ...e2) {
  const n2 = new URL("https://lexical.dev/docs/error"), o2 = new URLSearchParams();
  o2.append("code", t2);
  for (const t3 of e2) o2.append("v", t3);
  throw n2.search = o2.toString(), Error(`Minified Lexical error #${t2}; visit ${n2.toString()} for the full message or use the non-minified dev environment for full errors and additional helpful warnings.`);
}
function pt(t2, e2 = Kr()) {
  return e2 ?? nt(166), ur(e2) && e2.isCollapsed() || 0 === e2.getNodes().length ? "" : On(t2, e2);
}
function mt(t2, e2) {
  const n2 = t2.getData("text/plain") || t2.getData("text/uri-list");
  null != n2 && e2.insertRawText(n2);
}
var yt = "application/x-lexical-drag";
function xt(t2, e2) {
  const n2 = { editorKey: e2.getKey() };
  t2.setData(yt, JSON.stringify(n2));
}
function ht(t2, e2, n2) {
  const o2 = t2.dataTransfer;
  if (null === o2) return false;
  const r2 = (function(t3) {
    const e3 = t3.getData(yt);
    if (!e3) return null;
    let n3;
    try {
      n3 = JSON.parse(e3);
    } catch (t4) {
      return null;
    }
    return null !== (o3 = n3) && "object" == typeof o3 && "editorKey" in o3 && "string" == typeof o3.editorKey ? n3 : null;
    var o3;
  })(o2);
  if (null === r2) return false;
  const i2 = (function(t3, e3) {
    const n3 = et(t3.clientX, t3.clientY, e3.getRootElement());
    if (null === n3) return null;
    const o3 = Zs(n3.node);
    if (null === o3) return null;
    if (Xo(o3)) return La(o3, "next", n3.offset);
    if (Pi(o3)) return hu(o3, n3.offset, "next");
    const r3 = o3.getParent();
    return null === r3 ? null : hu(r3, o3.getIndexWithinParent() + 1, "next");
  })(t2, e2);
  if (null === i2) return false;
  const l2 = yu(i2);
  if (null === l2) return false;
  const c2 = r2.editorKey === e2.getKey(), u2 = Kr();
  if (c2) {
    if (!ur(u2) || u2.isCollapsed()) return false;
    if ((function(t3, e3) {
      const { anchor: n3, focus: o3 } = du(ru(e3), "next");
      return Ya(n3, t3) < 0 && Ya(t3, o3) < 0;
    })(i2, u2)) return t2.preventDefault(), true;
    u2.removeText();
  }
  if (!l2.origin.isAttached()) return t2.preventDefault(), true;
  if (n2(o2, nu(Ja(l2)), e2), !c2) {
    const t3 = e2.getRootElement(), n3 = t3 ? t3.ownerDocument : null, o3 = n3 ? (function(t4, e3) {
      for (const n4 of Xl(e3)) {
        const e4 = Ps(n4);
        if (Ds(e4) && e4.getKey() === t4 && gc(n4)) return n4;
      }
      return null;
    })(r2.editorKey, n3) : null;
    null !== o3 && o3.dispatchEvent(new InputEvent("beforeinput", {
      bubbles: true,
      cancelable: true,
      inputType: "deleteByDrag"
    }));
  }
  return t2.preventDefault(), true;
}
function bt(t2, e2) {
  return ht(t2, e2, (t3, e3) => mt(t3, e3));
}
function M$1(e2, t2) {
  t2.update(() => {
    if (null !== e2) {
      const r2 = Mt(e2, KeyboardEvent) ? null : e2.clipboardData, o2 = Kr();
      if (null !== o2 && !o2.isCollapsed() && null != r2) {
        e2.preventDefault();
        const a2 = pt(t2);
        null !== a2 && r2.setData("text/html", a2), r2.setData("text/plain", o2.getTextContent());
      }
    }
  });
}
function O$1(n2) {
  return Eu(n2.registerCommand($e$2, (e2) => {
    const t2 = Kr();
    return !!ur(t2) && (t2.deleteCharacter(e2), true);
  }, 0), n2.registerCommand(qe$2, (e2) => {
    const t2 = Kr();
    return !!ur(t2) && (t2.deleteWord(e2), true);
  }, 0), n2.registerCommand(Ye$1, (e2) => {
    const t2 = Kr();
    return !!ur(t2) && (t2.deleteLine(e2), true);
  }, 0), n2.registerCommand(je$2, (t2) => {
    const r2 = Kr();
    if (!ur(r2)) return false;
    if ("string" == typeof t2) r2.insertText(t2);
    else {
      const n3 = t2.dataTransfer;
      if (null != n3) mt(n3, r2);
      else {
        const e2 = t2.data;
        e2 && r2.insertText(e2);
      }
    }
    return true;
  }, 0), n2.registerCommand(Ve$2, () => {
    const e2 = Kr();
    return !!ur(e2) && (e2.removeText(), true);
  }, 0), n2.registerCommand(Ue$2, (e2) => {
    const t2 = Kr();
    return !!ur(t2) && (t2.insertLineBreak(e2), true);
  }, 0), n2.registerCommand(He$2, () => {
    const e2 = Kr();
    return !!ur(e2) && (e2.insertLineBreak(), true);
  }, 0), n2.registerCommand(on$1, (e2) => {
    const t2 = Kr();
    if (!ur(t2)) return false;
    const r2 = e2, n3 = r2.shiftKey;
    return !!te$2(t2, true) && (r2.preventDefault(), le$1(t2, n3, true), true);
  }, 0), n2.registerCommand(en$3, (e2) => {
    const t2 = Kr();
    if (!ur(t2)) return false;
    const r2 = e2, n3 = r2.shiftKey;
    return !!te$2(t2, false) && (r2.preventDefault(), le$1(t2, n3, false), true);
  }, 0), n2.registerCommand(un$2, (e2) => {
    return !!ur(Kr()) && (!l || !s) && (e2.preventDefault(), n2.dispatchCommand($e$2, true));
  }, 0), n2.registerCommand(dn$1, (e2) => {
    return !!ur(Kr()) && (e2.preventDefault(), n2.dispatchCommand($e$2, false));
  }, 0), n2.registerCommand(cn$1, (e2) => {
    if (!ur(Kr())) return false;
    if (null !== e2) {
      if ((l || a || d$1) && s) return false;
      e2.preventDefault();
    }
    return n2.dispatchCommand(Ue$2, false);
  }, 0), n2.registerCommand(kn, () => {
    const e2 = Kr();
    return xl(ur(e2) && null !== oa(e2.anchor.getNode()) ? e2 : null), true;
  }, 0), n2.registerCommand(vn$2, (e2) => {
    return !!ur(Kr()) && (M$1(e2, n2), true);
  }, 0), n2.registerCommand(Tn, (e2) => {
    return !!ur(Kr()) && ((function(e3, t2) {
      M$1(e3, t2), t2.update(() => {
        const e4 = Kr();
        ur(e4) && e4.removeText();
      }, { tag: "cut" });
    })(e2, n2), true);
  }, 0), n2.registerCommand(Je$2, (t2) => {
    return !!ur(Kr()) && ((function(t3, r2) {
      t3.preventDefault(), r2.update(() => {
        const r3 = Kr(), n3 = Mt(t3, ClipboardEvent) ? t3.clipboardData : null;
        null != n3 && ur(r3) && mt(n3, r3);
      }, { tag: "paste" });
    })(t2, n2), true);
  }, 0), n2.registerCommand(yn$1, (e2) => bt(e2, n2), 0), n2.registerCommand(xn$1, (e2) => {
    const t2 = Kr();
    return !!ur(t2) && (t2.isCollapsed() || null === e2.dataTransfer || xt(e2.dataTransfer, n2), true);
  }, 0));
}
function E(t2, e2, n2, o2, r2) {
  if (null === t2 || 0 === n2.size && 0 === o2.size && !r2) return 0;
  const a2 = e2._selection, i2 = t2._selection;
  if (r2) return 1;
  if (!(ur(a2) && ur(i2) && i2.isCollapsed() && a2.isCollapsed())) return 0;
  const l2 = (function(t3, e3, n3) {
    const o3 = t3._nodeMap, r3 = [];
    for (const t4 of e3) {
      const e4 = o3.get(t4);
      void 0 !== e4 && r3.push(e4);
    }
    for (const [t4, e4] of n3) {
      if (!e4) continue;
      const n4 = o3.get(t4);
      void 0 === n4 || Bi(n4) || r3.push(n4);
    }
    return r3;
  })(e2, n2, o2);
  if (0 === l2.length) return 0;
  if (l2.length > 1) {
    const n3 = e2._nodeMap, o3 = n3.get(a2.anchor.key), r3 = n3.get(i2.anchor.key);
    return o3 && r3 && !t2._nodeMap.has(o3.__key) && Xo(o3) && 1 === o3.__text.length && 1 === a2.anchor.offset ? 2 : 0;
  }
  const s2 = l2[0], u2 = t2._nodeMap.get(s2.__key);
  if (!Xo(u2) || !Xo(s2) || u2.__mode !== s2.__mode) return 0;
  const d2 = u2.__text, c2 = s2.__text;
  if (d2 === c2) return 0;
  const p = a2.anchor, f2 = i2.anchor;
  if (p.key !== f2.key || "text" !== p.type) return 0;
  const h2 = p.offset, m = f2.offset, g2 = c2.length - d2.length;
  return 1 === g2 && m === h2 - 1 ? 2 : -1 === g2 && m === h2 + 1 ? 3 : -1 === g2 && m === h2 ? 4 : 0;
}
function D(t2, e2, n2) {
  let o2 = n2(), r2 = 0, a2 = o2, i2 = 0, l2 = null;
  return (s2, u2, d2, c2, p, f2) => {
    const h2 = n2();
    if (f2.has("composition-start") && (a2 = o2, i2 = r2, l2 = s2), f2.has("historic")) return r2 = 0, o2 = h2, 2;
    f2.has("composition-end") && l2 && (o2 = a2, r2 = i2, s2 = l2);
    const m = f2.has("paste") || f2.has("cut") ? 0 : E(s2, u2, c2, p, t2.isComposing()), w2 = (() => {
      const n3 = null === d2 || d2.editor === t2, a3 = f2.has(mo);
      if (!a3 && n3 && f2.has("history-merge")) return 0;
      if (1 === m) return 2;
      if (null === s2) return 1;
      const i3 = u2._selection;
      if (!(c2.size > 0 || p.size > 0)) return null !== i3 ? 0 : 2;
      const l3 = "number" == typeof e2 ? e2 : e2.peek();
      if (false === a3 && 0 !== m && m === r2 && h2 < o2 + l3 && n3) return 0;
      if (1 === c2.size) {
        if ((function(t3, e3, n4) {
          const o3 = e3._nodeMap.get(t3), r3 = n4._nodeMap.get(t3), a4 = e3._selection, i4 = n4._selection;
          return !(ur(a4) && ur(i4) && "element" === a4.anchor.type && "element" === a4.focus.type && "text" === i4.anchor.type && "text" === i4.focus.type || !Xo(o3) || !Xo(r3) || o3.__parent !== r3.__parent) && JSON.stringify(e3.read(() => o3.exportJSON())) === JSON.stringify(n4.read(() => r3.exportJSON()));
        })(Array.from(c2)[0], s2, u2)) return 0;
      }
      return 1;
    })();
    return o2 = h2, r2 = m, w2;
  };
}
function M(t2, e2) {
  t2.undoStack = [], t2.redoStack = [], t2.current = null, e2 && e2(t2);
}
function O(t2, e2, n2, o2 = Date.now, r2, f2 = null) {
  const h2 = D(t2, n2, o2), m = () => {
    r2 && r2(e2);
  };
  return m(), Eu(t2.registerCommand(Qe$2, () => ((function(t3, e3, n3) {
    const o3 = e3.redoStack, r3 = e3.undoStack;
    if (0 !== r3.length) {
      const a2 = e3.current, i2 = r3.pop();
      null !== a2 && (o3.push(a2), t3.dispatchCommand(En, true)), 0 === r3.length && t3.dispatchCommand(wn$1, false), e3.current = i2 || null, n3 && n3(e3), i2 && i2.editor.setEditorState(i2.editorState, { tag: "historic" });
    }
  })(t2, e2, r2), true), 0), t2.registerCommand(Ze$2, () => ((function(t3, e3, n3) {
    const o3 = e3.redoStack, r3 = e3.undoStack;
    if (0 !== o3.length) {
      const a2 = e3.current;
      null !== a2 && (r3.push(a2), t3.dispatchCommand(wn$1, true));
      const i2 = o3.pop();
      0 === o3.length && t3.dispatchCommand(En, false), e3.current = i2 || null, n3 && n3(e3), i2 && i2.editor.setEditorState(i2.editorState, { tag: "historic" });
    }
  })(t2, e2, r2), true), 0), t2.registerCommand(bn$2, () => (M(e2, r2), false), 0), t2.registerCommand(Nn$1, () => (M(e2, r2), t2.dispatchCommand(En, false), t2.dispatchCommand(wn$1, false), true), 0), t2.registerUpdateListener(({ editorState: n3, prevEditorState: o3, dirtyLeaves: r3, dirtyElements: a2, tags: i2 }) => {
    const l2 = e2.current, s2 = e2.redoStack, u2 = e2.undoStack, d2 = null === l2 ? null : l2.editorState;
    if (null !== l2 && n3 === d2) return;
    const g2 = h2(o3, n3, l2, r3, a2, i2);
    if (1 === g2) {
      if (0 !== s2.length && (e2.redoStack = [], t2.dispatchCommand(En, false)), null !== l2) {
        u2.push({ ...l2 });
        const e3 = "number" == typeof f2 || null === f2 ? f2 : f2.peek();
        null !== e3 && u2.length > e3 && u2.splice(0, u2.length - e3), t2.dispatchCommand(wn$1, true);
      }
    } else if (2 === g2) return;
    e2.current = {
      editor: t2,
      editorState: n3
    }, m();
  }));
}
function z2() {
  return {
    current: null,
    redoStack: [],
    undoStack: []
  };
}
Date.now;
function r(e2) {
  var t2, f2, n2 = "";
  if ("string" == typeof e2 || "number" == typeof e2) n2 += e2;
  else if ("object" == typeof e2) if (Array.isArray(e2)) {
    var o2 = e2.length;
    for (t2 = 0; t2 < o2; t2++) e2[t2] && (f2 = r(e2[t2])) && (n2 && (n2 += " "), n2 += f2);
  } else for (f2 in e2) e2[f2] && (n2 && (n2 += " "), n2 += f2);
  return n2;
}
function clsx() {
  for (var e2, t2, f2 = 0, n2 = "", o2 = arguments.length; f2 < o2; f2++) (e2 = arguments[f2]) && (t2 = r(e2)) && (n2 && (n2 += " "), n2 += t2);
  return n2;
}
var css$8 = ".yAWgPa_chip{max-width:240px;color:var(--dsw-alias-state-business-primary);user-select:none;align-items:baseline;gap:3px;display:inline-flex}.yAWgPa_marker{flex:none;font-weight:500}.yAWgPa_icon{flex:none;align-self:center}.yAWgPa_label{text-overflow:ellipsis;white-space:nowrap;overflow:hidden}.yAWgPa_invalid{color:var(--dsw-alias-state-error-primary);opacity:.7;text-decoration:line-through}";
var tagId$8 = "@kode/dsh-composer/cfbd9fd95b05/ReferenceChip.module.css";
if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId$8) + "]") === null) {
  const tag = document.createElement("style");
  tag.dataset.plugin = "@kode/dsh-composer";
  tag.dataset.pluginCss = tagId$8;
  tag.textContent = css$8;
  document.head.appendChild(tag);
}
var ReferenceChip_module_css_default = {
  "chip": "yAWgPa_chip",
  "icon": "yAWgPa_icon",
  "invalid": "yAWgPa_invalid",
  "label": "yAWgPa_label",
  "marker": "yAWgPa_marker"
};
var css$7 = ".q44v1G_reference{border-radius:var(--dsw-radius-sm);line-height:inherit;vertical-align:baseline;color:var(--dsw-alias-state-business-primary);-webkit-box-decoration-break:clone;box-decoration-break:clone;background:0 0;padding:0 4px}.q44v1G_reference:hover{background:var(--dsw-alias-state-business-tertiary)}.q44v1G_openable{cursor:pointer}[data-composer-command][data-selected]>.q44v1G_reference{background:var(--dsw-alias-state-business-tertiary)}.q44v1G_textRef{max-width:100%;display:inline-block}";
var tagId$7 = "@kode/dsh-composer/cfbd9fd95b05/composer-editor.module.css";
if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId$7) + "]") === null) {
  const tag = document.createElement("style");
  tag.dataset.plugin = "@kode/dsh-composer";
  tag.dataset.pluginCss = tagId$7;
  tag.textContent = css$7;
  document.head.appendChild(tag);
}
var composer_editor_module_css_default = {
  "openable": "q44v1G_openable",
  "reference": "q44v1G_reference",
  "textRef": "q44v1G_textRef"
};
function ReferenceChip2({ label, appearance, invalid }) {
  return (0, react_jsx_runtime.jsxs)("span", {
    className: clsx(composer_editor_module_css_default.reference, ReferenceChip_module_css_default.chip, appearance === "file" && !invalid && composer_editor_module_css_default.openable, invalid && ReferenceChip_module_css_default.invalid),
    title: label,
    children: [appearance === void 0 ? (0, react_jsx_runtime.jsx)("span", {
      className: ReferenceChip_module_css_default.marker,
      "aria-hidden": true,
      children: "@"
    }) : (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.ReferenceIconRegular, {
      kind: appearance,
      size: 14,
      className: ReferenceChip_module_css_default.icon
    }), (0, react_jsx_runtime.jsx)("span", {
      className: ReferenceChip_module_css_default.label,
      children: label
    })]
  });
}
var ReferenceChipNode = class ReferenceChipNode2 extends Li {
  /** Owning source name (serializer routing key). */
  __source;
  /** Owner-scoped reference id. */
  __ref;
  /** Inline display label (insert-time cache). */
  __label;
  /** Optional domain glyph (insert-time cache). */
  __appearance;
  /** Clipboard / persistence projection, e.g. `/name` (never the model form). */
  __clipboardText;
  /** Owner-resolution failure flag: chip renders invalid; serialization must fail. */
  __invalid;
  /** Lexical node registry type tag. */
  static getType() {
    return "reference-chip";
  }
  /**
  * Clone with identity (Lexical writable-copy contract).
  * @param node - node to clone.
  * @returns a copy carrying the same NodeKey.
  */
  static clone(node) {
    return new ReferenceChipNode2({
      source: node.__source,
      ref: node.__ref,
      label: node.__label,
      appearance: node.__appearance,
      clipboardText: node.__clipboardText
    }, node.__invalid, node.__key);
  }
  /**
  * Rebuild one chip from its JSON form.
  * @param json - serialized chip.
  * @returns a fresh node (new key).
  */
  static importJSON(json) {
    return new ReferenceChipNode2({
      source: json.source,
      ref: json.ref,
      label: json.label,
      appearance: json.appearance,
      clipboardText: json.clipboardText
    }, json.invalid);
  }
  /**
  * @param insert - the owner's reference insertion (display projections included).
  * @param invalid - owner-resolution failure bit (defaults valid).
  * @param key - Lexical clone-path key; absent for fresh nodes.
  */
  constructor(insert, invalid = false, key) {
    super(key);
    this.__source = insert.source;
    this.__ref = insert.ref;
    this.__label = insert.label;
    this.__appearance = insert.appearance;
    this.__clipboardText = insert.clipboardText;
    this.__invalid = invalid;
  }
  /** Serialize to the JSON node form. */
  exportJSON() {
    return {
      ...super.exportJSON(),
      type: "reference-chip",
      version: 1,
      source: this.__source,
      ref: this.__ref,
      label: this.__label,
      ...this.__appearance === void 0 ? {} : { appearance: this.__appearance },
      clipboardText: this.__clipboardText,
      invalid: this.__invalid
    };
  }
  /**
  * Mount the chip's host element; the decorator portal renders into it.
  * @returns an inline, non-editable span carrying the test/e2e anchor.
  */
  createDOM(_config) {
    const el2 = document.createElement("span");
    el2.setAttribute("data-composer-chip", this.__source);
    el2.setAttribute("contenteditable", "false");
    return el2;
  }
  /** Host element never changes shape. */
  updateDOM() {
    return false;
  }
  /** Chips sit in the text line. */
  isInline() {
    return true;
  }
  /**
  * No keyboard-selected intermediate state: arrows step across the chip in
  * one move and Backspace/Delete remove it whole (the placeholder semantics
  * of the old textarea). `true` would put a NodeSelection between the
  * keystroke and the caret — a state the plain-text binding's handlers all
  * ignore, deadlocking arrows, typing, and deletion at the chip edge.
  */
  isKeyboardSelectable() {
    return false;
  }
  /** Clipboard / persistence projection (native copy reads this). */
  getTextContent() {
    return this.__clipboardText;
  }
  /**
  * Flip the owner-resolution failure bit.
  * @param invalid - next bit; no-op writes are the caller's concern.
  */
  setInvalid(invalid) {
    const writable = this.getWritable();
    writable.__invalid = invalid;
  }
  /** Owner-resolution failure bit. */
  isInvalid() {
    return this.getLatest().__invalid;
  }
  /** Owning source name. */
  getSource() {
    return this.getLatest().__source;
  }
  /** Owner-scoped reference id. */
  getReference() {
    return this.getLatest().__ref;
  }
  /** Inline display label. */
  getLabel() {
    return this.getLatest().__label;
  }
  /** Optional domain glyph. */
  getAppearance() {
    return this.getLatest().__appearance;
  }
  /** React face rendered into the host element by the decorator portal. */
  decorate() {
    return (0, react_jsx_runtime.jsx)(ReferenceChip2, {
      label: this.__label,
      appearance: this.__appearance,
      invalid: this.__invalid
    });
  }
};
function $createReferenceChipNode(insert) {
  return new ReferenceChipNode(insert);
}
function $isReferenceChipNode(node) {
  return node instanceof ReferenceChipNode;
}
function d(t2, ...e2) {
  const n2 = new URL("https://lexical.dev/docs/error"), r2 = new URLSearchParams();
  r2.append("code", t2);
  for (const t3 of e2) r2.append("v", t3);
  throw n2.search = r2.toString(), Error(`Minified Lexical error #${t2}; visit ${n2.toString()} for the full message or use the non-minified dev environment for full errors and additional helpful warnings.`);
}
function x(t2, e2, n2, r2) {
  const s2 = (t3) => t3 instanceof n2, f2 = (t3) => {
    const e3 = Go(t3.getTextContent());
    e3.setFormat(t3.getFormat()), t3.replace(e3);
  };
  return [t2.registerNodeTransform(Wo, (t3) => {
    if (!t3.isSimpleText()) return;
    let n3, o2 = t3.getPreviousSibling(), l2 = t3.getTextContent(), u2 = t3;
    if (Xo(o2)) {
      const n4 = o2.getTextContent(), r3 = e2(n4 + l2);
      if (s2(o2)) {
        if (null === r3 || 0 !== ((t4) => t4.getLatest().__mode)(o2)) return void f2(o2);
        {
          const e3 = r3.end - n4.length;
          if (e3 > 0) {
            const r4 = n4 + l2.slice(0, e3);
            if (o2.select(), o2.setTextContent(r4), e3 === l2.length) t3.remove();
            else {
              const n5 = l2.slice(e3);
              t3.setTextContent(n5);
            }
            return;
          }
        }
      } else if (null === r3 || r3.start < n4.length) return;
    }
    let c2 = 0;
    for (; ; ) {
      n3 = e2(l2);
      let t4, g2 = null === n3 ? "" : l2.slice(n3.end);
      if (l2 = g2, "" === g2) {
        const t5 = u2.getNextSibling();
        if (Xo(t5)) {
          g2 = u2.getTextContent() + t5.getTextContent();
          const n4 = e2(g2);
          if (null === n4) return void (s2(t5) ? f2(t5) : t5.markDirty());
          if (0 !== n4.start) return;
        }
      }
      if (null === n3) return;
      if (0 === n3.start && Xo(o2) && o2.isTextEntity()) {
        c2 += n3.end;
        continue;
      }
      0 === n3.start ? [t4, u2] = u2.splitText(n3.end) : [, t4, u2] = u2.splitText(n3.start + c2, n3.end + c2), void 0 === t4 && d(165, "nodeToReplace");
      const a2 = r2(t4);
      if (a2.setFormat(t4.getFormat()), t4.replace(a2), null == u2) return;
      c2 = 0, o2 = a2;
    }
  }), t2.registerNodeTransform(n2, (t3) => {
    const n3 = t3.getTextContent(), r3 = e2(n3);
    if (null === r3 || 0 !== r3.start) return void f2(t3);
    if (n3.length > r3.end) return void t3.splitText(r3.end);
    const o2 = t3.getPreviousSibling();
    Xo(o2) && o2.isTextEntity() && (f2(o2), f2(t3));
    const l2 = t3.getNextSibling();
    Xo(l2) && l2.isTextEntity() && (f2(l2), s2(t3) && f2(t3));
  })];
}
var TEXT_REF_RE = /(^|\s)([/@])([\w-]+)/g;
var FOLDER_REF_RE = /(^|\s)(@(?:"[^"\n]*\/|[^\s"]+\/))/g;
var SLASH_TOKEN_END_RE = /^(?:\s|$)/;
function scanTextRefs(draft, lexicon) {
  if (draft === "") return [];
  const out = [];
  TEXT_REF_RE.lastIndex = 0;
  let m;
  while ((m = TEXT_REF_RE.exec(draft)) !== null) {
    const trigger = m[2];
    const name = m[3] ?? "";
    if (trigger === "/" && !SLASH_TOKEN_END_RE.test(draft.slice(m.index + m[0].length))) continue;
    if (lexicon.get(trigger)?.includes(name)) {
      const start = m.index + (m[1]?.length ?? 0);
      out.push({
        start,
        end: start + 1 + name.length,
        trigger
      });
    }
  }
  FOLDER_REF_RE.lastIndex = 0;
  let folder;
  while ((folder = FOLDER_REF_RE.exec(draft)) !== null) {
    const token = folder[2] ?? "";
    const start = folder.index + (folder[1]?.length ?? 0);
    const end = start + token.length;
    if (!out.some((range) => range.start < end && range.end > start)) out.push({
      start,
      end,
      trigger: "@"
    });
  }
  return out.sort((left, right) => left.start - right.start);
}
var TextRefNode = class TextRefNode2 extends Wo {
  /** Lexical node registry type tag. */
  static getType() {
    return "composer-text-ref";
  }
  /**
  * Clone with identity (Lexical writable-copy contract).
  * @param node - node to clone.
  * @returns a copy carrying the same NodeKey.
  */
  static clone(node) {
    return new TextRefNode2(node.__text, node.__key);
  }
  /**
  * Rebuild one text-ref from its JSON form.
  * @param json - serialized node.
  * @returns a fresh node.
  */
  static importJSON(json) {
    const node = new TextRefNode2(json.text);
    node.setFormat(json.format);
    node.setDetail(json.detail);
    node.setMode(json.mode);
    node.setStyle(json.style);
    return node;
  }
  /** Serialize to the JSON node form. */
  exportJSON() {
    return {
      ...super.exportJSON(),
      type: "composer-text-ref"
    };
  }
  /** Style the span the base TextNode mounts. */
  createDOM(config) {
    const el2 = super.createDOM(config);
    el2.className = clsx(el2.className, composer_editor_module_css_default.reference, composer_editor_module_css_default.textRef, this.getTextContent().startsWith("/") && composer_editor_module_css_default.openable);
    el2.setAttribute("spellcheck", "false");
    el2.setAttribute("data-composer-text-ref", "");
    return el2;
  }
  /** Entity nodes never merge with plain siblings (the transform owns their bounds). */
  isTextEntity() {
    return true;
  }
  /** Editing continues inside; the transform re-evaluates match shape per edit. */
  canInsertTextBefore() {
    return true;
  }
};
function registerTextRefDecoration(editor, lexiconOf) {
  const getMatch = (text) => {
    const range = scanTextRefs(text, lexiconOf())[0];
    return range === void 0 ? null : {
      start: range.start,
      end: range.end
    };
  };
  return Eu(...x(editor, getMatch, TextRefNode, (node) => new TextRefNode(node.getTextContent())));
}
function rescanTextRefs(editor) {
  editor.update(() => {
    for (const node of nl().getAllTextNodes()) node.markDirty();
  }, { tag: xo });
}
function registerReferenceActivation(editor, open) {
  return editor.registerCommand(Ke$2, (event) => {
    if (event.target === null || event.button !== 0 || event.detail > 1) return false;
    const selection = Kr();
    if (ur(selection) && !selection.isCollapsed()) return false;
    const node = Zs(event.target);
    if ($isReferenceChipNode(node)) {
      if (node.isInvalid()) return false;
      const appearance = node.getAppearance();
      return open(node.getSource(), {
        ref: node.getReference(),
        ...appearance === void 0 ? {} : { appearance }
      });
    }
    return node instanceof TextRefNode && open(void 0, { ref: node.getTextContent() });
  }, 1);
}
function CommandChip({ token }) {
  return (0, react_jsx_runtime.jsx)("span", {
    className: clsx(composer_editor_module_css_default.reference, ReferenceChip_module_css_default.chip),
    children: (0, react_jsx_runtime.jsx)("span", {
      className: ReferenceChip_module_css_default.label,
      children: token
    })
  });
}
var CommandChipNode = class CommandChipNode2 extends Li {
  /** The claim this chip anchors; its submit closure has no JSON form. */
  __claim;
  /** Lexical node registry type tag. */
  static getType() {
    return "command-chip";
  }
  /**
  * Clone with identity (Lexical writable-copy contract).
  * @param node - node to clone.
  * @returns a copy carrying the same NodeKey and claim.
  */
  static clone(node) {
    return new CommandChipNode2(node.__claim, node.__key);
  }
  /**
  * Rebuild one chip from its JSON form. JSON cannot carry the claim's
  * submit closure, so an imported command is its literal token text.
  * @param json - serialized chip.
  * @returns a plain text node holding the token.
  */
  static importJSON(json) {
    return Go(json.text);
  }
  /**
  * @param claim - the command claim the chip anchors.
  * @param key - Lexical clone-path key; absent for fresh nodes.
  */
  constructor(claim, key) {
    super(key);
    this.__claim = claim;
  }
  /** Serialize to the JSON node form (the token text alone). */
  exportJSON() {
    return {
      ...super.exportJSON(),
      type: "command-chip",
      version: 1,
      text: this.getTextContent()
    };
  }
  /**
  * Mount the chip's host element; the decorator portal renders into it.
  * @returns an inline, non-editable span carrying the test/e2e anchor.
  */
  createDOM() {
    const el2 = document.createElement("span");
    el2.setAttribute("data-composer-command", this.__claim.name);
    el2.setAttribute("contenteditable", "false");
    return el2;
  }
  /** Host element never changes shape. */
  updateDOM() {
    return false;
  }
  /** The chip sits in the text line. */
  isInline() {
    return true;
  }
  /**
  * Arrows step across the chip and the default character deletion removes
  * it whole, for the reason documented on ReferenceChipNode.isKeyboardSelectable;
  * registerCommandChipSelection inserts the selecting step before that deletion.
  */
  isKeyboardSelectable() {
    return false;
  }
  /** Clipboard / persistence projection: the token without its separator. */
  getTextContent() {
    return this.__claim.token.trimEnd();
  }
  /** The claim this chip anchors. */
  getClaim() {
    return this.getLatest().__claim;
  }
  /** React face rendered into the host element by the decorator portal. */
  decorate() {
    return (0, react_jsx_runtime.jsx)(CommandChip, { token: this.getTextContent() });
  }
};
function $createCommandChipNode(claim) {
  return new CommandChipNode(claim);
}
function $isCommandChipNode(node) {
  return node instanceof CommandChipNode;
}
function $releaseChip(chip) {
  chip.replace(Go(chip.getTextContent()));
}
function registerCommandChipSeat(editor) {
  return Eu(editor.registerNodeTransform(CommandChipNode, (chip) => {
    if (chip.getPreviousSibling() !== null || chip.getParentOrThrow().getPreviousSibling() !== null) $releaseChip(chip);
  }), editor.registerNodeTransform(Zi, (block) => {
    const first = block.getFirstChild();
    if ($isCommandChipNode(first) && block.getPreviousSibling() !== null) $releaseChip(first);
  }));
}
var PASSIVE_KEYS = /* @__PURE__ */ new Set([
  "Shift",
  "Control",
  "Alt",
  "Meta",
  "Unidentified",
  "Process"
]);
function $commandChipBesideCaret(isBackward) {
  const selection = Kr();
  if (!ur(selection) || !selection.isCollapsed()) return null;
  const node = kl(selection.focus, isBackward);
  return $isCommandChipNode(node) ? node : null;
}
function deletionDirection(inputType) {
  if (inputType === "deleteContentBackward") return true;
  if (inputType === "deleteContentForward") return false;
  return null;
}
function registerCommandChipSelection(editor) {
  let selected = null;
  let keyWithoutDeletion = false;
  const paint = (next) => {
    if (selected !== null && selected.key !== next?.key) editor.getElementByKey(selected.key)?.removeAttribute("data-selected");
    selected = next;
    if (next !== null) editor.getElementByKey(next.key)?.setAttribute("data-selected", "");
    editor.getRootElement()?.toggleAttribute("data-composer-chip-selected", next !== null);
  };
  const clear = () => {
    if (selected !== null) paint(null);
    return false;
  };
  const $decide = (isBackward, clearOnPass) => {
    keyWithoutDeletion = false;
    const chip = $commandChipBesideCaret(isBackward);
    if (chip === null) return clear();
    if (selected?.key === chip.getKey() && selected.isBackward === isBackward) return clearOnPass ? clear() : false;
    paint({
      key: chip.getKey(),
      isBackward
    });
    return true;
  };
  return Eu(editor.registerCommand(ze$2, (event) => {
    const isBackward = deletionDirection(event.inputType);
    if (isBackward === null || !$decide(isBackward, false)) return false;
    event.preventDefault();
    return true;
  }, 3), editor.registerCommand($e$2, (isBackward) => $decide(isBackward, true), 3), editor.registerCommand(tn$2, (event) => {
    if (selected === null || PASSIVE_KEYS.has(event.key)) return false;
    keyWithoutDeletion = true;
    queueMicrotask(() => {
      if (!keyWithoutDeletion) return;
      keyWithoutDeletion = false;
      clear();
    });
    return false;
  }, 4), editor.registerCommand(Ke$2, clear, 4), editor.registerCommand(Mn$1, clear, 4), editor.registerUpdateListener(({ editorState }) => {
    const current = selected;
    if (current === null) return;
    paint(editorState.read(() => $commandChipBesideCaret(current.isBackward)?.getKey() === current.key) ? current : null);
  }), () => {
    paint(null);
  });
}
function $composerLayout() {
  const segments = [];
  const byKey = /* @__PURE__ */ new Map();
  const children = /* @__PURE__ */ new Map();
  const bounds = /* @__PURE__ */ new Map();
  let detect = "";
  let clipboard = "";
  const pushLeaf = (kind, node, detectPiece, clipboardPiece) => {
    const segment = {
      kind,
      node,
      detectStart: detect.length,
      detectLength: detectPiece.length,
      clipboardStart: clipboard.length,
      clipboardLength: clipboardPiece.length
    };
    segments.push(segment);
    byKey.set(node.getKey(), segment);
    detect += detectPiece;
    clipboard += clipboardPiece;
  };
  const walkElement = (element) => {
    const start = detect.length;
    const kids = element.getChildren();
    children.set(element.getKey(), kids.map((kid) => kid.getKey()));
    for (const kid of kids) if ($isReferenceChipNode(kid) || $isCommandChipNode(kid)) pushLeaf("chip", kid, "\uFFFC", kid.getTextContent());
    else if (Xo(kid)) {
      const text = kid.getTextContent();
      pushLeaf("text", kid, text, text);
    } else if (Yi(kid)) pushLeaf("linebreak", kid, "\n", "\n");
    else if (Pi(kid))
      walkElement(kid);
    bounds.set(element.getKey(), {
      start,
      end: detect.length
    });
  };
  const root = nl();
  const blocks = root.getChildren();
  children.set(root.getKey(), blocks.map((block) => block.getKey()));
  const rootStart = detect.length;
  blocks.forEach((block, index) => {
    const previous = blocks[index - 1];
    if (index > 0 && previous !== void 0) {
      segments.push({
        kind: "gap",
        node: null,
        detectStart: detect.length,
        detectLength: 1,
        clipboardStart: clipboard.length,
        clipboardLength: 1,
        gapBetween: {
          before: previous.getKey(),
          after: block.getKey()
        }
      });
      detect += "\n";
      clipboard += "\n";
    }
    if (Pi(block)) walkElement(block);
  });
  bounds.set(root.getKey(), {
    start: rootStart,
    end: detect.length
  });
  return {
    segments,
    detectLength: detect.length,
    detectText: detect,
    clipboardText: clipboard,
    byKey,
    children,
    bounds
  };
}
function detectOffsetOfClipboardOffset(layout, clipboardOffset) {
  for (const segment of layout.segments) {
    const end = segment.clipboardStart + segment.clipboardLength;
    if (clipboardOffset > end) continue;
    if (clipboardOffset === end) return segment.detectStart + segment.detectLength;
    if (segment.kind === "chip") return segment.detectStart + segment.detectLength;
    return segment.detectStart + (clipboardOffset - segment.clipboardStart);
  }
  return layout.detectLength;
}
function $detectOffsetOfPoint(layout, point) {
  if (point.type === "text") {
    const segment = layout.byKey.get(point.key);
    return segment === void 0 ? null : segment.detectStart + Math.min(point.offset, segment.detectLength);
  }
  const kids = layout.children.get(point.key);
  const elementBounds = layout.bounds.get(point.key);
  if (kids === void 0 || elementBounds === void 0) return null;
  if (point.offset >= kids.length) return elementBounds.end;
  const childKey = kids[point.offset];
  if (childKey === void 0) return elementBounds.end;
  const childSegment = layout.byKey.get(childKey);
  if (childSegment !== void 0) return childSegment.detectStart;
  const childBounds = layout.bounds.get(childKey);
  return childBounds === void 0 ? null : childBounds.start;
}
function $projectComposer(idOf) {
  const layout = $composerLayout();
  const occurrences = [];
  for (const segment of layout.segments) {
    if (segment.kind !== "chip" || !$isReferenceChipNode(segment.node)) continue;
    const chip = segment.node;
    occurrences.push({
      occurrenceId: idOf(chip.getKey()),
      source: chip.getSource(),
      ref: chip.getReference(),
      offset: segment.clipboardStart,
      length: segment.clipboardLength,
      label: chip.getLabel(),
      ...chip.getAppearance() === void 0 ? {} : { appearance: chip.getAppearance() },
      clipboardText: chip.getTextContent(),
      ...chip.isInvalid() ? { invalid: true } : {}
    });
  }
  const lead = layout.segments[0]?.node;
  const selection = Kr();
  let range = null;
  if (ur(selection)) {
    const anchor = $detectOffsetOfPoint(layout, selection.anchor);
    const focus = $detectOffsetOfPoint(layout, selection.focus);
    if (anchor !== null && focus !== null) range = {
      start: Math.min(anchor, focus),
      end: Math.max(anchor, focus)
    };
  }
  return {
    detectText: layout.detectText,
    clipboardText: layout.clipboardText,
    occurrences,
    selection: range,
    caret: range !== null && range.start === range.end ? range.start : null,
    command: $isCommandChipNode(lead) ? lead.getClaim() : void 0
  };
}
function resolvePoint(layout, offset) {
  if (offset < 0 || offset > layout.detectLength) return null;
  for (const segment of layout.segments) {
    if (offset >= segment.detectStart + segment.detectLength) continue;
    if (segment.kind === "text" && segment.node !== null) return {
      key: segment.node.getKey(),
      offset: offset - segment.detectStart,
      type: "text"
    };
    if (segment.kind === "gap" && segment.gapBetween !== void 0) {
      const before = segment.gapBetween.before;
      return {
        key: before,
        offset: layout.children.get(before)?.length ?? 0,
        type: "element"
      };
    }
    if (segment.node === null) return null;
    const element = segment.node.getParent();
    if (element === null) return null;
    return {
      key: element.getKey(),
      offset: segment.node.getIndexWithinParent(),
      type: "element"
    };
  }
  const blocks = nl().getChildren();
  const last = blocks[blocks.length - 1];
  if (last === void 0) return {
    key: nl().getKey(),
    offset: 0,
    type: "element"
  };
  return {
    key: last.getKey(),
    offset: layout.children.get(last.getKey())?.length ?? 0,
    type: "element"
  };
}
function selectSpan(layout, span) {
  if (span.start < 0 || span.start > span.end || span.end > layout.detectLength) return null;
  const anchor = resolvePoint(layout, span.start);
  const focus = resolvePoint(layout, span.end);
  if (anchor === null || focus === null) return null;
  const selection = Fr();
  selection.anchor.set(anchor.key, anchor.offset, anchor.type);
  selection.focus.set(focus.key, focus.offset, focus.type);
  ol(selection);
  return selection;
}
function $replaceDetectSpanWithText(span, text) {
  const selection = selectSpan($composerLayout(), span);
  if (selection === null) return false;
  if (text === "" && !selection.isCollapsed()) selection.removeText();
  else selection.insertText(text);
  return true;
}
function $replaceDetectSpanWithNodes(span, nodes) {
  const selection = selectSpan($composerLayout(), span);
  if (selection === null) return false;
  selection.insertNodes([...nodes]);
  return true;
}
var REFERENCE_PLACEHOLDER_RE = /[\uE100-\uE11D\uFFFC]/gu;
function $appendParagraphs(text) {
  const root = nl();
  for (const line of text.split("\n")) {
    const paragraph = es();
    if (line !== "") paragraph.append(Go(line));
    root.append(paragraph);
  }
  root.selectEnd();
}
var HISTORY_MERGE_DELAY_MS = 1e3;
var DraftEditorRuntime = class {
  deps;
  /** The editor bound by the Composer's contenteditable host. */
  editor;
  projected = {
    detectText: "",
    clipboardText: "",
    occurrences: [],
    selection: null,
    caret: null,
    command: void 0
  };
  /** Stable occurrence ids per chip NodeKey (undo restores keys, so ids survive it too). */
  occurrenceIds = /* @__PURE__ */ new Map();
  occurrenceSeq = 0;
  /** Live lexicon subscription disposer; undefined until the controller resolves. */
  lexiconOff;
  lexiconSource;
  /** @param deps - model callbacks used by editor listeners and transforms. */
  constructor(deps) {
    this.deps = deps;
    this.editor = ys({
      namespace: "dsh-composer",
      nodes: [
        ReferenceChipNode,
        CommandChipNode,
        TextRefNode
      ],
      onError: (error) => {
        throw error;
      }
    });
  }
  /**
  * Install editor behavior after the model holds this runtime.
  * @returns unregister callback that also detaches the editor root.
  */
  register() {
    const preserveExternalSelection = () => {
      const root = this.editor.getRootElement();
      if (root !== null && !root.contains(root.ownerDocument.activeElement)) Al(bo);
      return false;
    };
    const unregister = Eu(O$1(this.editor), this.editor.registerCommand(Mn$1, () => {
      this.editor.update(preserveExternalSelection, { discrete: true });
      return false;
    }, 4), this.editor.registerCommand(Ie$2, preserveExternalSelection, 4), this.editor.registerNodeTransform(zi, preserveExternalSelection), registerReferenceActivation(this.editor, (source, reference) => this.deps.openReference(source, reference)), O(this.editor, z2(), HISTORY_MERGE_DELAY_MS), this.editor.registerUpdateListener(() => {
      this.deps.onUpdate();
    }), registerCommandChipSeat(this.editor), registerCommandChipSelection(this.editor), registerTextRefDecoration(this.editor, () => this.deps.lexicon()), () => {
      this.lexiconOff?.();
      this.lexiconOff = void 0;
      this.lexiconSource = void 0;
    });
    return () => {
      unregister();
      this.editor.setRootElement(null);
    };
  }
  /** The latest committed editor projection. */
  get projection() {
    return this.projected;
  }
  /**
  * Run one editor edit whose result is observable on return. At the top
  * level this is a discrete update. Inside this editor's own update —
  * command handlers land here synchronously (space/enter picks, paste) —
  * $-functions are already legal, and wrapping them in update() would DEFER
  * them past the synchronous bail answer (and a nested discrete throws);
  * the body runs directly and the outer update commits it.
  * @param fn - the $-edit body.
  */
  applyEdit(fn, tag) {
    if (this.editor._updating) {
      if (tag !== void 0) Al(tag);
      fn();
      return;
    }
    this.editor.update(fn, {
      discrete: true,
      ...tag === void 0 ? {} : { tag }
    });
  }
  /**
  * Reconnect decorations when the optional trigger provider changes.
  * The rescan reads the current editor and does not replace its content.
  */
  refreshLexiconSubscription() {
    const lexicon = this.deps.resolveLexicon();
    if (lexicon === this.lexiconSource) return;
    this.lexiconOff?.();
    this.lexiconSource = lexicon;
    this.lexiconOff = lexicon?.subscribe(() => {
      rescanTextRefs(this.editor);
    });
    rescanTextRefs(this.editor);
  }
  /**
  * Re-project inside the existing editor update callback.
  * @returns the projection preceding this read.
  */
  refreshProjection() {
    const prev = this.projected;
    this.projected = this.editor.getEditorState().read(() => $projectComposer((key) => this.occurrenceIdOf(key)));
    return prev;
  }
  occurrenceIdOf(key) {
    const existing = this.occurrenceIds.get(key);
    if (existing !== void 0) return existing;
    this.occurrenceSeq += 1;
    this.occurrenceIds.set(key, this.occurrenceSeq);
    return this.occurrenceSeq;
  }
  /**
  * Replace the whole draft (persisted-draft seed and programmatic writes).
  * Placeholder-sanitized; newlines split paragraphs; the caret lands at the
  * end. Merged into history so a seed is not an undoable step of its own.
  * @param text - the full next draft.
  */
  setDraft(text) {
    const clean = text.replace(REFERENCE_PLACEHOLDER_RE, "");
    if (clean === this.projection.clipboardText && this.projection.occurrences.length === 0) return;
    this.editor.update(() => {
      nl().clear();
      $appendParagraphs(clean);
    }, {
      discrete: true,
      tag: xo
    });
  }
  /**
  * Add plain text after the current draft as new paragraphs, keeping its text
  * and references; an empty draft takes the text as its whole content.
  * Placeholder-sanitized; the caret lands at the end; merged into history
  * like {@link setDraft}.
  * @param text - plain text to add.
  */
  appendDraft(text) {
    const clean = text.replace(REFERENCE_PLACEHOLDER_RE, "");
    if (clean === "") return;
    if (this.projection.clipboardText === "" && this.projection.occurrences.length === 0) {
      this.setDraft(clean);
      return;
    }
    this.editor.update(() => {
      $appendParagraphs(clean);
    }, {
      discrete: true,
      tag: xo
    });
  }
  /**
  * Insert pasted plain text over the current editor selection
  * (placeholder-sanitized). The paste event's own default is suppressed by
  * the caller; PASTE_TAG makes the paste its own history boundary, so one
  * undo never removes both the paste and typing inside the merge window.
  * @param text - pasted plain text.
  */
  paste(text) {
    const clean = text.replace(REFERENCE_PLACEHOLDER_RE, "");
    if (clean === "") return;
    this.applyEdit(() => {
      const selection = Kr();
      if (ur(selection)) {
        selection.insertText(clean);
        return;
      }
      const root = nl();
      if (root.getChildrenSize() === 0) root.append(es());
      root.selectEnd().insertText(clean);
    }, Co);
  }
  /**
  * The live selection as a detect-coordinate span (menu-launcher synthetic
  * hits replace it on pick); an absent selection answers a collapsed span at
  * the document end.
  * @returns the ordered [start, end) span in detect coordinates.
  */
  caretSpan() {
    if (this.projection.selection !== null) return this.projection.selection;
    const at2 = this.projection.detectText.length;
    return {
      start: at2,
      end: at2
    };
  }
  /**
  * Replace a mapped span without applying the model's phase or revision guards.
  * @param span - detect-coordinate range.
  * @param text - inserted text.
  * @returns whether the range mapped and the edit applied.
  */
  replaceText(span, text) {
    let applied = false;
    this.applyEdit(() => {
      applied = $replaceDetectSpanWithText(span, text);
    });
    return applied;
  }
  /**
  * Insert an asynchronous text result as one independent undo operation.
  * @param span - owner-validated insertion range.
  * @param text - text sanitized with the same rules as paste.
  * @returns whether the range mapped and the edit applied.
  */
  insertAsyncText(span, text) {
    let applied = false;
    const clean = text.replace(REFERENCE_PLACEHOLDER_RE, "");
    this.applyEdit(() => {
      applied = $replaceDetectSpanWithText(span, clean);
    }, Co);
    return applied;
  }
  /**
  * Insert a reference chip with the existing trailing-space rule.
  * @param span - detect-coordinate range.
  * @param ref - reference fields.
  * @param tail - the character following the range before editing.
  * @returns whether the range mapped and the edit applied.
  */
  insertReference(span, ref, tail) {
    let applied = false;
    this.applyEdit(() => {
      applied = $replaceDetectSpanWithNodes(span, tail === " " ? [$createReferenceChipNode(ref)] : [$createReferenceChipNode(ref), Go(" ")]);
    });
    return applied;
  }
  /**
  * Replace a span with a command chip followed by the claim token's
  * argument separator, unless the separator already follows.
  * @param span - detect-coordinate range.
  * @param claim - the command claim the chip anchors.
  * @param tail - the character following the range before editing.
  * @param mergeHistory - merge into the previous history entry (a restored
  * draft's chip is part of its seed, not an undoable step).
  * @returns whether the range mapped and the edit applied.
  */
  insertCommand(span, claim, tail, mergeHistory = false) {
    const separator = claim.token.slice(claim.token.trimEnd().length);
    let applied = false;
    this.applyEdit(() => {
      applied = $replaceDetectSpanWithNodes(span, separator === "" || tail === separator.charAt(0) ? [$createCommandChipNode(claim)] : [$createCommandChipNode(claim), Go(separator)]);
    }, mergeHistory ? xo : void 0);
    return applied;
  }
  /**
  * Insert an ordered file-reference batch after the live selection without deleting it.
  * @param references - validated references in source order.
  * @returns whether the live insertion position accepted the batch.
  */
  insertFileReferences(references) {
    if (references.length === 0) return true;
    let applied = false;
    this.applyEdit(() => {
      const projection = $projectComposer((key) => this.occurrenceIdOf(key));
      const at2 = projection.selection?.end ?? projection.detectText.length;
      const before = projection.detectText.slice(0, at2);
      const nodes = references.flatMap((ref) => [$createReferenceChipNode(ref), Go(" ")]);
      if (before !== "" && !/\s$/u.test(before)) nodes.unshift(Go(" "));
      applied = $replaceDetectSpanWithNodes({
        start: at2,
        end: at2
      }, nodes);
    }, Co);
    return applied;
  }
  /**
  * Clear committed content using the model's suffix decision inside the editor update.
  * @param prefixLength - returns the clipboard-prefix length to remove, or null to clear the root.
  */
  clearCommittedDraft(prefixLength) {
    this.editor.update(() => {
      const layout = $composerLayout();
      const length = prefixLength(layout.clipboardText);
      if (length !== null) {
        $replaceDetectSpanWithText({
          start: 0,
          end: detectOffsetOfClipboardOffset(layout, length)
        }, "");
        return;
      }
      const root = nl();
      root.clear();
      root.selectEnd();
    }, {
      discrete: true,
      tag: xo
    });
  }
  /**
  * Import semantic content or a model-selected failure snapshot with fresh reference nodes.
  * @param draft - clipboard text.
  * @param occurrences - reference occurrences in clipboard order.
  */
  restoreDraft(draft, occurrences) {
    this.editor.update(() => {
      const root = nl();
      root.clear();
      let paragraph = es();
      root.append(paragraph);
      const appendText = (text) => {
        const lines = text.replace(REFERENCE_PLACEHOLDER_RE, "").split("\n");
        for (let i2 = 0; i2 < lines.length; i2 += 1) {
          const line = lines[i2];
          if (line !== "") paragraph.append(Go(line));
          if (i2 < lines.length - 1) {
            paragraph = es();
            root.append(paragraph);
          }
        }
      };
      let cursor = 0;
      for (const occurrence of occurrences) {
        appendText(draft.slice(cursor, occurrence.offset));
        paragraph.append(new ReferenceChipNode({
          source: occurrence.source,
          ref: occurrence.ref,
          label: occurrence.label,
          ...occurrence.appearance === void 0 ? {} : { appearance: occurrence.appearance },
          clipboardText: occurrence.clipboardText
        }, occurrence.invalid === true));
        cursor = occurrence.offset + occurrence.length;
      }
      appendText(draft.slice(cursor));
      root.selectEnd();
    }, {
      discrete: true,
      tag: xo
    });
  }
  /** Cut the editor's undo history after a committed clear or restoration. */
  clearHistory() {
    this.editor.dispatchCommand(Nn$1, void 0);
  }
};
var BUSY_ENTER_FIELD = "busyEnter";
var BUSY_ENTER_BEHAVIORS = ["queue", "steer"];
var DEFAULT_BUSY_ENTER_BEHAVIOR = "queue";
var ConversationSettingsFields = { [BUSY_ENTER_FIELD]: Schema.union([...BUSY_ENTER_BEHAVIORS]).default(DEFAULT_BUSY_ENTER_BEHAVIOR) };
Schema.object(ConversationSettingsFields);
function resolveSubmitMode(preferred, running, gesture, steeringAvailable) {
  if (!running || !steeringAvailable) return "queue";
  if (gesture === "enter") return preferred;
  return preferred === "queue" ? "steer" : "queue";
}
var css$6 = '._7yHdaG_dock{box-sizing:border-box;width:calc(100% - var(--dsh-composer-side-clearance) - var(--dsh-composer-side-clearance) - var(--dsh-composer-dock-inset) - var(--dsh-composer-dock-inset));max-width:calc(var(--dsh-composer-card-max-width) - var(--dsh-composer-dock-inset) - var(--dsh-composer-dock-inset));margin:0 auto calc(0px - var(--dsh-composer-stack-gap) - 3px);padding:0 var(--dsh-composer-dock-inset);flex:none}._7yHdaG_panel{isolation:isolate;border-radius:var(--dsw-radius-lg) var(--dsw-radius-lg) 0 0;--dsh-scrollbar-thumb:var(--dsw-alias-scrollbar-bg-l2);--dsh-scrollbar-thumb-hover:var(--dsw-alias-scrollbar-hover-l2);width:100%;padding:2px 0;position:relative;overflow:hidden}._7yHdaG_panel:before{z-index:-1;border-radius:inherit;background:var(--dsw-specific-menu);backdrop-filter:var(--dsw-menu-backdrop-filter);content:"";pointer-events:none;position:absolute;inset:0}._7yHdaG_panel:after{border:.5px solid var(--dsw-alias-border-l1);border-radius:inherit;content:"";pointer-events:none;border-bottom:none;position:absolute;inset:0}._7yHdaG_header{box-sizing:border-box;border-radius:var(--dsw-radius-md);width:100%;height:36px;color:var(--dsw-alias-label-primary);text-align:left;cursor:pointer;background:0 0;border:none;align-items:center;gap:10px;padding:4px 12px;display:flex}._7yHdaG_header:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:-2px}._7yHdaG_header:disabled{cursor:default}._7yHdaG_lead{color:var(--dsw-alias-label-tertiary);flex:none;place-items:center;display:grid}._7yHdaG_count{min-width:0;font-family:Inter, var(--dsw-font-family);flex:auto;font-size:13px;font-weight:500;line-height:24px}._7yHdaG_chevron{width:14px;height:14px;color:var(--dsw-alias-label-tertiary);flex:none;place-items:center;display:grid}._7yHdaG_list{max-height:180px;margin:0;padding:0;list-style:none;overflow-y:auto}._7yHdaG_row{box-sizing:border-box;border-radius:var(--dsw-radius-md);align-items:center;gap:10px;width:100%;min-height:36px;padding:4px 5px 4px 12px;display:flex}._7yHdaG_row+._7yHdaG_row{box-shadow:inset 0 1px 0 var(--dsw-alias-border-l1)}._7yHdaG_attachments{flex:none;gap:4px;min-width:0;max-width:55%;display:flex;overflow:hidden}._7yHdaG_pendingRow ._7yHdaG_attachments{flex-shrink:1}._7yHdaG_file{border:.5px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-sm);background:var(--dsw-alias-bg-base);box-sizing:border-box;flex:0 180px;align-items:center;gap:4px;min-width:74px;height:24px;padding:0 6px;display:inline-flex;overflow:hidden}._7yHdaG_fileIcon{flex:none;width:16px;height:16px;display:inline-flex}._7yHdaG_fileName{min-width:0;color:var(--dsw-alias-label-primary-dimmed);font:var(--dsw-font-xs-13);text-overflow:ellipsis;white-space:nowrap;overflow:hidden}._7yHdaG_fileSize{color:var(--dsw-alias-label-tertiary);white-space:nowrap;flex:none;font-size:10px}._7yHdaG_thumb{border:.5px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-xs);background:var(--dsw-alias-bg-base);object-fit:cover;width:24px;height:24px}._7yHdaG_preview{min-width:0;font:var(--dsw-font-xs-13);font-family:Inter, var(--dsw-font-family);color:var(--dsw-alias-label-primary-dimmed);flex:auto}._7yHdaG_actions{flex:none;align-items:center;gap:10px;display:flex}._7yHdaG_status{color:var(--dsw-alias-label-tertiary);font:var(--dsw-font-xs-13);white-space:nowrap;flex:none}._7yHdaG_action{corner-shape:round;width:28px;height:28px;color:var(--dsw-alias-label-tertiary);cursor:pointer;background:0 0;border:none;border-radius:999px;flex:none;place-items:center;padding:0;display:grid}._7yHdaG_action:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}._7yHdaG_action:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:-2px}._7yHdaG_action:disabled{cursor:default;opacity:.45}';
var tagId$6 = "@kode/dsh-composer/cfbd9fd95b05/QueueDock.module.css";
if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId$6) + "]") === null) {
  const tag = document.createElement("style");
  tag.dataset.plugin = "@kode/dsh-composer";
  tag.dataset.pluginCss = tagId$6;
  tag.textContent = css$6;
  document.head.appendChild(tag);
}
var css$5 = ".T1PP_q_row{border-bottom:.5px solid var(--dsw-alias-border-l2);align-items:center;gap:8px;padding:16px 0;display:flex}.T1PP_q_rowText{flex-direction:column;flex:1;gap:4px;min-width:0;padding-right:48px;display:flex}.T1PP_q_title{color:var(--dsw-alias-label-primary);font-size:14px;font-weight:400;line-height:22px}.T1PP_q_desc{color:var(--dsw-alias-label-tertiary);font-size:12px;font-weight:400;line-height:18px}.T1PP_q_selector{border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-module-platform);height:36px;font:inherit;color:var(--dsw-alias-label-primary);cursor:pointer;border:none;align-items:center;gap:12px;padding:0 14px;font-size:14px;line-height:22px;display:inline-flex}.T1PP_q_selector:hover{background:var(--dsw-alias-interactive-bg-hover)}.T1PP_q_chevron{flex:none}";
var tagId$5 = "@kode/dsh-composer/cfbd9fd95b05/EnterBehaviorRow.module.css";
if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId$5) + "]") === null) {
  const tag = document.createElement("style");
  tag.dataset.plugin = "@kode/dsh-composer";
  tag.dataset.pluginCss = tagId$5;
  tag.textContent = css$5;
  document.head.appendChild(tag);
}
var css$4 = '.wSkVaW_root{background:var(--dsw-alias-bg-base);flex-direction:column;min-width:0;height:100%;display:flex;position:relative}.wSkVaW_header{box-sizing:border-box;border-bottom:.5px solid var(--dsw-alias-border-l3);flex:none;grid-template-columns:auto minmax(0,1fr);min-height:76px;padding:10px 28px 0 20px;display:grid}.wSkVaW_header:where(:not(:has(.wSkVaW_tabs))){min-height:0;padding-bottom:10px}.wSkVaW_headerBlank{border-bottom:none;min-height:0;padding-bottom:0}.wSkVaW_headerBlank .wSkVaW_headerCorner{margin-left:auto}html:not([data-platform=darwin]) .wSkVaW_headerSessionless{padding-top:0}html:not([data-platform=darwin]) .wSkVaW_headerSessionless .wSkVaW_titleRow{min-height:0}[data-platform=darwin] .wSkVaW_headerLeading,[data-platform=darwin] .wSkVaW_headerActions,[data-platform=darwin] .wSkVaW_headerUtilities,[data-platform=darwin] .wSkVaW_headerCorner{-webkit-app-region:no-drag}.wSkVaW_titleRow{min-height:30px;grid-column:2;align-items:center;gap:0;padding-inline-start:max(0px, calc(var(--dsh-frame-leading-clearance,0px) - 20px));display:flex;container-type:inline-size}.wSkVaW_titleCluster{flex:1;align-items:center;gap:10px;min-width:0;display:flex}.wSkVaW_headerLeading{flex:none;grid-area:1/1;align-items:center;gap:8px;display:flex}.wSkVaW_crumbs{white-space:nowrap;align-items:center;gap:4px;min-width:0;display:flex;overflow:hidden}.wSkVaW_crumbSeg{align-items:center;gap:4px;min-width:0;display:inline-flex}.wSkVaW_crumbSep{color:var(--dsw-alias-label-caption);font-size:14px;line-height:20px}.wSkVaW_crumb{border-radius:var(--dsw-radius-md);max-width:220px;color:var(--dsw-alias-label-tertiary);text-overflow:ellipsis;white-space:nowrap;cursor:pointer;background:0 0;border:none;padding:4px 8px;font-size:14px;line-height:20px;display:inline-block;overflow:hidden}.wSkVaW_crumbSubagent{font-size:12px;line-height:18px}button.wSkVaW_crumb:hover{background:var(--dsw-alias-interactive-bg-hover)}.wSkVaW_crumbCurrent{color:var(--dsw-alias-label-primary);cursor:default;font-weight:500}.wSkVaW_headerActions{flex:none;align-items:center;gap:8px;display:flex}.wSkVaW_headerUtilities{flex:none;align-items:center;gap:8px;margin-left:20px;display:flex}.wSkVaW_headerUtilities:empty{display:none}.wSkVaW_headerCorner{flex:none;align-items:center;margin-left:8px;margin-right:-16px;display:flex}.wSkVaW_headerCorner:empty{display:none}.wSkVaW_tabs{z-index:1;box-sizing:border-box;flex-wrap:wrap;grid-column:1/-1;align-items:flex-start;gap:16px 20px;width:100%;min-width:0;margin-top:10px;padding-left:8px;display:flex;position:relative}.wSkVaW_viewTabs{flex-wrap:wrap;gap:32px;min-width:0;min-height:25px;display:flex}.wSkVaW_tab{min-height:25px;color:var(--dsw-alias-label-tertiary);cursor:pointer;background:0 0;border:none;padding:0 0 9px;font-size:13px;font-weight:500;line-height:16px;position:relative}.wSkVaW_tab:after{content:"";background:0 0;border-radius:2px;height:2px;position:absolute;bottom:-1px;left:0;right:0}.wSkVaW_tabActive{color:var(--dsw-alias-state-business-primary)}.wSkVaW_tabActive:after{background:var(--dsw-alias-state-business-primary)}.wSkVaW_viewsMoreAnchor{flex:none}.wSkVaW_viewsMore{width:22px;height:22px;color:var(--dsw-alias-label-secondary);margin-top:-3px;padding:0}.wSkVaW_viewsMoreActive{color:var(--dsw-alias-state-business-primary)}.wSkVaW_tabLabel{text-overflow:ellipsis;white-space:nowrap;max-width:88px;display:block;overflow:hidden}.wSkVaW_viewsMore[aria-expanded=true]{background:var(--dsw-alias-interactive-bg-hover)}.wSkVaW_viewsMoreMenu{width:288px;max-width:calc(100vw - 24px)}.wSkVaW_viewArea{flex-direction:column;flex:1;min-height:0;display:flex}.wSkVaW_widthHandle{z-index:0;width:min(10px, calc((100% - var(--dsh-chat-content-width)) / 2 - 24px - 24px));cursor:col-resize;position:absolute;top:0;bottom:0}.wSkVaW_widthHandle[data-side=left]{right:calc(50% + var(--dsh-chat-content-width) / 2 + 24px)}.wSkVaW_widthHandle[data-side=right]{left:calc(50% + var(--dsh-chat-content-width) / 2 + 24px)}.wSkVaW_widthHandle:after{content:"";background:linear-gradient(to bottom, transparent calc(var(--dsh-width-handle-pointer-y,50%) - 36px), var(--dsw-alias-scrollbar-bg-l1) calc(var(--dsh-width-handle-pointer-y,50%) - 8px), var(--dsw-alias-scrollbar-bg-l1) calc(var(--dsh-width-handle-pointer-y,50%) + 8px), transparent calc(var(--dsh-width-handle-pointer-y,50%) + 36px));opacity:0;pointer-events:none;border-radius:2px;width:2px;position:absolute;top:0;bottom:0}.wSkVaW_widthHandle[data-side=left]:after{right:4px}.wSkVaW_widthHandle[data-side=right]:after{left:4px}.wSkVaW_widthHandle:hover:after,.wSkVaW_widthHandle[data-dragging]:after{opacity:1}.wSkVaW_widthHandle[data-dragging]{z-index:8}.wSkVaW_root:has([data-conversation-composer-overlay]) .wSkVaW_widthHandle{display:none}.wSkVaW_composerStack{--dsh-composer-stack-gap:6px;gap:var(--dsh-composer-stack-gap);flex-direction:column;display:flex}.wSkVaW_composerSeat{--dsh-composer-text-max-height:336px;flex-direction:column;flex:none;display:flex}.wSkVaW_root[data-phase=active]{overflow:hidden}.wSkVaW_root[data-phase=active] .wSkVaW_header{flex:none}.wSkVaW_body{--dsh-chat-content-width:var(--dsh-chat-user-width,clamp(680px, calc(var(--dsh-conversation-column-width,0px) * .64), 920px));--dsh-composer-card-max-width:calc(var(--dsh-chat-content-width) + 32px);--dsh-composer-side-clearance:16px;--dsh-composer-dock-inset:8px;flex-direction:column;flex:1;min-height:0;display:flex;position:relative}.wSkVaW_embeddedBody{--dsh-chat-content-width:min(calc(100% - 32px), 920px);--dsh-composer-card-max-width:min(calc(100% - 16px), 952px);--dsh-composer-side-clearance:8px;--dsh-composer-dock-inset:8px;overflow:hidden}.wSkVaW_scrollBody{scrollbar-gutter:stable;flex-direction:column;flex:1;min-height:0;margin-right:2px;display:flex;overflow-y:auto}.wSkVaW_scrollBody::-webkit-scrollbar-track{margin:2px}.wSkVaW_root[data-phase=active] .wSkVaW_viewArea,.wSkVaW_embeddedBody[data-content-phase=active] .wSkVaW_viewArea{flex:1 0 auto;min-height:auto}.wSkVaW_root[data-phase=active] .wSkVaW_composerSeat,.wSkVaW_embeddedBody[data-content-phase=active] .wSkVaW_composerSeat{z-index:7;background:linear-gradient(180deg, color-mix(in srgb, var(--dsw-alias-bg-base) 0%, transparent) 0px, var(--dsw-alias-bg-base) 36px);position:sticky;bottom:0}.wSkVaW_root[data-phase=active] .wSkVaW_composerSeat:has([data-trigger-menu]){z-index:9}.wSkVaW_scrollBody:has([data-conversation-composer-overlay]){scrollbar-gutter:auto;position:relative;overflow:hidden auto}.wSkVaW_scrollBody:has([data-conversation-composer-overlay])>[data-slot=conversation\\.session]>.wSkVaW_viewArea{flex:1 1 0;min-height:0;overflow:hidden}.wSkVaW_scrollBody:has([data-conversation-composer-overlay])>.wSkVaW_composerSeat{right:var(--dsh-scrollbar-width);position:absolute;bottom:0;left:0}.wSkVaW_composerHero{width:min(calc(var(--dsh-composer-card-max-width) + 2 * var(--dsh-composer-side-clearance)), 100%);z-index:1;align-self:center;gap:8px;padding-bottom:32px}.wSkVaW_heroWorkspaceRow{align-items:center;gap:2px;min-width:0;margin-top:4px;padding:0 16px 0 20px;display:flex}.wSkVaW_heroOptions{flex:none;align-items:center;gap:2px;min-width:0;margin-left:auto;display:flex}.wSkVaW_heroOptions:empty{display:none}.wSkVaW_root[data-phase=hero] .wSkVaW_scrollBody,.wSkVaW_embeddedBody[data-content-phase=hero] .wSkVaW_scrollBody{justify-content:center;overflow-y:auto}.wSkVaW_root[data-phase=settling] .wSkVaW_composerSeat,.wSkVaW_embeddedBody[data-content-phase=settling] .wSkVaW_composerSeat{visibility:hidden}';
var tagId$4 = "@kode/dsh-composer/cfbd9fd95b05/ConversationRoot.module.css";
if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId$4) + "]") === null) {
  const tag = document.createElement("style");
  tag.dataset.plugin = "@kode/dsh-composer";
  tag.dataset.pluginCss = tagId$4;
  tag.textContent = css$4;
  document.head.appendChild(tag);
}
var ConversationRoot_module_css_default = {
  "body": "wSkVaW_body",
  "composerHero": "wSkVaW_composerHero",
  "composerSeat": "wSkVaW_composerSeat",
  "composerStack": "wSkVaW_composerStack",
  "crumb": "wSkVaW_crumb",
  "crumbCurrent": "wSkVaW_crumbCurrent",
  "crumbSeg": "wSkVaW_crumbSeg",
  "crumbSep": "wSkVaW_crumbSep",
  "crumbSubagent": "wSkVaW_crumbSubagent",
  "crumbs": "wSkVaW_crumbs",
  "embeddedBody": "wSkVaW_embeddedBody",
  "header": "wSkVaW_header",
  "headerActions": "wSkVaW_headerActions",
  "headerBlank": "wSkVaW_headerBlank",
  "headerCorner": "wSkVaW_headerCorner",
  "headerLeading": "wSkVaW_headerLeading",
  "headerSessionless": "wSkVaW_headerSessionless",
  "headerUtilities": "wSkVaW_headerUtilities",
  "heroOptions": "wSkVaW_heroOptions",
  "heroWorkspaceRow": "wSkVaW_heroWorkspaceRow",
  "root": "wSkVaW_root",
  "scrollBody": "wSkVaW_scrollBody",
  "tab": "wSkVaW_tab",
  "tabActive": "wSkVaW_tabActive",
  "tabLabel": "wSkVaW_tabLabel",
  "tabs": "wSkVaW_tabs",
  "titleCluster": "wSkVaW_titleCluster",
  "titleRow": "wSkVaW_titleRow",
  "viewArea": "wSkVaW_viewArea",
  "viewTabs": "wSkVaW_viewTabs",
  "viewsMore": "wSkVaW_viewsMore",
  "viewsMoreActive": "wSkVaW_viewsMoreActive",
  "viewsMoreAnchor": "wSkVaW_viewsMoreAnchor",
  "viewsMoreMenu": "wSkVaW_viewsMoreMenu",
  "widthHandle": "wSkVaW_widthHandle"
};
var css$3 = ".pXSMma_root{justify-content:center;align-items:center;min-width:0;height:100%;padding:0 24px;display:flex}.pXSMma_stack{width:100%;max-width:var(--dsh-composer-card-max-width);flex-direction:column;align-items:stretch;gap:12px;display:flex;overflow:visible}.pXSMma_headline{color:var(--dsw-alias-label-primary);flex-wrap:wrap;justify-content:center;align-items:center;gap:12px 10px;font-size:26px;font-weight:500;line-height:32px;display:flex}.pXSMma_titleGroup{flex-wrap:wrap;justify-content:center;align-items:center;gap:4px 7px;min-width:0;display:flex}.pXSMma_previewBadge{border:.5px solid var(--dsw-alias-interactive-bg-hover);corner-shape:round;background:var(--dsw-alias-state-business-tertiary);color:var(--dsw-alias-label-primary-bluish);font-family:var(--ds-font-family-code);white-space:nowrap;border-radius:999px;align-self:flex-start;margin-top:2px;padding:1px 7px 0;font-size:12px;font-weight:500;line-height:18px}.pXSMma_fishHitbox{flex:none;justify-content:center;align-items:center;display:inline-flex}.pXSMma_fish{transform-origin:50% 60%;color:var(--dsw-alias-label-primary);display:block;overflow:visible}@keyframes pXSMma_hero-fish-swim{0%,to{transform:none}35%{transform:rotate(-4deg)translate(-.4px,-.9px)}70%{transform:rotate(1.6deg)translate(.3px,.2px)}}@media (hover:hover) and (prefers-reduced-motion:no-preference){.pXSMma_fishHitbox:hover .pXSMma_fish{animation:1.6s ease-in-out infinite pXSMma_hero-fish-swim}}.pXSMma_body{flex-direction:column;gap:12px;min-width:0;display:flex;position:relative;overflow:visible}.pXSMma_body>*{z-index:1;position:relative}.pXSMma_body>.pXSMma_workspaceRow{z-index:10;align-items:center;min-width:0;padding-left:8px;display:flex}.pXSMma_workspace{border-radius:var(--dsw-radius-sm);max-width:min(100%,360px);min-height:28px;color:var(--dsw-alias-label-primary);cursor:pointer;background:0 0;border:none;align-items:center;gap:4px;padding:0 8px;font-size:13px;font-weight:500;line-height:20px;display:inline-flex}.pXSMma_workspace:not(:disabled):hover,.pXSMma_workspace[aria-expanded=true]{background:var(--dsw-alias-interactive-bg-hover)}.pXSMma_workspace:disabled{cursor:default}.pXSMma_folder{color:var(--dsw-alias-label-primary);flex:none}.pXSMma_workspaceLabel{text-overflow:ellipsis;white-space:nowrap;min-width:0;overflow:hidden}.pXSMma_chevron{color:var(--dsw-alias-label-caption);flex:none}.pXSMma_modalInput{box-sizing:border-box;border:.5px solid var(--dsw-alias-border-l4);border-radius:var(--dsw-radius-lg);width:100%;height:44px;color:var(--dsw-alias-label-primary);background:0 0;outline:none;padding:7px 14px;font-size:14px;font-weight:400;line-height:22px}.pXSMma_modalInput::placeholder{color:var(--dsw-alias-label-caption)}.pXSMma_modalInput:disabled{color:var(--dsw-alias-label-dimmed)}.pXSMma_modalAction{min-width:72px}.pXSMma_modalError{color:var(--dsw-alias-state-error-primary);margin-top:8px;font-size:12px;line-height:18px}";
var tagId$3 = "@kode/dsh-composer/cfbd9fd95b05/HeroShell.module.css";
if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId$3) + "]") === null) {
  const tag = document.createElement("style");
  tag.dataset.plugin = "@kode/dsh-composer";
  tag.dataset.pluginCss = tagId$3;
  tag.textContent = css$3;
  document.head.appendChild(tag);
}
var HeroShell_module_css_default = {
  "body": "pXSMma_body",
  "chevron": "pXSMma_chevron",
  "fish": "pXSMma_fish",
  "fishHitbox": "pXSMma_fishHitbox",
  "folder": "pXSMma_folder",
  "headline": "pXSMma_headline",
  "hero-fish-swim": "pXSMma_hero-fish-swim",
  "modalAction": "pXSMma_modalAction",
  "modalError": "pXSMma_modalError",
  "modalInput": "pXSMma_modalInput",
  "previewBadge": "pXSMma_previewBadge",
  "root": "pXSMma_root",
  "stack": "pXSMma_stack",
  "titleGroup": "pXSMma_titleGroup",
  "workspace": "pXSMma_workspace",
  "workspaceLabel": "pXSMma_workspaceLabel",
  "workspaceRow": "pXSMma_workspaceRow"
};
function WorkspaceChip({ buttonRef, label, menuOpen = false, onClick, t: t2 }) {
  return (0, react_jsx_runtime.jsxs)("button", {
    ref: buttonRef,
    type: "button",
    className: HeroShell_module_css_default.workspace,
    "aria-label": t2("hero.chooseWorkspace"),
    "aria-haspopup": "menu",
    "aria-expanded": menuOpen,
    onClick,
    children: [
      label === void 0 ? (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconFolderCloseRegular, {
        className: HeroShell_module_css_default.folder,
        size: 16
      }) : (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconFolderOpenRegular, {
        className: HeroShell_module_css_default.folder,
        size: 16
      }),
      (0, react_jsx_runtime.jsx)("span", {
        className: HeroShell_module_css_default.workspaceLabel,
        children: label ?? t2("hero.chooseWorkspace")
      }),
      (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconChevronDownOutlineRegular, {
        className: HeroShell_module_css_default.chevron,
        size: 12
      })
    ]
  });
}
function ComposerContentEditable({ editor, editable, ...rest }) {
  const ref = (0, react.useRef)(null);
  (0, react.useLayoutEffect)(() => {
    const el2 = ref.current;
    if (editor === null || el2 === null) return;
    editor.setRootElement(el2);
    return () => {
      editor.setRootElement(null);
    };
  }, [editor]);
  (0, react.useLayoutEffect)(() => {
    if (editor !== null) editor.setEditable(editable);
  }, [editor, editable]);
  return (0, react_jsx_runtime.jsx)("div", {
    ref,
    contentEditable: editor !== null && editable,
    suppressContentEditableWarning: true,
    role: "textbox",
    "aria-multiline": "true",
    "data-composer-input": true,
    ...rest
  });
}
function DecoratorPortals({ editor }) {
  const [decorators, setDecorators] = react.useState(() => editor === null ? {} : editor.getDecorators());
  react.useLayoutEffect(() => {
    if (editor === null) return;
    setDecorators(editor.getDecorators());
    return editor.registerDecoratorListener((next) => {
      setDecorators(next);
    });
  }, [editor]);
  if (editor === null) return null;
  return (0, react_jsx_runtime.jsx)(react_jsx_runtime.Fragment, { children: Object.entries(decorators).map(([key, jsx2]) => {
    const el2 = editor.getElementByKey(key);
    return el2 === null ? null : (0, react_dom.createPortal)(jsx2, el2, key);
  }) });
}
function DraftEditor({ classNames: css2, editor, scrollRef, editable, editorDisabled, phase, placeholderText, ariaLabel, workspaceTrigger, workspacePickerOpen, onWorkspaceKeyDown, hint, showPlaceholder }) {
  return (0, react_jsx_runtime.jsx)("div", {
    ref: scrollRef,
    className: css2.scroll,
    "data-input-scroll": true,
    children: (0, react_jsx_runtime.jsxs)("div", {
      className: css2.grow,
      children: [
        (0, react_jsx_runtime.jsx)(ComposerContentEditable, {
          editor: workspaceTrigger ? null : editor,
          editable,
          className: clsx(css2.input, editorDisabled && css2.inputDisabled),
          "data-phase": phase,
          "aria-disabled": editorDisabled || void 0,
          "data-placeholder": placeholderText,
          "aria-label": ariaLabel,
          "aria-haspopup": workspaceTrigger ? "menu" : void 0,
          "aria-expanded": workspaceTrigger ? workspacePickerOpen : void 0,
          tabIndex: workspaceTrigger ? 0 : void 0,
          onKeyDown: workspaceTrigger ? onWorkspaceKeyDown : void 0,
          style: hint === null ? void 0 : { "--dsh-composer-hint": JSON.stringify(hint) }
        }),
        showPlaceholder && (0, react_jsx_runtime.jsx)("div", {
          "aria-hidden": true,
          className: css2.placeholder,
          "data-composer-placeholder": true,
          children: placeholderText
        }),
        (0, react_jsx_runtime.jsx)(DecoratorPortals, { editor: workspaceTrigger ? null : editor })
      ]
    })
  });
}
function isComposingEvent(event, recentlyComposing) {
  return event.isComposing || event.keyCode === 229 || recentlyComposing();
}
function registerComposerKeymap(editor, handlers) {
  let composing = false;
  let composingUntil = 0;
  let rootElement = null;
  const syncComposition = () => {
    rootElement?.toggleAttribute("data-composer-composing", composing || editor.isComposing());
  };
  const onCompositionStart = () => {
    composing = true;
    syncComposition();
  };
  const onCompositionEnd = () => {
    composing = false;
    composingUntil = Date.now() + 10;
    editor.update(() => {
    }, { onUpdate: syncComposition });
  };
  const recentlyComposing = () => composing || Date.now() < composingUntil;
  const arrow = (key) => (event) => {
    const inComposition = event !== null && isComposingEvent(event, recentlyComposing);
    if (handlers.arbitrate(key, inComposition) !== "pass") {
      event?.preventDefault();
      return true;
    }
    return false;
  };
  return Eu(editor.registerRootListener((root, prevRoot) => {
    prevRoot?.removeEventListener("compositionstart", onCompositionStart);
    prevRoot?.removeEventListener("compositionend", onCompositionEnd);
    prevRoot?.removeAttribute("data-composer-composing");
    composing = false;
    composingUntil = 0;
    rootElement = root;
    root?.addEventListener("compositionstart", onCompositionStart);
    root?.addEventListener("compositionend", onCompositionEnd);
    syncComposition();
  }), editor.registerUpdateListener(syncComposition), editor.registerCommand(sn$2, arrow("up"), 4), editor.registerCommand(ln$2, arrow("down"), 4), editor.registerCommand(hn$2, (event) => arrow(event.shiftKey ? "tabBack" : "tab")(event), 4), editor.registerCommand(fn$1, (event) => {
    handlers.dismissPopup();
    if (handlers.arbitrate("escape", isComposingEvent(event, recentlyComposing)) === "consumed") {
      event.preventDefault();
      return true;
    }
    return false;
  }, 4), editor.registerCommand(an$1, (event) => {
    if (isComposingEvent(event, recentlyComposing)) return false;
    if (handlers.space()) {
      event.preventDefault();
      return true;
    }
    return false;
  }, 4), editor.registerCommand(cn$1, (event) => {
    if (event !== null && (event.altKey || event.getModifierState("AltGraph") || event.ctrlKey && event.metaKey || event.shiftKey && (event.ctrlKey || event.metaKey))) return true;
    if (event?.shiftKey === true) return false;
    if (event !== null && isComposingEvent(event, recentlyComposing)) return true;
    if (handlers.arbitrate("enter", false) !== "pass") {
      event?.preventDefault();
      return true;
    }
    event?.preventDefault();
    if (event?.repeat === true) return true;
    if (!handlers.canSubmit()) return true;
    handlers.submit(event?.ctrlKey === true || event?.metaKey === true);
    return true;
  }, 4), editor.registerCommand(Je$2, (event) => {
    const clipboardData = event.clipboardData ?? null;
    if (clipboardData === null) return false;
    const files = [];
    const directories = /* @__PURE__ */ new Set();
    for (const item of clipboardData.items) {
      if (item.kind !== "file") continue;
      const file = item.getAsFile();
      if (file === null) continue;
      files.push(file);
      if (typeof item.webkitGetAsEntry === "function" && item.webkitGetAsEntry()?.isDirectory === true) directories.add(file);
    }
    if (files.length > 0) handlers.intakeFiles(files, directories.size === 0 ? void 0 : directories);
    const text = clipboardData.getData("text/plain");
    if (text === "") {
      if (files.length === 0) return false;
      event.preventDefault();
      return true;
    }
    event.preventDefault();
    handlers.pasteText(text);
    return true;
  }, 4));
}
function revealDraftSelection(scrollRef) {
  const scrollEl = scrollRef.current;
  if (scrollEl === null || scrollEl.scrollHeight <= scrollEl.clientHeight) return;
  const selection = window.getSelection();
  if (selection === null || selection.rangeCount === 0) return;
  let rect = selection.getRangeAt(0).getBoundingClientRect();
  if (rect.height === 0 && rect.width === 0) {
    const anchor = selection.anchorNode;
    const el2 = anchor instanceof HTMLElement ? anchor : anchor?.parentElement;
    if (el2 === void 0 || el2 === null) return;
    rect = el2.getBoundingClientRect();
  }
  const box = scrollEl.getBoundingClientRect();
  if (rect.bottom > box.bottom) scrollEl.scrollTop += rect.bottom - box.bottom;
  else if (rect.top < box.top) scrollEl.scrollTop -= box.top - rect.top;
}
function focusDraftEditor(editor, revealSelection) {
  editor.getRootElement()?.focus({ preventScroll: true });
  editor.focus(() => {
    revealSelection();
  });
}
function installDraftWheel(scrollRef) {
  const el2 = scrollRef.current;
  if (el2 === null) return;
  const onWheel = (e2) => {
    const host = el2.closest("[data-conversation-scroll]");
    if (!(host instanceof HTMLElement) || e2.deltaY === 0) return;
    const atTop = el2.scrollTop <= 0;
    const atEnd = el2.scrollTop + el2.clientHeight >= el2.scrollHeight - 1;
    if (e2.deltaY < 0 && !atTop || e2.deltaY > 0 && !atEnd) return;
    e2.preventDefault();
    host.scrollTop += e2.deltaY;
  };
  el2.addEventListener("wheel", onWheel, { passive: false });
  return () => {
    el2.removeEventListener("wheel", onWheel);
  };
}
function installDraftFilePicker(keyboard, gate, fileInputRef) {
  return keyboard.bindFilePicker({
    available: () => gate.current.canAcceptDrop && fileInputRef.current !== null && !fileInputRef.current.disabled,
    open: () => {
      fileInputRef.current?.click();
    }
  });
}
function installDraftKeymap(editor, keyboard, gate) {
  return registerComposerKeymap(editor, {
    arbitrate: (key, composing) => keyboard.arbitrate(key, composing),
    space: () => {
      if (gate.current.machineBusy || gate.current.locked) return false;
      return keyboard.space();
    },
    dismissPopup: () => {
      keyboard.dismissPopup();
    },
    canSubmit: () => !gate.current.locked && !gate.current.machineBusy,
    submit: (accelerated) => {
      const g2 = gate.current;
      if (accelerated && g2.canSteerQueue) {
        keyboard.steerQueue();
        return;
      }
      if (g2.uploadsPending) {
        g2.showToast(g2.t("file.stillUploading"));
        return;
      }
      keyboard.submit(resolveSubmitMode(g2.busyEnter, g2.running, accelerated ? "accelerated" : "enter", g2.steeringAvailable), "enter");
    },
    intakeFiles: (files, directories) => {
      gate.current.intakeFiles(files, directories);
    },
    pasteText: (text) => {
      if (gate.current.machineBusy || gate.current.locked) return;
      keyboard.paste(text);
    }
  });
}
function keepDraftFocus(event, editor) {
  event.preventDefault();
  editor?.getRootElement()?.focus({ preventScroll: true });
}
function imageSizeText(bytes) {
  const mb = bytes / (1024 * 1024);
  return `${Number.isInteger(mb) ? String(mb) : mb.toFixed(1)}MB`;
}
function attachmentErrorText(t2, reason, limits) {
  switch (reason) {
    case "MODEL_DOES_NOT_SUPPORT_IMAGES":
      return t2("image.modelUnsupported");
    case "FILE_NOT_STAGED":
      return t2("file.notStaged");
    case "IMAGE_TOO_MANY_PIXELS":
      return t2("image.tooManyPixels");
    case "IMAGE_DIMENSION_TOO_LARGE":
      if (limits !== void 0) return t2("image.dimensionTooLarge", { size: limits.maxImageDimension });
      break;
    case "INVALID_IMAGE":
    case "IMAGE_TYPE_MISMATCH":
      return t2("image.unsupportedType");
    case "TOO_MANY_IMAGES":
      if (limits !== void 0) return t2("image.tooMany", { count: limits.maxImagesPerMessage });
      break;
    case "IMAGE_TOO_LARGE":
      if (limits !== void 0) return t2("image.fileTooLarge", { size: imageSizeText(limits.maxImageBytes) });
      break;
    case "IMAGES_TOO_LARGE":
      if (limits !== void 0) return t2("image.totalTooLarge", { size: imageSizeText(limits.maxMessageImageBytes) });
      break;
    default:
      break;
  }
  return t2("image.sendFailed", { reason });
}
function contextOccupancy(pressure) {
  const usedTokens = pressure?.projectedTokens ?? pressure?.pressureTokens;
  if (usedTokens === void 0 || pressure?.contextWindow === void 0) return null;
  return {
    percent: Math.min(100, Math.round(usedTokens / pressure.contextWindow * 100)),
    usedTokens,
    contextWindow: pressure.contextWindow
  };
}
var css$2 = ".JObwrW_root{flex:none;display:inline-flex}.JObwrW_trigger{border-radius:var(--dsw-radius-sm);color:var(--dsw-alias-label-tertiary);font-family:inherit;font-size:var(--dsh-content-font-size-secondary,13px);font-variant-numeric:tabular-nums;line-height:calc(20px + var(--dsh-content-font-delta-secondary,0px));white-space:nowrap;cursor:pointer;background:0 0;border:none;flex:none;align-items:center;gap:6px;padding:1px 8px;display:inline-flex}.JObwrW_trigger:hover,.JObwrW_trigger[aria-expanded=true]{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary)}.JObwrW_track{fill:none;stroke:var(--dsw-alias-border-l3);stroke-width:2px}.JObwrW_fill{fill:none;stroke:var(--dsw-alias-label-tertiary);stroke-width:2px;stroke-linecap:round}.JObwrW_panel{z-index:1100;box-sizing:border-box;border-radius:var(--dsw-radius-lg);background:var(--dsw-specific-menu);width:min(264px,100vw - 24px);backdrop-filter:var(--dsw-menu-backdrop-filter);--dsw-elevation-stroke-color:var(--dsw-alias-border-l1);box-shadow:var(--dsw-elevation-prominent);color:var(--dsw-alias-label-secondary);cursor:default;border:0;padding:12px;font-size:12px;line-height:20px;position:fixed}.JObwrW_header{align-items:center;gap:6px;display:flex}.JObwrW_figures{font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-primary);margin-left:auto;font-weight:500}.JObwrW_percent{color:var(--dsw-alias-label-primary);font-weight:500}.JObwrW_headline{color:var(--dsw-alias-label-tertiary)}.JObwrW_headline:empty{display:none}.JObwrW_bar{corner-shape:round;background:var(--dsw-alias-interactive-bg-hover);border-radius:999px;gap:1px;height:4px;margin:10px 0 12px;display:flex;overflow:hidden}.JObwrW_segment{background:var(--meter-tint,var(--dsw-alias-label-tertiary));border-radius:1px;flex:none;min-width:2px;height:100%}.JObwrW_swatch{background:var(--meter-tint);vertical-align:baseline;border-radius:2px;width:8px;height:8px;margin-right:6px;display:inline-block}.JObwrW_colorSystem{--meter-tint:var(--dsw-static-neutral-bluish-400)}.JObwrW_colorTools{--meter-tint:#a78bfa}.JObwrW_colorMessages{--meter-tint:var(--dsw-static-blue-450)}.JObwrW_rows{margin:6px 0 0}.JObwrW_row{justify-content:space-between;align-items:center;gap:12px;padding:2px 0;display:flex}.JObwrW_row dt{color:var(--dsw-alias-label-secondary)}.JObwrW_row dd{font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-primary);margin:0}";
var tagId$2 = "@kode/dsh-composer/cfbd9fd95b05/ContextMeter.module.css";
if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId$2) + "]") === null) {
  const tag = document.createElement("style");
  tag.dataset.plugin = "@kode/dsh-composer";
  tag.dataset.pluginCss = tagId$2;
  tag.textContent = css$2;
  document.head.appendChild(tag);
}
var ContextMeter_module_css_default = {
  "bar": "JObwrW_bar",
  "colorMessages": "JObwrW_colorMessages",
  "colorSystem": "JObwrW_colorSystem",
  "colorTools": "JObwrW_colorTools",
  "figures": "JObwrW_figures",
  "fill": "JObwrW_fill",
  "header": "JObwrW_header",
  "headline": "JObwrW_headline",
  "panel": "JObwrW_panel",
  "percent": "JObwrW_percent",
  "root": "JObwrW_root",
  "row": "JObwrW_row",
  "rows": "JObwrW_rows",
  "segment": "JObwrW_segment",
  "swatch": "JObwrW_swatch",
  "track": "JObwrW_track",
  "trigger": "JObwrW_trigger"
};
var RADIUS = 5.5;
var CIRCUMFERENCE = 2 * Math.PI * RADIUS;
var READING_SLOT = "\0";
var ROWS = [
  {
    key: "systemTokens",
    label: "context.system",
    color: ContextMeter_module_css_default.colorSystem
  },
  {
    key: "toolsTokens",
    label: "context.tools",
    color: ContextMeter_module_css_default.colorTools
  },
  {
    key: "messageTokens",
    label: "context.messages",
    color: ContextMeter_module_css_default.colorMessages
  }
];
function formatTokens(value, t2) {
  const scaled = (candidate) => candidate >= 100 ? String(Math.round(candidate)) : String(Math.round(candidate * 10) / 10);
  if (value < 1e3) return String(value);
  if (value < 1e6) return t2("number.thousand", { value: scaled(value / 1e3) });
  return t2("number.million", { value: scaled(value / 1e6) });
}
function ContextMeter({ useProjection, t: t2 }) {
  const pressure = useProjection("contextPressure");
  const breakdown = useProjection("contextBreakdown");
  const [open, setOpen] = (0, react.useState)(false);
  const rootRef = (0, react.useRef)(null);
  const panelRef = (0, react.useRef)(null);
  const context = contextOccupancy(pressure);
  const available = context !== null;
  const position = (0, _deepseek_ai_dsh_client_ui_primitives.useAnchoredPosition)({
    open: open && available,
    anchorRef: rootRef,
    panelRef,
    side: "top",
    gap: 8,
    margin: 12
  });
  (0, _deepseek_ai_dsh_client_ui_primitives.useDismissOnOutsidePointer)(rootRef, open && available, setOpen, panelRef);
  (0, react.useEffect)(() => {
    if (!available && open) setOpen(false);
  }, [available, open]);
  (0, react.useEffect)(() => {
    if (!open || !available) return;
    const onKeyDown = (e2) => {
      if (e2.key === "Escape") setOpen(false);
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [available, open]);
  if (context === null) return null;
  const percent2 = context.percent;
  const reading = `${percent2}%`;
  const [headBefore = "", headAfter = ""] = t2("context.aria", { percent: READING_SLOT }).split(READING_SLOT).map((part) => part.trim());
  const breakdownTotal = breakdown === void 0 ? 0 : breakdown.systemTokens + breakdown.toolsTokens + breakdown.messageTokens;
  const segments = (breakdown === void 0 || breakdownTotal === 0 ? [{
    key: "total",
    color: void 0,
    width: percent2
  }] : ROWS.map((row) => ({
    key: row.key,
    color: row.color,
    width: percent2 * breakdown[row.key] / breakdownTotal
  }))).filter((part) => part.width > 0);
  return (0, react_jsx_runtime.jsxs)("span", {
    ref: rootRef,
    className: ContextMeter_module_css_default.root,
    children: [(0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Tooltip, {
      label: t2("context.aria", { percent: reading }),
      side: "top",
      delayMs: 200,
      disabled: open,
      children: (0, react_jsx_runtime.jsxs)("button", {
        type: "button",
        className: ContextMeter_module_css_default.trigger,
        "aria-label": t2("context.aria", { percent: reading }),
        "aria-haspopup": "dialog",
        "aria-expanded": open,
        onClick: () => {
          setOpen(!open);
        },
        children: [(0, react_jsx_runtime.jsxs)("svg", {
          viewBox: "0 0 14 14",
          width: "14",
          height: "14",
          "aria-hidden": true,
          children: [(0, react_jsx_runtime.jsx)("circle", {
            className: ContextMeter_module_css_default.track,
            cx: "7",
            cy: "7",
            r: RADIUS
          }), (0, react_jsx_runtime.jsx)("circle", {
            className: ContextMeter_module_css_default.fill,
            cx: "7",
            cy: "7",
            r: RADIUS,
            strokeDasharray: `${CIRCUMFERENCE * percent2 / 100} ${CIRCUMFERENCE}`,
            transform: "rotate(-90 7 7)"
          })]
        }), (0, react_jsx_runtime.jsx)("span", { children: reading })]
      })
    }), open && (0, react_dom.createPortal)((0, react_jsx_runtime.jsxs)("div", {
      ref: panelRef,
      className: ContextMeter_module_css_default.panel,
      style: position ?? {
        visibility: "hidden",
        left: 0,
        top: 0
      },
      role: "dialog",
      "aria-label": t2("context.used"),
      children: [
        (0, react_jsx_runtime.jsxs)("div", {
          className: ContextMeter_module_css_default.header,
          children: [
            (0, react_jsx_runtime.jsx)("span", {
              className: ContextMeter_module_css_default.headline,
              children: headBefore
            }),
            (0, react_jsx_runtime.jsx)("span", {
              className: ContextMeter_module_css_default.percent,
              children: reading
            }),
            (0, react_jsx_runtime.jsx)("span", {
              className: ContextMeter_module_css_default.headline,
              children: headAfter
            }),
            (0, react_jsx_runtime.jsx)("span", {
              className: ContextMeter_module_css_default.figures,
              children: `~${formatTokens(context.usedTokens, t2)} / ${formatTokens(context.contextWindow, t2)}`
            })
          ]
        }),
        (0, react_jsx_runtime.jsx)("div", {
          className: ContextMeter_module_css_default.bar,
          children: segments.map((segment) => (0, react_jsx_runtime.jsx)("div", {
            className: segment.color === void 0 ? ContextMeter_module_css_default.segment : `${ContextMeter_module_css_default.segment} ${segment.color}`,
            style: { width: `${segment.width}%` }
          }, segment.key))
        }),
        breakdown !== void 0 && (0, react_jsx_runtime.jsx)("dl", {
          className: ContextMeter_module_css_default.rows,
          children: ROWS.map((row) => (0, react_jsx_runtime.jsxs)("div", {
            className: ContextMeter_module_css_default.row,
            children: [(0, react_jsx_runtime.jsxs)("dt", { children: [(0, react_jsx_runtime.jsx)("span", {
              className: `${ContextMeter_module_css_default.swatch} ${row.color}`,
              "aria-hidden": true
            }), t2(row.label)] }), (0, react_jsx_runtime.jsx)("dd", { children: `~${formatTokens(breakdown[row.key], t2)}` })]
          }, row.key))
        })
      ]
    }), document.body)]
  });
}
function observeControlRow(row) {
  const measure = () => {
    row.removeAttribute("data-model-compact");
    const style = getComputedStyle(row);
    const available = row.getBoundingClientRect().width - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
    const widths = Array.from(row.children, (child) => child.getBoundingClientRect().width).filter((width) => width > 0);
    const needed = widths.reduce((sum, width) => sum + width, 0) + Math.max(0, widths.length - 1) * parseFloat(style.columnGap);
    row.toggleAttribute("data-model-compact", needed > available);
  };
  const resize = new ResizeObserver(measure);
  resize.observe(row);
  for (const child of row.children) resize.observe(child);
  const mutation = new MutationObserver(measure);
  mutation.observe(row, {
    subtree: true,
    childList: true,
    characterData: true,
    attributes: true,
    attributeFilter: ["hidden"]
  });
  const fonts = document.fonts;
  fonts.addEventListener("loadingdone", measure);
  measure();
  return () => {
    resize.disconnect();
    mutation.disconnect();
    fonts.removeEventListener("loadingdone", measure);
  };
}
var css$1 = `.uV2eYG_root{padding:0 var(--dsh-composer-side-clearance) 4px;flex-direction:column;align-items:center;display:flex}.uV2eYG_dock{justify-content:center;align-items:center;gap:12px;max-width:100%;padding-top:4px;display:flex}.uV2eYG_hero .uV2eYG_dock:empty{display:none}.uV2eYG_hero{padding:0 var(--dsh-composer-side-clearance)}.uV2eYG_notice{width:100%;max-width:var(--dsh-composer-card-max-width);border-radius:var(--dsw-radius-md);background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary);margin-bottom:6px;padding:4px 8px;font-size:12px;line-height:18px}.uV2eYG_card{box-sizing:border-box;width:100%;max-width:var(--dsh-composer-card-max-width);--dsw-elevation-stroke-color:var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-panel);background:var(--dsw-specific-input-major);box-shadow:var(--dsw-elevation-soft);font-size:var(--dsh-content-font-size,14px);line-height:calc(24px + var(--dsh-content-font-delta,0px));--dsh-scrollbar-thumb:var(--dsw-alias-scrollbar-bg-l2);--dsh-scrollbar-thumb-hover:var(--dsw-alias-scrollbar-hover-l2);border:0;flex-direction:column;gap:12px;padding-top:8px;display:flex;position:relative}.uV2eYG_cardWorkspaceTrigger{--dsw-elevation-stroke-color:transparent;cursor:pointer}.uV2eYG_cardWorkspaceTrigger:after{content:"";box-sizing:border-box;border-radius:var(--dsw-radius-panel);color:var(--dsw-alias-border-l4);pointer-events:none;border:1px dashed;transition:color .1s;position:absolute;inset:0}.uV2eYG_cardWorkspaceTrigger :disabled{pointer-events:none}.uV2eYG_cardWorkspaceTrigger:hover:after{color:var(--dsw-alias-state-business-primary)}.uV2eYG_accessory{align-items:center;gap:8px;padding:10px 12px 0;display:flex}.uV2eYG_overlayAnchor{height:0;position:absolute;inset:0 0 auto}.uV2eYG_scroll{max-height:var(--dsh-composer-text-max-height);margin-right:4px;overflow-y:auto}.uV2eYG_scroll::-webkit-scrollbar-track{margin-top:8px}.uV2eYG_grow{position:relative}.uV2eYG_pending{corner-shape:round;background:var(--dsw-alias-state-business-primary);border-radius:50%;width:8px;height:8px;animation:1s ease-in-out infinite alternate uV2eYG_input-pending}@keyframes uV2eYG_input-pending{0%{opacity:.35}to{opacity:1}}.uV2eYG_input{box-sizing:border-box;min-height:36px;font-family:var(--dsw-font-family);font-size:inherit;line-height:inherit;white-space:pre-wrap;word-break:break-word;overflow-wrap:anywhere;color:var(--dsw-alias-label-primary);caret-color:var(--dsw-alias-state-business-primary);outline:none;padding:4px 8px 0 14px}.uV2eYG_input p{margin:0}.uV2eYG_input p:last-child:after{content:var(--dsh-composer-hint);color:var(--dsw-alias-label-caption)}.uV2eYG_input[data-composer-composing] p:last-child:after{content:none}.uV2eYG_input[data-composer-chip-selected]{caret-color:#0000}.uV2eYG_input[data-composer-composing]+.uV2eYG_placeholder{visibility:hidden}.uV2eYG_placeholder{color:var(--dsw-alias-label-caption);white-space:nowrap;text-overflow:ellipsis;pointer-events:none;user-select:none;position:absolute;inset:4px 8px auto 14px;overflow:hidden}.uV2eYG_inputDisabled{color:var(--dsw-alias-label-tertiary);cursor:not-allowed}.uV2eYG_input[aria-haspopup=menu]{cursor:pointer}.uV2eYG_hero .uV2eYG_input{min-height:52px}.uV2eYG_hero .uV2eYG_placeholder{white-space:normal;-webkit-line-clamp:2;line-clamp:2;-webkit-box-orient:vertical;display:-webkit-box}.uV2eYG_row{flex-wrap:wrap;justify-content:space-between;align-items:center;gap:12px;min-width:0;padding:2px 8px 6px;display:flex;container-type:inline-size}.uV2eYG_row[data-model-compact]{--dsh-composer-model-text-display:none;--dsh-composer-model-icon-display:block}.uV2eYG_tools,.uV2eYG_modes,.uV2eYG_trailing{align-items:center;min-width:0;display:flex}.uV2eYG_tools,.uV2eYG_modes{gap:12px}.uV2eYG_trailing{flex:none;gap:12px;margin-left:auto}@container (width<=560px){.uV2eYG_tools,.uV2eYG_modes,.uV2eYG_trailing{gap:8px}}.uV2eYG_add{corner-shape:round;background:var(--dsw-specific-selector);width:28px;height:28px;color:var(--dsw-alias-label-primary);cursor:pointer;border:none;border-radius:999px;flex:none;place-items:center;display:grid}.uV2eYG_add:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover-solid)}.uV2eYG_add:disabled{opacity:.5;cursor:default}.uV2eYG_select{border-radius:var(--dsw-radius-sm);max-width:220px;height:28px;color:var(--dsw-alias-label-secondary);white-space:nowrap;cursor:pointer;appearance:none;background-color:#0000;background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 12 12' fill='none'%3E%3Cpath d='M3 4.5L6 7.5L9 4.5' stroke='%2381858C' stroke-width='1.5' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E");background-position:right 4px center;background-repeat:no-repeat;background-size:12px 12px;border:none;outline:none;padding:0 20px 0 8px;font-size:13px;font-weight:500;line-height:20px}.uV2eYG_select:hover:not(:disabled){background-color:var(--dsw-alias-interactive-bg-hover)}.uV2eYG_select:disabled{opacity:.5;cursor:default}.uV2eYG_primary{corner-shape:round;background:var(--dsw-alias-button-info-fill);color:#fff;cursor:pointer;border:none;border-radius:999px;flex:none;place-items:center;width:34px;height:34px;transition:background-color .1s;display:grid;transform:translateY(-2px)}.uV2eYG_primary:hover:not(:disabled){background:var(--dsw-alias-button-info-hover)}.uV2eYG_primary:disabled{opacity:.4;cursor:default}.uV2eYG_retry{border-radius:var(--dsw-radius-sm);color:inherit;cursor:pointer;background:0 0;border:1px solid;margin-left:8px;padding:1px 8px;font-size:12px}.uV2eYG_standardControls{align-items:center;gap:12px;min-width:0;display:flex}.uV2eYG_tools[hidden],.uV2eYG_standardControls[hidden]{display:none}.uV2eYG_trailingActive{flex:1;margin-left:0}.uV2eYG_activity{flex:none;align-items:center;display:flex}.uV2eYG_activity:empty{display:none}.uV2eYG_activityExpanded{flex:1;min-width:0}`;
var tagId$1 = "@kode/dsh-composer/cfbd9fd95b05/InputBar.module.css";
if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId$1) + "]") === null) {
  const tag = document.createElement("style");
  tag.dataset.plugin = "@kode/dsh-composer";
  tag.dataset.pluginCss = tagId$1;
  tag.textContent = css$1;
  document.head.appendChild(tag);
}
var InputBar_module_css_default = {
  "accessory": "uV2eYG_accessory",
  "activity": "uV2eYG_activity",
  "activityExpanded": "uV2eYG_activityExpanded",
  "add": "uV2eYG_add",
  "card": "uV2eYG_card",
  "cardWorkspaceTrigger": "uV2eYG_cardWorkspaceTrigger",
  "dock": "uV2eYG_dock",
  "grow": "uV2eYG_grow",
  "hero": "uV2eYG_hero",
  "input": "uV2eYG_input",
  "input-pending": "uV2eYG_input-pending",
  "inputDisabled": "uV2eYG_inputDisabled",
  "modes": "uV2eYG_modes",
  "notice": "uV2eYG_notice",
  "overlayAnchor": "uV2eYG_overlayAnchor",
  "pending": "uV2eYG_pending",
  "placeholder": "uV2eYG_placeholder",
  "primary": "uV2eYG_primary",
  "retry": "uV2eYG_retry",
  "root": "uV2eYG_root",
  "row": "uV2eYG_row",
  "scroll": "uV2eYG_scroll",
  "select": "uV2eYG_select",
  "standardControls": "uV2eYG_standardControls",
  "tools": "uV2eYG_tools",
  "trailing": "uV2eYG_trailing",
  "trailingActive": "uV2eYG_trailingActive"
};
var InputBar = (0, react.memo)(function InputBar2({ useSession, useInput, inputActions, keyboard, addFiles, removeAttachment, resolveDraftAttachments, retryFileUpload, toggleCommandMenu, stop, t: t2, renderSlot, useBusyEnter, useFileUploads, useNotices, useLexicon, useMenuLauncher, useStopShortcut, useProjection, sessionId, variant, disabled: inert = false, blocked, workspacePickerOpen = false, onRequestWorkspace, placeholder, accessory }) {
  const input = useInput((s2) => s2);
  const notice = useNotices((s2) => s2);
  const busyEnter = useBusyEnter((s2) => s2);
  const stopKeys = useStopShortcut((keys) => keys);
  const commandMenuOpen = useMenuLauncher((source) => source === "command");
  const [activity, setActivity] = (0, react.useState)(false);
  (0, react.useEffect)(() => {
    setActivity(false);
  }, [sessionId]);
  const promptError = useSession((s2) => s2.promptError) ?? null;
  const running = useSession((s2) => s2.running) ?? false;
  const subagent = useSession((s2) => s2.subagent) ?? null;
  const removed = useSession((s2) => s2.removed) ?? false;
  const planActive = useProjection("plan", (plan) => plan !== void 0 && (plan.pending ? !plan.active : plan.active));
  const hasGoal = useProjection("goal", (goal) => goal != null);
  const live = input !== void 0 && keyboard !== void 0 && inputActions !== void 0;
  const draft = input?.draft ?? "";
  const editor = keyboard?.editor ?? null;
  const attachments = (0, react.useMemo)(() => input === void 0 || resolveDraftAttachments === void 0 ? [] : resolveDraftAttachments(input.attachmentIds), [resolveDraftAttachments, input?.attachmentIds]);
  const empty = draft.trim() === "" && attachments.length === 0;
  const uploads = useFileUploads((snapshot2) => snapshot2);
  const uploadsPending = attachments.some((attachment) => attachment.kind === "file" && uploads[attachment.id]?.status !== "ready");
  const [toast, setToast] = (0, react.useState)(null);
  const toastSeq = (0, react.useRef)(0);
  const showToast = (0, react.useCallback)((text) => {
    toastSeq.current += 1;
    setToast({
      seq: toastSeq.current,
      text
    });
  }, []);
  const dismissToast = (0, react.useCallback)(() => {
    setToast(null);
  }, []);
  const imageLimits = useProjection("imageLimits");
  (0, react.useEffect)(() => {
    if (promptError === null) return;
    const { error } = promptError;
    if (error.code === "session/writer-held") {
      showToast(t2("error.sessionInUse"));
      return;
    }
    showToast(error.code === "session/attachment-invalid" || error.code === "subagent/attachment-invalid" ? attachmentErrorText(t2, error.details.reason, imageLimits) : `${error.message} (${error.code})`);
  }, [
    promptError,
    showToast,
    t2,
    imageLimits
  ]);
  (0, react.useEffect)(() => {
    if (notice?.level === "error") showToast(notice.text);
  }, [notice, showToast]);
  const rowRef = (0, react.useRef)(null);
  (0, react.useLayoutEffect)(() => {
    const row = rowRef.current;
    if (row === null) return;
    return observeControlRow(row);
  }, []);
  const cardRef = (0, react.useRef)(null);
  const scrollRef = (0, react.useRef)(null);
  const continuable = subagent?.address.mode === "continuable";
  const parentOffline = continuable && subagent.parentAvailable !== true;
  const disabled = removed || inert || !live || blocked !== void 0 || parentOffline;
  const locked = disabled;
  const modelSeatLocked = removed || inert || !live;
  const machineBusy = input?.phase === "adjudicating" || input?.phase === "submitting";
  const workspaceTrigger = inert && !removed && onRequestWorkspace !== void 0;
  const editorDisabled = removed || locked && !workspaceTrigger;
  const editable = live && !locked && !machineBusy;
  const steeringAvailable = subagent === null || subagent.address.mode === "continuable";
  const canSteerQueue = !locked && !machineBusy && !commandMenuOpen && empty && running && steeringAvailable && input.queue.length > 0;
  (0, react.useEffect)(() => {
    if (input === void 0 || inputActions === void 0) return;
    if (attachments.length !== input.attachmentIds.length) inputActions.pruneAttachments(attachments.map((attachment) => attachment.id));
  }, [
    attachments,
    input?.attachmentIds,
    inputActions
  ]);
  const revealSelection = () => {
    revealDraftSelection(scrollRef);
  };
  (0, react.useEffect)(() => {
    if (locked || editor === null) return;
    focusDraftEditor(editor, revealSelection);
  }, [
    locked,
    sessionId,
    editor
  ]);
  (0, react.useEffect)(() => {
    if (locked || draft === "") return;
    revealSelection();
  }, [draft !== ""]);
  (0, react.useEffect)(() => {
    return installDraftWheel(scrollRef);
  }, []);
  const intakeFiles = (0, react.useCallback)((files, directories) => {
    if (locked || machineBusy || subagent !== null && !continuable || addFiles === void 0 || files.length === 0) return;
    const rejected = (() => {
      if (continuable && files.some((file) => directories?.has(file) || !isImageMediaType(file.type))) return t2("image.unsupportedType");
      if (imageLimits !== void 0) {
        const mediaTypes = imageLimits.mediaTypes;
        const images = files.filter((file) => mediaTypes.includes(file.type));
        const imageAttachments = attachments.filter((attachment) => attachment.kind === "image");
        if (imageAttachments.length + images.length > imageLimits.maxImagesPerMessage) return t2("image.tooMany", { count: imageLimits.maxImagesPerMessage });
        if (images.some((file) => file.size > imageLimits.maxImageBytes)) return t2("image.fileTooLarge", { size: imageSizeText(imageLimits.maxImageBytes) });
        if (imageAttachments.reduce((sum, attachment) => sum + attachment.file.size, 0) + images.reduce((sum, file) => sum + file.size, 0) > imageLimits.maxMessageImageBytes) return t2("image.totalTooLarge", { size: imageSizeText(imageLimits.maxMessageImageBytes) });
      }
      return addFiles(files, directories);
    })();
    if (rejected !== null) showToast(rejected);
  }, [
    locked,
    machineBusy,
    subagent,
    continuable,
    addFiles,
    attachments,
    imageLimits,
    showToast,
    t2
  ]);
  const canAcceptDrop = (subagent === null || continuable) && !locked && !machineBusy && addFiles !== void 0;
  const fileInputRef = (0, react.useRef)(null);
  const onPickFiles = (e2) => {
    const picked = e2.target.files === null ? [] : [...e2.target.files];
    e2.target.value = "";
    if (picked.length > 0) intakeFiles(picked);
  };
  const gate = (0, react.useRef)({
    locked,
    machineBusy,
    canSteerQueue,
    running,
    steeringAvailable,
    busyEnter,
    intakeFiles,
    uploadsPending,
    showToast,
    t: t2,
    canAcceptDrop
  });
  gate.current = {
    locked,
    machineBusy,
    canSteerQueue,
    running,
    steeringAvailable,
    busyEnter,
    intakeFiles,
    uploadsPending,
    showToast,
    t: t2,
    canAcceptDrop
  };
  (0, react.useEffect)(() => {
    if (keyboard === void 0) return;
    return installDraftFilePicker(keyboard, gate, fileInputRef);
  }, [keyboard]);
  (0, react.useEffect)(() => {
    if (editor === null || keyboard === void 0) return;
    return installDraftKeymap(editor, keyboard, gate);
  }, [editor, keyboard]);
  const keepFocus = (e2) => {
    keepDraftFocus(e2, editor);
  };
  const onCardMouseDown = (e2) => {
    if (!editable || editor === null || e2.button !== 0 || e2.defaultPrevented) return;
    const target = e2.target;
    if (!(target instanceof Element) || !e2.currentTarget.contains(target)) return;
    if (target.closest("[data-composer-overlay]") !== null) return;
    if (scrollRef.current?.contains(target)) return;
    const control = target.closest('button, a, input, select, textarea, [role="button"], [contenteditable], [tabindex]');
    if (control !== null && e2.currentTarget.contains(control)) return;
    e2.preventDefault();
    if (document.activeElement !== editor.getRootElement()) focusDraftEditor(editor, revealSelection);
  };
  const onToggleCommandMenu = () => {
    if (keyboard === void 0) return;
    if (editor !== null) focusDraftEditor(editor, revealSelection);
    toggleCommandMenu?.(keyboard.caretSpan());
  };
  const onWorkspaceKeyDown = (e2) => {
    if (!workspaceTrigger) return;
    if (e2.key === "Enter" || e2.key === " ") {
      e2.preventDefault();
      onRequestWorkspace();
    }
  };
  const primaryStops = running && subagent === null && (empty || blocked !== void 0);
  const primaryDisabled = primaryStops ? stop === void 0 : empty || disabled || machineBusy || uploadsPending;
  const interruptible = running && continuable;
  const primarySubmitMode = resolveSubmitMode(busyEnter, running, "enter", steeringAvailable);
  const plainMessageDraft = !empty && input?.phase === "plain" && !draft.trimStart().startsWith("/");
  const primaryLabel = primaryStops ? t2("input.stop") : running && steeringAvailable && !disabled && !uploadsPending && plainMessageDraft ? t2(primarySubmitMode === "steer" ? "input.send.steer" : "input.send.queue") : t2("input.send");
  const onPrimary = () => {
    if (primaryStops) {
      stop?.();
      return;
    }
    if (keyboard === void 0) return;
    if (!empty && !disabled && !machineBusy && !uploadsPending) keyboard.submit(primarySubmitMode, "click");
  };
  const claimActive = (input?.phase === "claimed" || input?.phase === "submitting") && input.claim !== void 0 && draft.startsWith(input.claim.token);
  const rawHint = claimActive && input.claim.hint !== void 0 && draft.slice(input.claim.token.length).trim() === "" ? input.claim.hint : null;
  const hint = (() => {
    if (rawHint === null) return null;
    const commandName = input?.claim?.name ?? "";
    const hintKey = `hint.${commandName === "goal" && hasGoal ? "goal.active" : commandName}`;
    const translated = t2(hintKey);
    return translated !== hintKey ? translated : rawHint;
  })();
  const placeholderText = placeholder ?? (parentOffline ? t2("placeholder.parentOffline") : disabled ? t2("placeholder.unavailable") : canSteerQueue ? t2("placeholder.steerQueue") : planActive ? t2("placeholder.plan") : t2("placeholder.default"));
  return (0, react_jsx_runtime.jsxs)("div", {
    className: clsx(InputBar_module_css_default.root, variant === "hero" && InputBar_module_css_default.hero),
    children: [
      toast !== null && (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Toast, {
        text: toast.text,
        icon: (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconWarningOutlineRegular, {}),
        anchor: cardRef.current,
        onDone: dismissToast
      }, toast.seq),
      notice?.level === "info" && (0, react_jsx_runtime.jsx)("div", {
        className: InputBar_module_css_default.notice,
        role: "status",
        children: notice.text
      }),
      (0, react_jsx_runtime.jsxs)("div", {
        ref: cardRef,
        className: clsx(InputBar_module_css_default.card, workspaceTrigger && InputBar_module_css_default.cardWorkspaceTrigger),
        "data-composer-card": true,
        onClick: workspaceTrigger ? onRequestWorkspace : void 0,
        onPointerDown: workspaceTrigger ? (e2) => {
          e2.stopPropagation();
        } : void 0,
        onMouseDown: onCardMouseDown,
        children: [
          sessionId !== void 0 && (0, react_jsx_runtime.jsx)("div", {
            className: InputBar_module_css_default.overlayAnchor,
            "data-composer-overlay": true,
            children: renderSlot("conversation.input.overlay", {})
          }),
          accessory !== void 0 && (0, react_jsx_runtime.jsx)("div", {
            className: InputBar_module_css_default.accessory,
            children: accessory
          }),
          renderSlot("conversation.input.attachments", {
            attachments,
            canAcceptDrop,
            onAddFiles: intakeFiles,
            onRemoveAttachment: (id) => {
              removeAttachment?.(id);
            },
            uploads,
            onRetryFile: (id) => {
              retryFileUpload?.(id);
            },
            dropLimits: imageLimits === void 0 ? void 0 : {
              count: imageLimits.maxImagesPerMessage,
              size: imageSizeText(imageLimits.maxImageBytes)
            }
          }),
          (0, react_jsx_runtime.jsx)(DraftEditor, {
            classNames: InputBar_module_css_default,
            editor,
            scrollRef,
            editable,
            editorDisabled,
            phase: input?.phase ?? "inert",
            placeholderText,
            ariaLabel: workspaceTrigger ? t2("hero.chooseWorkspace") : placeholderText,
            workspaceTrigger,
            workspacePickerOpen,
            onWorkspaceKeyDown,
            hint,
            showPlaceholder: draft === "" && attachments.length === 0 && !claimActive
          }),
          (0, react_jsx_runtime.jsxs)("div", {
            ref: rowRef,
            className: InputBar_module_css_default.row,
            children: [(0, react_jsx_runtime.jsxs)("div", {
              className: InputBar_module_css_default.tools,
              hidden: activity,
              children: [
                (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Tooltip, {
                  label: t2("input.commands"),
                  side: "top",
                  delayMs: 500,
                  children: (0, react_jsx_runtime.jsx)("button", {
                    type: "button",
                    className: InputBar_module_css_default.add,
                    "aria-label": t2("input.commands"),
                    "aria-haspopup": "listbox",
                    "aria-expanded": commandMenuOpen,
                    disabled: locked || toggleCommandMenu === void 0,
                    onMouseDown: keepFocus,
                    onClick: onToggleCommandMenu,
                    children: (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconPlusOutlineMedium, { size: 14 })
                  })
                }),
                (0, react_jsx_runtime.jsx)("input", {
                  ref: fileInputRef,
                  type: "file",
                  multiple: true,
                  disabled: subagent !== null,
                  hidden: true,
                  onChange: onPickFiles
                }),
                (0, react_jsx_runtime.jsxs)("div", {
                  className: InputBar_module_css_default.modes,
                  children: [sessionId === void 0 ? null : renderSlot("conversation.input.permission", { locked }), sessionId === void 0 ? null : renderSlot("conversation.input.plan", { locked })]
                }),
                input === void 0 || sessionId === void 0 ? null : renderSlot("conversation.input.left", {})
              ]
            }), (0, react_jsx_runtime.jsxs)("div", {
              className: clsx(InputBar_module_css_default.trailing, activity && InputBar_module_css_default.trailingActive),
              children: [
                (0, react_jsx_runtime.jsxs)("div", {
                  className: InputBar_module_css_default.standardControls,
                  hidden: activity,
                  children: [input === void 0 || sessionId === void 0 ? null : renderSlot("conversation.input.right", {}), sessionId === void 0 ? null : renderSlot("conversation.input.model", { locked: modelSeatLocked })]
                }),
                input === void 0 || sessionId === void 0 ? null : (0, react_jsx_runtime.jsx)("div", {
                  className: activity ? InputBar_module_css_default.activityExpanded : InputBar_module_css_default.activity,
                  children: renderSlot("conversation.input.activity", {
                    locked,
                    onActiveChange: setActivity
                  })
                }),
                interruptible && (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Tooltip, {
                  label: t2("input.stop"),
                  shortcutKeys: stopKeys,
                  side: "top",
                  delayMs: 500,
                  disabled: stop === void 0,
                  children: (0, react_jsx_runtime.jsx)("button", {
                    type: "button",
                    className: InputBar_module_css_default.primary,
                    "aria-label": t2("input.stop"),
                    disabled: stop === void 0,
                    onMouseDown: keepFocus,
                    onClick: stop,
                    children: (0, react_jsx_runtime.jsx)("svg", {
                      viewBox: "0 0 16 16",
                      width: "16",
                      height: "16",
                      "aria-hidden": true,
                      children: (0, react_jsx_runtime.jsx)("rect", {
                        x: "3",
                        y: "3",
                        width: "10",
                        height: "10",
                        rx: "3",
                        fill: "currentColor"
                      })
                    })
                  })
                }),
                (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Tooltip, {
                  label: primaryStops ? t2("input.stop") : primaryLabel,
                  shortcutKeys: primaryStops ? stopKeys : void 0,
                  side: "top",
                  delayMs: 500,
                  disabled: primaryDisabled,
                  children: (0, react_jsx_runtime.jsx)("button", {
                    type: "button",
                    className: InputBar_module_css_default.primary,
                    "aria-label": primaryLabel,
                    disabled: primaryDisabled,
                    onMouseDown: keepFocus,
                    onClick: onPrimary,
                    children: primaryStops ? (0, react_jsx_runtime.jsx)("svg", {
                      viewBox: "0 0 16 16",
                      width: "16",
                      height: "16",
                      "aria-hidden": true,
                      children: (0, react_jsx_runtime.jsx)("rect", {
                        x: "3",
                        y: "3",
                        width: "10",
                        height: "10",
                        rx: "3",
                        fill: "currentColor"
                      })
                    }) : (0, react_jsx_runtime.jsx)("svg", {
                      viewBox: "0 0 16 16",
                      width: "16",
                      height: "16",
                      "aria-hidden": true,
                      children: (0, react_jsx_runtime.jsx)("path", {
                        d: "M8.3125 0.980183C8.66767 1.0531 8.97902 1.20418 9.2627 1.43233C9.48724 1.61297 9.73029 1.85793 9.97949 2.10714L14.707 6.83468L13.293 8.24874L9 3.95577V15.0417H7V3.95577L2.70703 8.24874L1.29297 6.83468L6.02051 2.10714C6.26971 1.85793 6.51277 1.61297 6.7373 1.43233C6.97662 1.23986 7.28445 1.04402 7.6875 0.980183C7.8973 0.947006 8.1031 0.95516 8.3125 0.980183Z",
                        fill: "currentColor"
                      })
                    })
                  })
                })
              ]
            })]
          })
        ]
      }),
      (0, react_jsx_runtime.jsxs)("div", {
        className: InputBar_module_css_default.dock,
        "data-composer-dock": true,
        children: [variant === "composer" && input !== void 0 && sessionId !== void 0 ? renderSlot("conversation.composer.dock", {}) : null, activity ? null : (0, react_jsx_runtime.jsx)(ContextMeter, {
          useProjection,
          t: t2
        })]
      })
    ]
  });
});
var css = ".lXshSW_root{box-sizing:border-box;width:calc(100% - var(--dsh-composer-side-clearance) - var(--dsh-composer-side-clearance) - var(--dsh-composer-dock-inset) - var(--dsh-composer-dock-inset) - var(--dsh-composer-dock-inset) - var(--dsh-composer-dock-inset));max-width:calc(var(--dsh-composer-card-max-width) - var(--dsh-composer-dock-inset) - var(--dsh-composer-dock-inset) - var(--dsh-composer-dock-inset) - var(--dsh-composer-dock-inset));--dsw-elevation-stroke-color:var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-lg);background:var(--dsw-specific-menu);backdrop-filter:var(--dsw-menu-backdrop-filter);box-shadow:var(--dsw-elevation-panel);--dsh-scrollbar-thumb:var(--dsw-alias-scrollbar-bg-l2);--dsh-scrollbar-thumb-hover:var(--dsw-alias-scrollbar-hover-l2);border:0;flex:none;margin:0 auto;overflow:hidden}.lXshSW_body{flex-direction:column;gap:8px;padding:6px 12px;display:flex}.lXshSW_header{text-align:left;cursor:pointer;background:0 0;border:none;align-items:center;gap:10px;width:100%;padding:0;display:flex}.lXshSW_lead{color:var(--dsw-alias-label-tertiary);flex:none;place-items:center;display:grid}.lXshSW_title{color:var(--dsw-alias-label-primary);flex:none;font-size:13px;font-weight:500;line-height:24px}.lXshSW_progress{min-width:0;color:var(--dsw-alias-label-tertiary);text-overflow:ellipsis;white-space:nowrap;flex:auto;font-size:13px;font-weight:400;line-height:20px;overflow:hidden}.lXshSW_chevron{color:var(--dsw-alias-label-tertiary);flex:none;place-items:center;display:grid}.lXshSW_list{flex-direction:column;gap:8px;max-height:180px;margin:0;padding:0;list-style:none;display:flex;overflow-y:auto}.lXshSW_item{min-width:0;color:var(--dsw-alias-label-secondary);align-items:center;gap:10px;font-size:13px;line-height:20px;display:flex}.lXshSW_glyph{flex:none;place-items:center;width:16px;height:16px;display:grid}.lXshSW_content{text-overflow:ellipsis;white-space:nowrap;min-width:0;overflow:hidden}";
var tagId = "@kode/dsh-composer/cfbd9fd95b05/TodoPanel.module.css";
if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId) + "]") === null) {
  const tag = document.createElement("style");
  tag.dataset.plugin = "@kode/dsh-composer";
  tag.dataset.pluginCss = tagId;
  tag.textContent = css;
  document.head.appendChild(tag);
}
var Config = Schema.object({ maxConcurrentFileUploads: Schema.natural().min(1).default(2) });
function PortableTextComposer(props) {
  if (!props.scopeKey || typeof props.value !== "string" || !props.ariaLabel)
    throw Error("PortableTextComposer requires scopeKey, string value and ariaLabel");
  return react.createElement(PortableTextComposerInstance, { ...props, key: props.scopeKey });
}
var portableCss = (name) => typeof name === "undefined" ? {} : name;
function PortableTextComposerInstance(props) {
  const latest = react.useRef(props);
  latest.current = props;
  const scrollRef = react.useRef(null), busy = react.useRef(false), alive = react.useRef(true), fileRef = react.useRef(null);
  const [sending, setSending] = react.useState(false), [error, setError] = react.useState(""), [activity, setActivity] = react.useState(false);
  const suppress = react.useRef(false), runtimeRef = react.useRef(null);
  const accepted = react.useRef(props.value), restoring = react.useRef(false), composing = react.useRef(false), revision = react.useRef(0);
  const limit = () => Math.min(65536, Math.max(1, Number.isSafeInteger(latest.current.maxLength) ? latest.current.maxLength : 65536));
  const lengthError = () => latest.current.lengthLimitLabel || `\u5185\u5BB9\u8D85\u8FC7 ${limit()} \u4E2A\u5B57\u7B26\u3002\u672C\u6B21\u8D85\u9650\u8F93\u5165\u672A\u52A0\u5165\u8349\u7A3F\uFF0C\u539F\u8349\u7A3F\u5DF2\u4FDD\u7559\u3002\u8BF7\u7F29\u77ED\u540E\u91CD\u8BD5\u3002`;
  const attachmentItems = () => latest.current.attachments?.items ?? [];
  function syncDraft() {
    const runtime2 = runtimeRef.current;
    runtime2.refreshProjection();
    const text = runtime2.projection.clipboardText;
    if (suppress.current || composing.current || runtime2.editor.isComposing()) return;
    if (text.length > limit()) {
      setError(lengthError());
      if (!restoring.current) {
        restoring.current = true;
        queueMicrotask(() => {
          if (!alive.current) {
            restoring.current = false;
            return;
          }
          suppress.current = true;
          try {
            runtime2.setDraft(accepted.current);
            runtime2.refreshProjection();
            runtime2.clearHistory();
          } finally {
            suppress.current = false;
            restoring.current = false;
          }
        });
      }
    } else {
      if (text !== latest.current.value) {
        revision.current++;
        setError("");
        latest.current.onChange(text);
      }
      accepted.current = text;
    }
  }
  if (!runtimeRef.current) runtimeRef.current = new DraftEditorRuntime({
    onUpdate: syncDraft,
    openReference: () => false,
    lexicon: () => /* @__PURE__ */ new Map(),
    resolveLexicon: () => void 0
  });
  const runtime = runtimeRef.current;
  const editable = () => !latest.current.disabled && !latest.current.readOnly && !latest.current.editingDisabled && !busy.current;
  const hasContent = () => !!latest.current.allowEmpty || !!runtime.projection.clipboardText.trim() || attachmentItems().length > 0;
  const canSubmit = () => !latest.current.sendDisabled && !composing.current && !runtime.editor.isComposing() && !restoring.current && !busy.current && !latest.current.disabled && !latest.current.readOnly && runtime.projection.clipboardText.length <= limit() && hasContent();
  const submit = async () => {
    if (runtime.projection.clipboardText.length > limit()) {
      setError(lengthError());
      return;
    }
    if (!canSubmit()) return;
    busy.current = true;
    setSending(true);
    setError("");
    const request = Object.freeze({
      scopeKey: latest.current.scopeKey,
      text: runtime.projection.clipboardText,
      ...latest.current.attachments ? { attachmentIds: Object.freeze(attachmentItems().map((item) => item.id)) } : {}
    });
    try {
      await latest.current.onSubmit(request);
    } catch (e2) {
      if (alive.current) setError(latest.current.failureLabel || "\u53D1\u9001\u5C1A\u672A\u786E\u8BA4\uFF0C\u8BF7\u91CD\u8BD5\u3002");
    } finally {
      busy.current = false;
      if (alive.current) setSending(false);
    }
  };
  const intakeFiles = (files) => {
    const spec2 = latest.current.attachments, list = Array.from(files ?? []);
    if (spec2 && !list.length) return;
    if (!spec2 || !spec2.canAccept || !editable()) {
      setError(spec2?.unsupportedLabel || latest.current.unsupportedFilesLabel || "\u6B64\u4F1A\u8BDD\u6682\u4E0D\u652F\u6301\u9644\u4EF6\uFF0C\u6587\u4EF6\u672A\u4E0A\u4F20\u3002");
      return;
    }
    setError("");
    spec2.onAdd(list);
  };
  const inputActions = react.useRef(null);
  if (!inputActions.current) inputActions.current = Object.freeze({
    captureInsertion: () => Object.freeze({ scopeKey: latest.current.scopeKey, revision: revision.current, text: runtime.projection.clipboardText }),
    insertText: (text, span) => {
      if (typeof text !== "string" || !text || !alive.current || !editable()) return false;
      if (!span || span.scopeKey !== latest.current.scopeKey || span.revision !== revision.current || span.text !== runtime.projection.clipboardText) return false;
      const next = span.text + (span.text && !/\s$/.test(span.text) ? " " : "") + text;
      if (next.length > limit()) {
        setError(lengthError());
        return false;
      }
      runtime.setDraft(next);
      runtime.refreshProjection();
      syncDraft();
      return runtime.projection.clipboardText === next;
    }
  });
  react.useLayoutEffect(() => {
    alive.current = true;
    const unregister = runtime.register();
    const compositionStart = () => {
      composing.current = true;
    };
    const compositionEnd = () => queueMicrotask(() => {
      if (!alive.current) return;
      composing.current = false;
      syncDraft();
    });
    const unregisterComposition = runtime.editor.registerRootListener((root, previous) => {
      previous?.removeEventListener("compositionstart", compositionStart);
      previous?.removeEventListener("compositionend", compositionEnd);
      root?.addEventListener("compositionstart", compositionStart);
      root?.addEventListener("compositionend", compositionEnd);
    });
    const keys = registerComposerKeymap(runtime.editor, {
      arbitrate: () => "pass",
      dismissPopup() {
      },
      space: () => false,
      canSubmit,
      submit,
      pasteText: (text) => {
        if (editable()) runtime.paste(text);
      },
      intakeFiles
    });
    return () => {
      alive.current = false;
      unregisterComposition();
      keys();
      unregister();
    };
  }, [runtime]);
  react.useLayoutEffect(() => {
    accepted.current = props.value;
    if (props.value.length > limit()) setError(`\u5F53\u524D\u5185\u5BB9\u8D85\u8FC7 ${limit()} \u4E2A\u5B57\u7B26\uFF0C\u5C1A\u672A\u4FDD\u5B58\uFF0C\u4E0D\u80FD\u53D1\u9001\u3002\u8BF7\u7F29\u77ED\u540E\u91CD\u8BD5\u3002`);
    if (props.value !== runtime.projection.clipboardText) {
      revision.current++;
      suppress.current = true;
      try {
        runtime.setDraft(props.value);
        runtime.refreshProjection();
        runtime.clearHistory();
      } finally {
        suppress.current = false;
      }
    }
  }, [props.value, runtime]);
  const disabled = !!props.disabled || !!props.readOnly || sending;
  const css2 = InputBar_module_css_default, rootCss = portableCss(typeof ConversationRoot_module_css_default === "undefined" ? void 0 : ConversationRoot_module_css_default);
  const spec = props.attachments, items = spec?.items ?? [];
  const locked = disabled || !!props.editingDisabled;
  const onActiveChange = react.useRef(null);
  if (!onActiveChange.current) onActiveChange.current = (value) => {
    if (alive.current) setActivity(!!value);
  };
  const card = react.createElement(
    "div",
    {
      className: css2.root,
      "data-portable-composer": props.scopeKey,
      onDropCapture: (e2) => {
        if (e2.dataTransfer?.files.length) {
          e2.preventDefault();
          intakeFiles(e2.dataTransfer.files);
        }
      }
    },
    react.createElement(
      "div",
      { className: css2.card },
      props.accessory ? react.createElement("div", { className: css2.accessory }, props.accessory) : null,
      spec && props.renderAttachments ? props.renderAttachments({
        attachments: items,
        canAcceptDrop: !!spec.canAccept && !locked,
        onAddFiles: intakeFiles,
        onRemoveAttachment: (id) => {
          if (!locked) spec.onRemove(id);
        },
        uploads: spec.uploads ?? {},
        onRetryFile: (id) => {
          if (!locked) spec.onRetry?.(id);
        },
        ...spec.limits ? { dropLimits: spec.limits } : {}
      }) : null,
      react.createElement(DraftEditor, {
        classNames: css2,
        editor: runtime.editor,
        scrollRef,
        editable: !disabled && !props.editingDisabled,
        editorDisabled: disabled || !!props.editingDisabled,
        phase: "idle",
        placeholderText: props.placeholder || "",
        ariaLabel: props.ariaLabel,
        workspaceTrigger: false,
        workspacePickerOpen: false,
        hint: null,
        showPlaceholder: !props.value && !items.length
      }),
      react.createElement(
        "div",
        { className: css2.row },
        react.createElement(
          "div",
          { className: css2.tools, hidden: activity },
          spec ? react.createElement(
            "button",
            {
              type: "button",
              className: css2.add,
              "aria-label": spec.addLabel || "\u6DFB\u52A0\u56FE\u7247",
              title: spec.canAccept ? void 0 : spec.unsupportedLabel,
              "aria-disabled": !spec.canAccept || locked || void 0,
              onClick: () => {
                if (spec.canAccept && !locked) fileRef.current?.click();
                else setError(spec.unsupportedLabel || "\u6B64\u4F1A\u8BDD\u6682\u4E0D\u652F\u6301\u9644\u4EF6\uFF0C\u6587\u4EF6\u672A\u4E0A\u4F20\u3002");
              }
            },
            typeof _deepseek_ai_dsh_client_ui_primitives === "undefined" ? "+" : react.createElement(_deepseek_ai_dsh_client_ui_primitives.IconPlusOutlineMedium, { size: 14 })
          ) : null,
          spec ? react.createElement("input", {
            ref: fileRef,
            type: "file",
            multiple: true,
            hidden: true,
            accept: spec.accept || "image/*",
            onChange: (e2) => {
              const files = e2.target.files;
              intakeFiles(files);
              e2.target.value = "";
            }
          }) : null,
          props.tools || null
        ),
        react.createElement(
          "div",
          { className: activity && css2.trailingActive ? css2.trailing + " " + css2.trailingActive : css2.trailing },
          react.createElement("div", { className: css2.standardControls, hidden: activity }, props.trailing || null),
          props.renderActivity ? react.createElement(
            "div",
            { className: activity ? css2.activityExpanded : css2.activity },
            props.renderActivity({ inputActions: inputActions.current, locked, onActiveChange: onActiveChange.current })
          ) : null,
          react.createElement(
            "button",
            {
              type: "button",
              className: css2.primary,
              "aria-label": props.sendLabel || "\u53D1\u9001",
              disabled: disabled || !!props.sendDisabled || props.value.length > limit() || !props.allowEmpty && !props.value.trim() && !items.length,
              onClick: submit
            },
            react.createElement(
              "svg",
              { viewBox: "0 0 16 16", width: 16, height: 16, "aria-hidden": true },
              react.createElement("path", { d: "M8.3125 0.980183C8.66767 1.0531 8.97902 1.20418 9.2627 1.43233C9.48724 1.61297 9.73029 1.85793 9.97949 2.10714L14.707 6.83468L13.293 8.24874L9 3.95577V15.0417H7V3.95577L2.70703 8.24874L1.29297 6.83468L6.02051 2.10714C6.26971 1.85793 6.51277 1.61297 6.7373 1.43233C6.97662 1.23986 7.28445 1.04402 7.6875 0.980183C7.8973 0.947006 8.1031 0.95516 8.3125 0.980183Z", fill: "currentColor" })
            )
          )
        )
      )
    ),
    error ? react.createElement("div", { role: "alert" }, error) : null
  );
  if (!props.header) return card;
  const chip = typeof WorkspaceChip === "undefined" ? null : WorkspaceChip;
  return react.createElement(
    "div",
    { className: [rootCss.composerStack, rootCss.composerHero].filter(Boolean).join(" "), "data-portable-composer-stack": props.scopeKey },
    react.createElement("div", { className: rootCss.heroWorkspaceRow, "data-portable-composer-header": true }, props.header({ WorkspaceChip: chip })),
    card
  );
}
var portableComposerCapabilities = Object.freeze({ version: 1, text: true, attachments: true, voice: true, header: true, trailing: true, activity: true, allowEmpty: true, sendDisabled: true });
function applyPortableComposer() {
}

return module.exports;}});
