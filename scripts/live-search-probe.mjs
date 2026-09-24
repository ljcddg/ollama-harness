/** Live probe for the search tool against a real Ollama + bge-m3. Not part of the gates. */
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { OllamaAdapter } from '../dist/core/llm/ollama-adapter.js'
import { createSearchTool } from '../dist/core/tools/search.js'

const adapter = new OllamaAdapter({ baseUrl: 'http://127.0.0.1:11434' })
const models = await adapter.listModels()
console.log('models:', models.map((m) => `${m.name}(chat=${m.chat},embedding=${m.embedding})`).join(' '))

const tool = createSearchTool({
  listModels: (signal) => adapter.listModels(signal),
  embed: (model, input, signal) => adapter.embed(model, input, signal),
})

const root = await mkdtemp(join(tmpdir(), 'harness-live-search-'))
try {
  await writeFile(
    join(root, 'RecipeService.java'),
    'public class RecipeService {\n' +
      '  /** 根据食材生成做菜流程：校验输入、组合步骤、优化顺序 */\n' +
      '  public Flow generateRecipeFlow(String ingredients) {\n' +
      '    validate(ingredients);\n' +
      '    return compose(ingredients);\n' +
      '  }\n' +
      '}\n',
  )
  await writeFile(
    join(root, 'UserController.java'),
    'public class UserController {\n' +
      '  public User login(String name, String password) {\n' +
      '    return userDao.findByName(name);\n' +
      '  }\n' +
      '}\n',
  )
  await writeFile(
    join(root, 'travel-notes.md'),
    '# Kyoto trip\n\nBest season: late November for the maples. Book temples early.\n',
  )

  for (const query of ['做菜流程是怎么实现的', '用户怎么登录']) {
    const start = Date.now()
    const r = await tool.execute(
      { query, path: root },
      { cwd: root, signal: new AbortController().signal, callId: 'live', requestApproval: async () => true },
    )
    console.log(`\n=== query: ${query} (${Date.now() - start}ms, isError=${r.isError ?? false}) ===`)
    console.log(r.content)
  }
} finally {
  await rm(root, { recursive: true, force: true })
}
