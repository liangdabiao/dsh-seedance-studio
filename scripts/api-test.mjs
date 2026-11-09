// 临时验收脚本：不连宿主，起一个本地 http 服务挂上 registerApi 的 handler，
// 用真实 fetch 打各个接口，检查 catalog / project / history / 静态页面 / 生成任务。
import { createServer } from 'node:http'
import { existsSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = 'D:\\dsh-research\\.tmp\\seedance-api-test'
rmSync(ROOT, { recursive: true, force: true })
mkdirSync(ROOT, { recursive: true })
process.env.DSH_HOME = join(ROOT, 'home')

const { initProject, updateProject } = await import('../lib/project.js')
const { registerApi } = await import('../lib/api.js')
const { readHistory } = await import('../lib/history.js')

const projectDir = join(ROOT, 'projects', '罗刹市奇谭')
const project = initProject({ path: projectDir, title: '罗刹市奇谭', aspect: '9:16', episodes: 2, paletteZh: '朱砂红、墨青、鎏金' })
updateProject(projectDir, {
  assets: [
    { id: 'C01', kind: 'character', name: '书生标准像', ratio: '3:4', prompt: '上美影风格，青衫书生全身正面，宣纸背景' },
    { id: 'S01', kind: 'scene', name: '罗刹夜市', ratio: '16:9', prompt: '上美影风格，夜市灯笼长街' }
  ],
  episodes: project.episodes.map((e, i) => ({ ...e, refs: ['C01', 'S01'], prompt: `0-3秒：第${i + 1}集开场，${i} 号镜头` }))
})

// 造两条历史：一条成功出图、一条失败出片
const { recordGeneration } = await import('../lib/history.js')
recordGeneration({
  kind: 'asset', project: projectDir, projectTitle: '罗刹市奇谭', status: 'ok',
  summary: '已出图 2 张（6 积分）', credits: 6, model: 'seedream_4.5', resolution: '2K',
  items: [
    { id: 'C01', name: '书生标准像', status: 'ok', file: 'assets/C01.png', credits: 3 },
    { id: 'S01', name: '罗刹夜市', status: 'ok', file: 'assets/S01.png', credits: 3 }
  ]
})
recordGeneration({
  kind: 'episode', project: projectDir, projectTitle: '罗刹市奇谭', status: 'failed',
  summary: 'E01 出片失败', error: '积分上限 100，报价 135', model: 'seedance_2.5_draft', resolution: '480p', duration: 15,
  items: [{ id: 'E01', status: 'failed', error: '积分上限 100，报价 135' }]
})

let handler = null
const ctx = { webServer: { register(cfg) { handler = cfg.handler; return () => {} } } }
registerApi(ctx)
if (!handler) throw new Error('registerApi 没注册 handler')

const server = createServer((req, res) => handler(req, res))
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const base = `http://127.0.0.1:${server.address().port}`

async function get(path) {
  const res = await fetch(base + path)
  const text = await res.text()
  return { status: res.status, type: res.headers.get('content-type'), text }
}

const checks = []
function check(name, ok, detail = '') {
  checks.push({ name, ok, detail })
  console.log(`${ok ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`)
}

try {
  const ping = await get('/seedance-studio/api/ping')
  check('ping', ping.status === 200 && JSON.parse(ping.text).version === '0.3.0', ping.text)

  const catalog = JSON.parse((await get('/seedance-studio/api/catalog')).text)
  check('catalog: 项目已列出', catalog.ok && catalog.projects.length === 1, `projects=${catalog.projects.length} title=${catalog.projects[0]?.title}`)
  check('catalog: 历史 2 条', catalog.history.length === 2, `total=${catalog.stats.history.total} credits=${catalog.stats.history.credits}`)
  check('catalog: 统计正确', catalog.stats.projects.doneAssets === 0 && catalog.stats.projects.count === 1, JSON.stringify(catalog.stats.projects))
  check('catalog: 封面可算', catalog.projects[0].cover === null && catalog.projects[0].assets === 2, `assets=${catalog.projects[0].assets}`)

  const detail = JSON.parse((await get(`/seedance-studio/api/project?path=${encodeURIComponent(projectDir)}`)).text)
  check('project: 元信息', detail.meta.title === '罗刹市奇谭' && detail.meta.style.paletteZh.includes('朱砂'), detail.meta.style.paletteZh)
  check('project: 资产摘要', detail.files.assets.length === 2 && detail.files.assets[0].promptChars > 0, `promptChars=${detail.files.assets[0].promptChars}`)
  check('project: 历史按项目过滤', detail.history.length === 2 && detail.stats.credits === 6, `history=${detail.history.length}`)

  const hist = JSON.parse((await get('/seedance-studio/api/history?kind=episode&status=failed')).text)
  check('history: 过滤 kind+status', hist.list.length === 1 && hist.list[0].kind === 'episode', hist.list[0]?.summary)

  const jobs = JSON.parse((await get('/seedance-studio/api/jobs')).text)
  check('jobs: 空列表 ok', jobs.ok && jobs.list.length === 0)

  const page = await get('/seedance-studio/')
  check('静态页面: index.html', page.status === 200 && page.text.includes('短剧工坊'), `${page.status} ${page.type}`)
  const css = await get('/seedance-studio/app.css')
  check('静态页面: app.css', css.status === 200 && css.type.includes('css'), css.type)
  const js = await get('/seedance-studio/app.js')
  check('静态页面: app.js', js.status === 200 && js.text.includes('renderHistory'), js.type)
  const traversal = await get('/seedance-studio/..%2f..%2fpackage.json')
  check('静态页面: 越界被拒', traversal.status === 404, String(traversal.status))

  // 生成接口：/api/generate 在没登录/没提示词时会走工具并失败 —— 这里只验证参数校验分支
  const bad = await fetch(base + '/seedance-studio/api/generate', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ kind: 'nope', project: projectDir }) })
  check('generate: 非法 kind 拒绝', bad.status === 400, await bad.text())
  const missing = await fetch(base + '/seedance-studio/api/generate', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ kind: 'asset', project: join(ROOT, '不存在') }) })
  check('generate: 不存在的目录拒绝', missing.status === 400, await missing.text())

  // 清空历史
  const cleared = await fetch(base + '/seedance-studio/api/history/clear', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({}) })
  const clearedBody = JSON.parse(await cleared.text())
  check('history/clear', clearedBody.removed === 2 && readHistory().length === 0, JSON.stringify(clearedBody))
} finally {
  server.close()
}

const failed = checks.filter((c) => !c.ok)
console.log(`\n${checks.length - failed.length}/${checks.length} 通过`)
if (failed.length) process.exit(1)
