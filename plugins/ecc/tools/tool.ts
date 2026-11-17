/**
 * Minimal schema shim for ECC's custom OpenCode tools.
 *
 * Upstream ECC builds these tool definitions with Zod and lets the OpenCode 1
 * SDK convert them. OpenCode 2 tool definitions take a plain JSON Schema in
 * `input` instead, and this install ships without `node_modules`, so the Zod
 * dependency (and the `@opencode-ai/plugin` type import) is replaced by this
 * small builder that records only what the tool modules actually use:
 * `string()`, `number()`, `boolean()`, `.optional()`, `.describe()`, `.enum()`.
 *
 * `toInputSchema()` turns the recorded arguments into the JSON Schema that
 * `ctx.tool.transform()` expects in `index.ts`.
 */

type FieldType = "string" | "number" | "boolean"

export interface ToolSchemaField {
  type: FieldType
  description?: string
  enumValues?: readonly string[]
  required: boolean
  optional(): ToolSchemaField
  describe(text: string): ToolSchemaField
  enum(values: readonly string[]): ToolSchemaField
}

function makeField(type: FieldType): ToolSchemaField {
  const field: ToolSchemaField = {
    type,
    description: undefined,
    enumValues: undefined,
    required: true,
    optional() {
      field.required = false
      return field
    },
    describe(text: string) {
      field.description = text
      return field
    },
    enum(values: readonly string[]) {
      field.enumValues = values
      return field
    },
  }
  return field
}

export interface ToolDefinition {
  description: string
  args: Record<string, ToolSchemaField>
  execute(args: any, context: any): Promise<unknown> | unknown
}

export interface ToolInputSchema {
  type: "object"
  properties: Record<string, Record<string, unknown>>
  required?: string[]
  additionalProperties: false
}

/** Convert recorded tool arguments into the JSON Schema OpenCode 2 consumes. */
export function toInputSchema(args: Record<string, ToolSchemaField> | undefined): ToolInputSchema {
  const properties: Record<string, Record<string, unknown>> = {}
  const required: string[] = []

  for (const [name, field] of Object.entries(args ?? {})) {
    const schema: Record<string, unknown> = { type: field.type }
    if (field.description) schema.description = field.description
    if (field.enumValues) schema.enum = [...field.enumValues]
    properties[name] = schema
    if (field.required) required.push(name)
  }

  return {
    type: "object",
    properties,
    ...(required.length > 0 ? { required } : {}),
    additionalProperties: false,
  }
}

/** Drop-in replacement for the OpenCode 1 `tool()` helper. */
export const tool = Object.assign(<T>(definition: T): T => definition, {
  schema: {
    string: () => makeField("string"),
    number: () => makeField("number"),
    boolean: () => makeField("boolean"),
    enum: (values: readonly string[]) => makeField("string").enum(values),
  },
})
