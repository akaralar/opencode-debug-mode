import { readFileSync, writeFileSync } from "node:fs"

const source = new URL("../src/prompt.md", import.meta.url)
const target = new URL("../src/prompt.ts", import.meta.url)

const markdown = readFileSync(source, "utf8")
writeFileSync(target, `// Generated from prompt.md\nexport const AGENT_PROMPT = ${JSON.stringify(markdown)}\n`)
console.log(`generated src/prompt.ts from prompt.md (${markdown.length} chars)`)
