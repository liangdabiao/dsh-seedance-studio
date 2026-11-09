// 插件的 HTTP 半边：给侧栏「短剧工坊」工作台页面用（/seedance-studio/ 下）。
//   GET  /                      工作台页面（lab/ 静态资源，对齐「投资尽调」的布局）
//   GET  /api/catalog           项目列表 + 生成历史 + 根目录 + 统计
//   GET  /api/project?path=     单个项目：元信息 + 资产/分集摘要 + 这个项目的生成历史
//   GET  /api/history?...       生成历史（可按项目/类型/状态/关键词过滤）
//   POST /api/history/remove    删一条历史；POST /api/history/clear 清空（可按项目）
//   POST /api/roots             增删扫描根目录 / 记住上次目录
//   POST /api/generate          出图/出片/拼接（走工具那条代码路径，积分与路径校验完全一致）
//   GET  /api/jobs|/api/job     正在跑的任务
//   GET  /media?path=           项目里的图片/视频（只允许项目目录内的文件）
//   GET  /api/health | /health   即梦 CLI / 登录 / ffmpeg（缓存 20 秒；旧的 /health 路径保留兼容）
import { createReadStream, existsSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { dirname, extname, isAbsolute, join, normalize, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { authAccount, authStatus, resolveCli } from './dreamina.js'
import { resolveFfmpeg } from './ffmpeg.js'
import { fileSummary, listProjects, projectSummary, readProject, resolveDir } from './project.js'
import {
  DATA_DIR, KIND_LABEL, clearHistory, filterHistory, readHistory, readSettings,
  normalizePath, removeRecord, scanRoots, summarize, writeSettings
} from './history.js'
import { TOOLS } from './tools.js'

const BASE = '/seedance-studio'
const LAB = fileURLToPath(new URL('../lab/', import.meta.url))
const TOOL = Object.fromEntries(TOOLS.map((t) => [t.name, t]))

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.md': 'text/markdown; charset=utf-8'
}

function json(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify(body))
}

function version() {
  try { return JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version } catch { return null }
}

// ---------------------------------------------------------------- 静态页面

// 只放行 lab/ 里的文件：拒绝 ..、点开头的路径和指到目录外的符号链接
function safeLabFile(rel) {
  if (!rel || String(rel).split('/').some((p) => p.startsWith('.'))) return null
  let base
  try { base = realpathSync(LAB) } catch { return null }
  const file = normalize(join(base, rel))
  if (!file.startsWith(base + sep) || !existsSync(file)) return null
  const real = realpathSync(file)
  return real.startsWith(base + sep) && statSync(real).isFile() ? real : null
}

function serve(req, res, file) {
  const type = MIME[extname(file).toLowerCase()] || 'application/octet-stream'
  res.writeHead(200, { 'content-type': type, 'content-length': statSync(file).size, 'cache-control': 'no-cache' })
  if (req.method === 'HEAD') return res.end()
  createReadStream(file).pipe(res)
}

