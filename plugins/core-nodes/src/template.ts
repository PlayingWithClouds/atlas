const TAG_PATTERN = /\{\{([^{}]*)\}\}/g;
const PATH_PATTERN = /^[A-Za-z_][\w-]*(\.[\w-]+)*$/;

function lookup(scope: Record<string, unknown>, path: string): string {
  let current: unknown = scope;
  for (const segment of path.split(".")) {
    if (typeof current !== "object" || current === null) {
      return "";
    }
    current = (current as Record<string, unknown>)[segment];
  }
  if (current === undefined || current === null) {
    return "";
  }
  return String(current);
}

function replaceTag(scope: Record<string, unknown>, expression: string): string {
  const path = expression.trim();
  if (!PATH_PATTERN.test(path)) {
    throw new Error(`unsupported template expression "${path}"`);
  }
  return lookup(scope, path);
}

/** Mustache-style `{{path.to.value}}` replacement. Any malformed tag keeps the raw text. */
export function renderTemplate(template: string, scope: Record<string, unknown>): string {
  try {
    const rendered = template.replace(TAG_PATTERN, (_tag, expression: string) => replaceTag(scope, expression));
    if (rendered.includes("{{") || rendered.includes("}}")) {
      throw new Error("unbalanced template tag");
    }
    return rendered;
  } catch (error) {
    return template;
  }
}
