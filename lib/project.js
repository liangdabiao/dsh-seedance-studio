// project.json：一部片子一份状态。工具和（将来的）页面都只读写这一份，
// 所以换会话、重启、隔天接着做都能恢复。
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync, rmSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, normalize, relative, resolve, sep } from 'node:path'

export class ProjectError extends Error {}

export const ASPECTS = ['9:16', '16:9', '21:9', '1:1', '3:4', '4:3']

const FILE = 'project.json'

export function projectFile(dir) {
  return join(dir, FILE)
}

export function isProjectDir(dir) {
  return existsSync(join(dir, FILE))
}

export function nowIso() {
  return new Date().toISOString()
}

// 所有来自模型的路径都必须是绝对路径，并且只能落在项目目录里。
export function resolveDir(input, { mustExist = true } = {}) {
  if (typeof input !== 'string' || !input.trim()) throw new ProjectError('path 必须是项目目录的绝对路径')
  if (!isAbsolute(input)) throw new ProjectError(`path 要用绝对路径：${input}`)
  const dir = resolve(input)
  if (dirname(dir) === dir) throw new ProjectError('path 不能是盘符根目录')
  if (mustExist && !existsSync(dir)) throw new ProjectError(`目录不存在：${dir}`)
  return dir
}

export function assertInside(root, target) {
  const r = resolve(root)
  const t = resolve(target)
  if (t !== r && !t.startsWith(r + sep)) throw new ProjectError(`路径越界：${target} 不在 ${root} 里`)
  return t
}

export function writeJsonAtomic(file, value) {
  const tmp = `${file}.${process.pid}.tmp`
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  try {
    renameSync(tmp, file)
  } catch (err) {
    try { rmSync(tmp, { force: true }) } catch {}
    throw err
  }
}

function defaults(project) {
  const p = project || {}
  p.version = p.version || 1
  p.title = p.title || ''
  p.style = p.style || {}
  p.style.preset = p.style.preset || 'smy-handdrawn'
  p.style.palette = p.style.palette || { zh: '', en: '' }
  p.style.styleBlock = p.style.styleBlock || ''
  p.video = p.video || {}
  p.video.aspect = p.video.aspect || '9:16'
  p.video.episodeSeconds = Number(p.video.episodeSeconds) || 15
  p.video.model = p.video.model || 'seedance_2.0_mini'
  p.video.region = p.video.region || 'cn'
  p.image = p.image || {}
  p.image.model = p.image.model || 'seedream_4.5'
  p.image.resolution = p.image.resolution || '2K'
  p.canvas = p.canvas || null
  p.episodes = Array.isArray(p.episodes) ? p.episodes : []
  p.assets = Array.isArray(p.assets) ? p.assets : []
  return p
}

export function readProject(dir) {
  const file = projectFile(dir)
  if (!existsSync(file)) throw new ProjectError(`这里没有 project.json：${dir}。先用 seedance_studio action=init 建项目`)
  let raw
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'))
  } catch (err) {
    throw new ProjectError(`project.json 解析失败：${err.message}`)
  }
  return defaults(raw)
}

export function saveProject(dir, project) {
  project.updatedAt = nowIso()
  writeJsonAtomic(projectFile(dir), project)
  return project
}

export function initProject({ path, title, aspect, episodes, paletteZh, paletteEn, stylePreset, episodeSeconds, model, imageModel }) {
  const dir = resolveDir(path, { mustExist: false })
  if (isProjectDir(dir)) throw new ProjectError(`已经有项目了：${dir}（要改内容用 action=update）`)
  const count = Math.max(1, Math.min(50, Number(episodes) || 5))
  mkdirSync(dir, { recursive: true })
  for (const sub of ['assets', 'videos', 'out']) mkdirSync(join(dir, sub), { recursive: true })
  const project = defaults({
    title: title || basename(dir),
    createdAt: nowIso(),
    style: { preset: stylePreset || 'smy-handdrawn', palette: { zh: paletteZh || '', en: paletteEn || '' } },
    video: { aspect: ASPECTS.includes(aspect) ? aspect : '9:16', episodeSeconds: Number(episodeSeconds) || 15, model: model || 'seedance_2.0_mini' },
    image: { model: imageModel || 'seedream_4.5' },
    episodes: Array.from({ length: count }, (_, i) => ({
      id: `E${String(i + 1).padStart(2, '0')}`,
      title: '',
      storyboard: `E${String(i + 1).padStart(2, '0')}_分镜.md`,
      prompt: '',
      refs: [],
      endingFrame: '',
      video: { status: 'idle', taskId: null, file: null, error: null }
    })),
    assets: []
  })
  return saveProject(dir, project)
}