// 文件只允许从「有 project.json 的目录」里读，且必须在这个目录内。
function projectRootOf(file) {
  let dir = dirname(file)
  for (let i = 0; i < 12; i += 1) {
    if (existsSync(join(dir, 'project.json'))) return realpathSync(dir)
    const parent = dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
  return null
}

// 只接受同源页面发来的 JSON
function readJson(req, max = 64 * 1024) {
  return new Promise((resolve, reject) => {
    const origin = req.headers.origin
    if (req.method !== 'POST') return reject(Object.assign(new Error('method'), { status: 405 }))
    if (!/^application\/json\b/.test(req.headers['content-type'] || '')) return reject(Object.assign(new Error('需要 JSON'), { status: 415 }))
    if (origin && origin.replace(/^https?:\/\//, '') !== req.headers.host) return reject(Object.assign(new Error('origin'), { status: 403 }))
    let size = 0
    const chunks = []
    req.on('data', (c) => { size += c.length; if (size > max) req.destroy(); else chunks.push(c) })
    req.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')) } catch (e) { reject(Object.assign(e, { status: 400 })) } })
    req.on('error', reject)
  })
}

// ---------------------------------------------------------------- 健康状态（缓存）

let healthCache = { at: 0, value: null }
let healthPending = null
const HEALTH_TTL = 20_000

async function readHealth() {
  if (healthCache.value && Date.now() - healthCache.at < HEALTH_TTL) return healthCache.value
  if (healthPending) return healthPending
  healthPending = (async () => {
    const [cli, auth, ffmpeg] = await Promise.all([
      resolveCli().then((x) => ({ bin: x.bin, version: x.version })).catch((err) => ({ error: err.message })),
      authStatus().then(async (status) => {
        if (!status.loggedIn) return { loggedIn: false }
        const account = await authAccount().catch(() => null)
        return {
          loggedIn: true,
          displayName: account && account.displayName,
          credits: account && account.availableCredits,
          vip: account && account.isVip,
          vipLevel: account && account.vipLevel
        }
      }).catch((err) => ({ error: err.message })),
      resolveFfmpeg().then((x) => x).catch((err) => ({ error: err.message }))
    ])
    const value = { version: version(), cli, auth, ffmpeg }
    healthCache = { at: Date.now(), value }
    healthPending = null
    return value
  })().catch((err) => {
    healthPending = null
    throw err
  })
  return healthPending
}

// ---------------------------------------------------------------- 项目

// 扫描所有根目录；再补上「历史里生成过、但不在扫描目录里」的项目，
// 否则换个盘做的片子会从页面上消失。
function collectProjects() {
  const roots = scanRoots()
  const seen = new Map()
  const projects = []
  for (const root of roots) {
    if (!existsSync(root)) continue
    let list = []
    try { list = listProjects(root) } catch { list = [] }
    for (const p of list) {
      seen.set(normalizePath(p.path), true)
      projects.push(p)
    }
  }
  for (const record of readHistory()) {
    const key = normalizePath(record.project)
    if (!key || seen.has(key)) continue
    seen.set(key, true)
    try {
      if (existsSync(join(record.project, 'project.json'))) projects.push(projectSummary(record.project))
    } catch { /* 项目被删了就算了 */ }
  }
  return projects.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))
}

function projectStats(projects) {
  return {
    count: projects.length,
    assets: projects.reduce((n, p) => n + p.assets, 0),
    doneAssets: projects.reduce((n, p) => n + p.doneAssets, 0),
    episodes: projects.reduce((n, p) => n + p.episodes, 0),
    doneEpisodes: projects.reduce((n, p) => n + p.doneEpisodes, 0),
    finals: projects.filter((p) => p.hasFinal).length,
    credits: projects.reduce((n, p) => n + p.credits, 0)
  }
}

function catalog() {
  const projects = collectProjects()
  const history = readHistory()
  const settings = readSettings()
  return {
    version: version(),
    platform: process.platform,
    dataDir: DATA_DIR,
    roots: settings.roots,
    lastRoot: settings.lastRoot,
    defaultRoot: process.cwd(),
    projects,
    history: history.slice(0, 60),
    stats: { history: summarize(history), projects: projectStats(projects) },
    kinds: KIND_LABEL,
    health: healthCache.value
  }
}

// ---------------------------------------------------------------- 生成任务
// 生成任务放内存：页面轮询 /api/job 拿进度。工具本身是同步等待的，这里只是包一层。
const jobs = new Map()
let seq = 0

function startJob(kind, args) {
  const id = `job-${Date.now().toString(36)}-${++seq}`
  const job = {
    id,
    kind,
    kindLabel: KIND_LABEL[kind] || kind,
    status: 'running',
    startedAt: new Date().toISOString(),
    args: { ...args }
  }
  jobs.set(id, job)
  if (jobs.size > 40) jobs.delete(jobs.keys().next().value)
  const tool = kind === 'asset' ? TOOL.jimeng_asset : kind === 'episode' ? TOOL.jimeng_episode : TOOL.seedance_assemble
  Promise.resolve()
    .then(() => tool.execute(args))
    .then((r) => {
      job.status = r.ok ? 'done' : 'failed'
      job.summary = r.summary
      job.data = r.data || ''
    })
    .catch((err) => {
      job.status = 'failed'
      job.error = String((err && err.message) || err)
    })
    .finally(() => { job.finishedAt = new Date().toISOString() })
  return job
}

export function registerApi(ctx) {
  return ctx.webServer.register({
    kind: 'prefix',
    path: BASE,
    async handler(req, res) {
      try {
        const rejection = requestRejection(ctx, req)
        if (typeof rejection === 'number') return json(res, rejection, { ok: false, error: '未授权' })

        const url = new URL(req.url || '/', 'http://x')
        const rest = decodeURIComponent(url.pathname.slice(BASE.length)) || '/'

        if (rest === '/api/ping') return json(res, 200, { ok: true, version: version() })

        // 老面板（0.2.x）用的是 /health，留着免得刷新前页面报「未登录」
        if (rest === '/api/health' || rest === '/health') {
          try { return json(res, 200, { ok: true, ...(await readHealth()) }) } catch (err) { return json(res, 200, { ok: true, version: version(), error: String(err.message) }) }
        }

        if (rest === '/api/catalog' && req.method === 'GET') {
          return json(res, 200, { ok: true, ...catalog() })
        }

        if (rest === '/api/history' && req.method === 'GET') {
          const all = readHistory()
          const list = filterHistory(all, {
            project: url.searchParams.get('project') || undefined,
            kind: url.searchParams.get('kind') || 'all',
            status: url.searchParams.get('status') || 'all',
            q: url.searchParams.get('q') || '',
            limit: url.searchParams.get('limit') || 60
          })
          return json(res, 200, { ok: true, list, stats: summarize(all), total: all.length })
        }

        if (rest === '/api/history/remove' && req.method === 'POST') {
          const body = await readJson(req).catch((err) => err)
          if (body instanceof Error) return json(res, body.status || 400, { ok: false, error: body.message })
          const removed = removeRecord(String(body.id || ''))
          return json(res, removed ? 200 : 404, { ok: removed, error: removed ? undefined : '没有这条记录' })
        }

        if (rest === '/api/history/clear' && req.method === 'POST') {
          const body = await readJson(req).catch((err) => err)
          if (body instanceof Error) return json(res, body.status || 400, { ok: false, error: body.message })
          const project = typeof body.project === 'string' && body.project ? body.project : undefined
          const removed = clearHistory({ project })
          return json(res, 200, { ok: true, removed })
        }

        if (rest === '/api/roots' && req.method === 'POST') {
          const body = await readJson(req).catch((err) => err)
          if (body instanceof Error) return json(res, body.status || 400, { ok: false, error: body.message })
          const current = readSettings()
          let roots = current.roots.slice()
          if (Array.isArray(body.roots)) roots = body.roots.map(String)
          if (typeof body.add === 'string' && body.add.trim()) roots.push(body.add.trim())
          if (typeof body.remove === 'string' && body.remove.trim()) {
            const drop = normalizePath(body.remove)
            roots = roots.filter((r) => normalizePath(r) !== drop)
          }
          const patch = { roots }
          if (typeof body.lastRoot === 'string' && body.lastRoot.trim()) patch.lastRoot = body.lastRoot.trim()
          return json(res, 200, { ok: true, ...writeSettings(patch) })
        }

        if (rest === '/api/jobs' && req.method === 'GET') {
          const project = url.searchParams.get('project')
          const target = project ? normalizePath(project) : ''
          const list = [...jobs.values()]
            .filter((j) => !target || normalizePath(j.args.project) === target)
            .map((j) => ({
              id: j.id, kind: j.kind, kindLabel: j.kindLabel, status: j.status, startedAt: j.startedAt,
              finishedAt: j.finishedAt || null, summary: j.summary || '', error: j.error || '', project: j.args.project
            }))
            .sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)))
            .slice(0, 20)
          return json(res, 200, { ok: true, list })
        }

        if (rest === '/api/job') {
          const id = url.searchParams.get('id')
          const job = id && jobs.get(id)
          return job ? json(res, 200, { ok: true, job }) : json(res, 404, { ok: false, error: '没有这个任务' })
        }

        if (rest === '/api/generate' && req.method === 'POST') {
          let body
          try { body = await readJson(req) } catch (err) { return json(res, err.status || 400, { ok: false, error: err.message }) }
          const kind = body.kind === 'episode' ? 'episode' : body.kind === 'asset' ? 'asset' : body.kind === 'assemble' ? 'assemble' : null
          if (!kind) return json(res, 400, { ok: false, error: 'kind 只能是 asset、episode 或 assemble' })
          let dir
          try { dir = resolveDir(String(body.project || '')) } catch (err) { return json(res, 400, { ok: false, error: err.message }) }
          if (!existsSync(join(dir, 'project.json'))) return json(res, 400, { ok: false, error: '这个目录没有 project.json' })
          if (kind === 'asset') {
            const ids = Array.isArray(body.ids) ? body.ids.map(String) : undefined
            const job = startJob('asset', { action: 'generate', project: dir, ids, maxCredits: Number(body.maxCredits) || 10 })
            return json(res, 200, { ok: true, job: job.id })
          }
          if (kind === 'assemble') {
            const job = startJob('assemble', { project: dir, out: body.out ? String(body.out) : undefined })
            return json(res, 200, { ok: true, job: job.id })
          }
          const job = startJob('episode', {
            action: 'generate',
            project: dir,
            episode: body.episode ? String(body.episode) : undefined,
            maxCredits: Number(body.maxCredits) || 100
          })
          return json(res, 200, { ok: true, job: job.id })
        }

        if (req.method !== 'GET' && req.method !== 'HEAD') return json(res, 405, { ok: false, error: '只读接口' })

        if (rest === '/api/projects') {
          const dir = url.searchParams.get('dir')
          if (!dir || !isAbsolute(dir)) return json(res, 400, { ok: false, error: 'dir 必须是绝对路径' })
          if (!existsSync(dir)) return json(res, 400, { ok: false, error: `目录不存在：${dir}` })
          return json(res, 200, { ok: true, projects: listProjects(resolveDir(dir)) })
        }

        if (rest === '/api/project') {
          const path = url.searchParams.get('path')
          if (!path || !isAbsolute(path)) return json(res, 400, { ok: false, error: 'path 必须是绝对路径' })
          const dir = resolveDir(path)
          const project = readProject(dir)
          const history = filterHistory(readHistory(), { project: dir, limit: 40 })
          const stats = summarize(filterHistory(readHistory(), { project: dir, limit: 1000 }))
          return json(res, 200, {
            ok: true,
            path: dir,
            summary: projectSummary(dir),
            meta: {
              title: project.title,
              createdAt: project.createdAt || null,
              updatedAt: project.updatedAt || null,
              style: {
                preset: project.style.preset || '',
                paletteZh: (project.style.palette || {}).zh || '',
                paletteEn: (project.style.palette || {}).en || ''
              },
              video: { aspect: project.video.aspect, episodeSeconds: project.video.episodeSeconds, model: project.video.model, region: project.video.region },
              image: { model: project.image.model, resolution: project.image.resolution },
              canvas: project.canvas ? { id: project.canvas.id, url: project.canvas.url } : null
            },
            project,
            files: fileSummary(dir, project),
            history,
            stats
          })
        }

        if (rest === '/media') {
          const target = url.searchParams.get('path')
          if (!target || !isAbsolute(target) || !existsSync(target)) return json(res, 404, { ok: false, error: 'not found' })
          const file = realpathSync(target)
          const root = projectRootOf(file)
          if (!root || !(file === root || file.startsWith(root + sep))) return json(res, 403, { ok: false, error: 'forbidden' })
          if (!statSync(file).isFile()) return json(res, 404, { ok: false, error: 'not found' })
          return serve(req, res, file)
        }

        if (rest.startsWith('/api/')) return json(res, 404, { ok: false, error: 'not found' })

        // 静态页面：/ → index.html
        const rel = rest === '/' ? 'index.html' : rest.replace(/^\/+/, '')
        const file = safeLabFile(rel)
        return file ? serve(req, res, file) : json(res, 404, { ok: false, error: 'not found' })
      } catch (err) {
        return json(res, 500, { ok: false, error: String((err && err.message) || err) })
      }
    }
  })
}

// dsh 0.2.x 宿主自带 token 鉴权；connection 服务缺席时放行（和 stock-research 一致）。
function requestRejection(ctx, req) {
  const connection = typeof ctx.get === 'function' ? ctx.get('connection') : null
  if (typeof connection?.requestRejection !== 'function') return false
  return connection.requestRejection({ headers: req.headers })
}
