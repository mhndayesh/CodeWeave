export type PolicyName = "minimal" | "function_edit" | "endpoint_edit" | "schema_edit" | "impact"

export function classify(message: string): { policy: PolicyName; query: string } {
  const text = message.trim()
  const query = extractQuery(text)
  if (/\b(schema|migration|migrate|table|column|database|db|sql|prisma|drizzle)\b/i.test(text))
    return { policy: "schema_edit", query }
  if (
    /\b(route|endpoint|api|handler|controller|middleware|request|response)\b/i.test(text) ||
    /(?:GET|POST|PUT|PATCH|DELETE)\s+\/[^\s]+/i.test(text) ||
    /\/[a-z0-9_./:-]+/i.test(text)
  )
    return { policy: "endpoint_edit", query }
  if (/\b(bug|debug|regression|crash|error|failing|failure|impact|trace|why|broken|refactor)\b/i.test(text))
    return { policy: "impact", query }
  if (/\b(function|method|class|interface|type|component|hook)\b/i.test(text))
    return { policy: "function_edit", query }
  if (/^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)?$/.test(text)) return { policy: "minimal", query: text }
  return { policy: "impact", query }
}

export function extractQuery(message: string): string {
  const backtick = /`([^`]+)`/.exec(message)
  if (backtick?.[1]) return backtick[1].trim()
  const quoted = /["']([^"']+)["']/.exec(message)
  if (quoted?.[1]) return quoted[1].trim()
  const route = /(?:GET|POST|PUT|PATCH|DELETE)?\s*(\/[a-z0-9_./:-]+)/i.exec(message)
  if (route?.[1]) return route[1].trim()
  const file = /\b(?:src|app|pages|packages|lib|server|client)\/[^\s,;:]+/i.exec(message)
  if (file?.[0]) return file[0].trim()

  const ignored = new Set(["add", "and", "bug", "change", "debug", "edit", "fix", "for", "the", "this", "with"])
  const symbols = [...message.matchAll(/\b[A-Za-z_$][\w$]{2,}\b/g)]
    .map((match) => match[0])
    .filter((item) => !ignored.has(item.toLowerCase()))
  return symbols.at(-1) ?? message.slice(0, 80).trim()
}
