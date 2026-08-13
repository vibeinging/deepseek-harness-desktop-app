/**
 * Minimal schema field value object shared by semantic extract/filter tools.
 */
export class ExtractSchemaField {
  /** @param {{ name: string, type: string, description?: string|null }} data */
  constructor({ name, type, description = null }) {
    this.name = name;
    this.type = type;
    this.description = description;
  }

  static from(data) {
    return new ExtractSchemaField(data);
  }
}
