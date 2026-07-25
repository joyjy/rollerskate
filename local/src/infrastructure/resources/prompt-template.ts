import { readFileSync } from "node:fs";

const frontmatterBoundary = "---";

export function loadPromptTemplate(
  resourceUrl: URL,
  resourceId: string
): string {
  const source = readFileSync(resourceUrl, "utf8");
  const lines = source.replaceAll("\r\n", "\n").split("\n");
  if (lines[0] !== frontmatterBoundary) {
    throw new Error(`Prompt resource ${resourceId} must start with YAML frontmatter`);
  }
  const closing = lines.indexOf(frontmatterBoundary, 1);
  if (closing === -1) {
    throw new Error(`Prompt resource ${resourceId} YAML frontmatter is not closed`);
  }
  const declaredResource = lines.slice(1, closing)
    .find((line) => line.startsWith("resource:"))
    ?.slice("resource:".length).trim();
  if (declaredResource !== resourceId) {
    throw new Error(`Prompt resource frontmatter must declare resource: ${resourceId}`);
  }
  const body = lines.slice(closing + 1).join("\n").trimStart();
  if (body.trim() === "") {
    throw new Error(`Prompt resource ${resourceId} body must not be empty`);
  }
  return body;
}
