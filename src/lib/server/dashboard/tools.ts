import { isRecord } from "../../guards";
import { PERMISSIONS, type Permission } from "../permissions/permissions";
import type { Viewer } from "./access";
import type { DashboardDeps } from "./deps";
import { PERMISSION_LABELS } from "./format";

interface ToolParameterView {
  name: string;
  /** Read off the JSON Schema, e.g. `string`, `"newest" | "oldest"`, `string[]`. */
  type: string;
  required: boolean;
  /** As the AI reads it (English). */
  description: string | null;
  /** JSON of the default value. */
  defaultValue: string | null;
}

interface ToolView {
  /** Also the element id the stats and history pages link to. */
  name: string;
  title: string;
  /** As the AI reads it (English). */
  description: string;
  parameters: ToolParameterView[];
  /** The input schema exactly as tools/list sends it, pretty-printed. */
  schema: string;
}

interface ToolGroupView {
  permission: Permission;
  label: string;
  /** False when the viewer lacks the permission, so their MCP clients do not get these tools. */
  available: boolean;
  tools: ToolView[];
}

export interface ToolsPageData {
  groups: ToolGroupView[];
}

/** A short type for one property of a tool's input schema. */
function typeLabel(schema: unknown): string {
  if (!isRecord(schema)) return "any";
  if (Array.isArray(schema.enum)) return schema.enum.map((value) => JSON.stringify(value)).join(" | ");
  if (Array.isArray(schema.anyOf)) return schema.anyOf.map(typeLabel).join(" | ");
  if (schema.type === "array") {
    const items = typeLabel(schema.items);
    return items.includes(" | ") ? `(${items})[]` : `${items}[]`;
  }
  if (typeof schema.type === "string") return schema.type;
  if (Array.isArray(schema.type)) return schema.type.join(" | ");
  return "any";
}

function parameters(inputSchema: Record<string, unknown>): ToolParameterView[] {
  const properties = isRecord(inputSchema.properties) ? inputSchema.properties : {};
  const required = new Set(Array.isArray(inputSchema.required) ? inputSchema.required : []);
  return Object.entries(properties).map(([name, schema]) => ({
    name,
    type: typeLabel(schema),
    required: required.has(name),
    description: isRecord(schema) && typeof schema.description === "string" ? schema.description : null,
    defaultValue: isRecord(schema) && "default" in schema ? JSON.stringify(schema.default) : null,
  }));
}

/** Every tool the server offers, grouped by the permission that exposes it. */
export function toolsPage(deps: Pick<DashboardDeps, "tools">, viewer: Pick<Viewer, "permissions">): ToolsPageData {
  const groups = PERMISSIONS.map((permission) => ({
    permission,
    label: PERMISSION_LABELS[permission],
    available: viewer.permissions.includes(permission),
    tools: deps.tools
      .filter((tool) => tool.permission === permission)
      .map((tool) => ({
        name: tool.name,
        title: tool.title,
        description: tool.description,
        parameters: parameters(tool.inputSchema),
        schema: JSON.stringify(tool.inputSchema, null, 2),
      })),
  }));
  return { groups: groups.filter((group) => group.tools.length > 0) };
}
