/**
 * Ad-hoc check of the extractor against real documents on this machine.
 *
 * Not part of the check chain — it depends on files that only exist locally, so
 * it lives here as a probe to run by hand during development.
 */

import { readFile } from 'node:fs/promises'
import { extractText, looksBinary } from '../dist/core/extract.js'

const samples = [
  'D:/explorer/咸阳师范学院系统操作及写作规范培训（20260914）.pdf',
  'D:/explorer/NeatDM/黄翊轩简历.pdf',
  'D:/explorer/NeatDM/utils/apache-jmeter-5.2.1/printable_docs/usermanual/include_controller_tutorial.pdf',
  'D:/explorer/NeatDM/deepseek-harness-master/deepseek-harness-master/packages/bundle/web-app/tests/fixtures/document-conversion.docx',
  'D:/desktop1/ollama harness/package.json',
  'D:/desktop1/ollama harness/README.md',
]

for (const path of samples) {
  let buffer
  try {
    buffer = await readFile(path)
  } catch (error) {
    console.log(`\n=== ${path}\n  unreadable: ${error.message}`)
    continue
  }
  const bytes = new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength)
  const result = extractText(path, bytes)
  const { text } = result
  console.log(`\n=== ${path}`)
  console.log(`  kind=${result.kind} chars=${text.length} truncated=${result.truncated} binary=${looksBinary(bytes)}`)
  if (result.error) console.log(`  ERROR: ${result.error}`)
  if (result.notes) for (const note of result.notes) console.log(`  note: ${note}`)
  const preview = text.slice(0, 420).replace(/\n/g, '\n  ')
  console.log(`  --- first 420 chars ---\n  ${preview}`)
}