// patch 只做一层合并（数组整体替换），避免模型写半截对象把已有字段抹掉。
export function updateProject(dir, patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new ProjectError('patch 必须是一个 JSON 对象')
  const current = readProject(dir)
  const next = { ...current }
  for (const [k, v] of Object.entries(patch)) {
    if (k === 'assets' || k === 'episodes') {
      if (!Array.isArray(v)) throw new ProjectError(`${k} 必须是数组`)
      next[k] = v.map((item) => ({ ...item }))
    } else if (v && typeof v === 'object' && !Array.isArray(v) && current[k] && typeof current[k] === 'object' && !Array.isArray(current[k])) {
      next[k] = { ...current[k], ...v }
    } else {
      next[k] = v
    }
  }
  return saveProject(dir, defaults(next))
}

// 页面卡片要的摘要（一个项目一行）。listProjects 和历史里额外出现的项目都走这里，
// 保证两边字段完全一致。
export function projectSummary(dir) {
  const project = readProject(dir)
  const doneEpisodes = project.episodes.filter((e) => e.video && e.video.file).length
  const credits = [...project.assets, ...project.episodes.map((e) => e.video || {})]
    .reduce((sum, item) => sum + (Number(item && item.credits) || 0), 0)
  const finalPath = join(dir, 'out', 'final.mp4')
  const cover = (() => {
    const hit = project.assets.find((a) => a.status === 'done' && a.file)
    return hit ? relativeFile(dir, hit.file) : null
  })()
  return {
    path: dir,
    title: project.title,
    aspect: project.video.aspect,
    episodeSeconds: project.video.episodeSeconds,
    episodes: project.episodes.length,
    assets: project.assets.length,
    doneAssets: project.assets.filter((a) => a.status === 'done').length,
    failedAssets: project.assets.filter((a) => a.status === 'failed').length,
    doneEpisodes,
    credits,
    palette: (project.style.palette || {}).zh || '',
    stylePreset: project.style.preset || '',
    canvasUrl: (project.canvas || {}).url || '',
    hasFinal: existsSync(finalPath),
    finalBytes: existsSync(finalPath) ? statSync(finalPath).size : 0,
    cover,
    createdAt: project.createdAt || null,
    updatedAt: project.updatedAt || statSync(projectFile(dir)).mtime.toISOString()
  }
}

export function listProjects(parent) {
  const dir = resolveDir(parent)
  return readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && isProjectDir(join(dir, d.name)))
    .map((d) => {
      try { return projectSummary(join(dir, d.name)) } catch { return null }
    })
    .filter(Boolean)
    .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))
}

export function relativeFile(dir, file) {
  if (!file) return null
  const abs = resolve(dir, file)
  return existsSync(abs) ? normalize(relative(dir, abs)) : null
}

// 给页面用的摘要：文件路径一律相对项目目录，prompt 只留预览（页面要的是「写了什么」，
// 不是把整段分镜塞进接口返回）。
const PREVIEW_CHARS = 320

export function fileSummary(dir, project) {
  const assets = project.assets.map((a) => ({
    id: a.id,
    name: a.name || '',
    status: a.status || 'idle',
    file: relativeFile(dir, a.file),
    nodeId: a.nodeId || null,
    taskId: a.taskId || null,
    ratio: a.ratio || '',
    credits: Number.isFinite(Number(a.credits)) ? Number(a.credits) : null,
    promptChars: String(a.prompt || '').length,
    prompt: String(a.prompt || '').slice(0, PREVIEW_CHARS),
    error: a.error || null
  }))
  const episodes = project.episodes.map((e) => ({
    id: e.id,
    title: e.title || '',
    refs: e.refs || [],
    promptChars: String(e.prompt || '').length,
    prompt: String(e.prompt || '').slice(0, PREVIEW_CHARS),
    storyboard: relativeFile(dir, e.storyboard),
    video: {
      status: (e.video && e.video.status) || 'idle',
      file: relativeFile(dir, e.video && e.video.file),
      nodeId: (e.video && e.video.nodeId) || null,
      taskId: (e.video && e.video.taskId) || null,
      credits: e.video && Number.isFinite(Number(e.video.credits)) ? Number(e.video.credits) : null,
      duration: e.video && Number.isFinite(Number(e.video.duration)) ? Number(e.video.duration) : null,
      mode: (e.video && e.video.mode) || '',
      finishedAt: (e.video && e.video.finishedAt) || null,
      error: (e.video && e.video.error) || null
    }
  }))
  return { assets, episodes }
}
