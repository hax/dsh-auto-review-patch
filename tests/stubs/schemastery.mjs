/**
 * Test double for `@deepseek-ai/schemastery` (~3.19.0), limited to the schema
 * builder calls the patched plugin uses to declare its Loader config.
 *
 * The real package validates Loader config, applies schema defaults, bounds
 * numeric fields, and marks volatile fields as live refs. Tests never run the
 * Loader, so this double records the same declared facts (`type`,
 * `meta.default`, `meta.min`, `meta.max`, `meta.volatile`, `dict`) and lets a
 * test assert the production schema wiring without the real package installed.
 */
class Schema {
  constructor(type, meta, dict) {
    this.type = type
    this.meta = meta
    if (dict !== undefined) this.dict = dict
  }

  /** Record one default and keep the schema chainable. */
  default(value) {
    return new Schema(this.type, { ...this.meta, default: value }, this.dict)
  }

  /** Record one lower bound and keep the schema chainable. */
  min(value) {
    return new Schema(this.type, { ...this.meta, min: value }, this.dict)
  }

  /** Record one upper bound and keep the schema chainable. */
  max(value) {
    return new Schema(this.type, { ...this.meta, max: value }, this.dict)
  }

  /** Mark one field volatile and keep the schema chainable. */
  volatile() {
    return new Schema(this.type, { ...this.meta, volatile: true }, this.dict)
  }
}

const z = {
  /** Build one number schema. */
  number() {
    return new Schema('number', {})
  },
  /** Build one object schema from a field map. */
  object(shape) {
    return new Schema('object', {}, shape)
  },
}

export { Schema }
export default z
