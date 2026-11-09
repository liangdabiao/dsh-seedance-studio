// 生成历史 + 扫描根目录设置（$DSH_HOME/seedance-studio/）。
// 目录布局：
//   history.json   每次出图 / 出片 / 拼接的记录（新的在前，最多 MAX_RECORDS 条）
//   settings.json  页面用过的项目根目录（roots）和上次选中的目录（lastRoot）
//
// 历史是「可对比」的：同一条记录里既有这次生成的范围（items）、积分、模型参数，
// 也有产物相对路径，页面和模型（seedance_history 工具）读的是同一份数据。
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'

export const DATA_DIR = join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'seedance-studio')
const HISTORY_FILE = join(DATA_DIR, 'history.json')
const SETTINGS_FILE = join(DATA_DIR, 'settings.json')
const MAX_RECORDS = 400

export const KINDS = ['asset', 'episode', 'assemble']
export const KIND_LABEL = { asset: '出图', episode: '出片', assemble: '拼接' }

function ensureDir() {
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true })
}

// 原子写：先 .tmp 再 rename，避免页面轮询时读到半截 JSON。
function atomicWrite(file, value) {
  ensureDir()
  const tmp = `${file}.${process.pid}.tmp`
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  try {
    renameSync(tmp, file)
  } catch (err) {
    try { writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8') } catch { /* ignore */ }
    throw err
  }
}

function readJson(file, fallback) {
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8'))
    return raw ?? fallback
  } catch {
    return fallback
  }
}

// ---------------------------------------------------------------------------
// 历史
// ---------------------------------------------------------------------------
export function readHistory() {
  const raw = readJson(HISTORY_FILE, [])
  return Array.isArray(raw) ? raw : []
}

export function getRecord(id) {
  return readHistory().find((r) => r.id === id) || null
}

export function updateRecord(id, patch) {
  const list = readHistory()
  const index = list.findIndex((r) => r.id === id)
  if (index === -1) return null
  list[index] = { ...list[index], ...patch }
  atomicWrite(HISTORY_FILE, list)
  return list[index]
}

export function removeRecord(id) {
  const list = readHistory()
  const next = list.filter((r) => r.id !== id)
  if (next.length === list.length) return false
  atomicWrite(HISTORY_FILE, next)
  return true
}

export function clearHistory({ project } = {}) {
  const list = readHistory()
  if (!project) { atomicWrite(HISTORY_FILE, []); return list.length }
  const target = normalizePath(project)
  const next = list.filter((r) => normalizePath(r.project) !== target)
  atomicWrite(HISTORY_FILE, next)
  return list.length - next.length
}

let seq = 0

// 一条生成记录。items 里放这次真正动过的对象（资产/集），失败也留一条，
// 这样页面能回答「这张图上次为什么失败」。
export function recordGeneration(input) {
  const at = input.at || new Date().toISOString()
  const record = {
    id: `h-${Date.now().toString(36)}-${++seq}`,
    at,
    atLabel: input.atLabel || '',
    finishedAt: input.finishedAt || new Date().toISOString(),
    kind: input.kind,
    kindLabel: KIND_LABEL[input.kind] || input.kind,
    project: input.project,
    projectTitle: input.projectTitle || '',
    status: input.status === 'ok' ? 'ok' : 'failed',
    summary: String(input.summary || '').slice(0, 2000),
    error: input.error ? String(input.error).slice(0, 2000) : '',
    credits: Number.isFinite(Number(input.credits)) ? Number(input.credits) : null,
    model: input.model || '',
    resolution: input.resolution || '',
    duration: input.duration || null,
    items: Array.isArray(input.items) ? input.items.map((it) => ({
      id: it.id || '',
      name: it.name || '',
      status: it.status === 'ok' ? 'ok' : it.status === 'failed' ? 'failed' : 'skip',
      file: it.file || null,
      credits: Number.isFinite(Number(it.credits)) ? Number(it.credits) : null,
      nodeId: it.nodeId || null,
      error: it.error ? String(it.error).slice(0, 500) : ''
    })) : [],
    outputs: (input.outputs || []).filter(Boolean)
  }
  // 页面会用 outputs 直接渲染缩略图；没有显式给就把 items 里的文件补上
  if (!record.outputs.length) record.outputs = record.items.map((it) => it.file).filter(Boolean)
  const list = readHistory()
  list.unshift(record)
  if (list.length > MAX_RECORDS) list.length = MAX_RECORDS
  atomicWrite(HISTORY_FILE, list)
  return record
}

export function normalizePath(value) {
  const s = String(value || '').trim()
  if (!s) return ''
  try { return isAbsolute(s) ? resolve(s).toLowerCase() : s.toLowerCase() } catch { return s.toLowerCase() }
}

// kind/status 过滤 + 项目过滤：页面和工具共用同一个筛选语义。
export function filterHistory(records, { kind, status, project, limit = 50, q } = {}) {
  const needle = String(q || '').trim().toLowerCase()
  const target = project ? normalizePath(project) : ''
  let list = records
  if (kind && kind !== 'all') list = list.filter((r) => r.kind === kind)
  if (status && status !== 'all') list = list.filter((r) => r.status === status)
  if (target) list = list.filter((r) => normalizePath(r.project) === target)
  if (needle) list = list.filter((r) => `${r.projectTitle} ${r.summary} ${r.model} ${r.project}`.toLowerCase().includes(needle))
  return list.slice(0, Math.max(1, Math.min(MAX_RECORDS, Number(limit) || 50)))
}

export function summarize(list) {
  const ok = list.filter((r) => r.status === 'ok').length
  const credits = list.reduce((sum, r) => sum + (Number(r.credits) || 0), 0)
  const byKind = { asset: 0, episode: 0, assemble: 0 }
  const outputs = { asset: 0, episode: 0, assemble: 0 }
  for (const r of list) {
    if (byKind[r.kind] !== undefined) byKind[r.kind] += 1
    if (r.kind in outputs && r.status === 'ok') outputs[r.kind] += (r.outputs || []).length
  }
  const projects = new Set(list.map((r) => normalizePath(r.project)).filter(Boolean))
  return {
    total: list.length,
    ok,
    failed: list.length - ok,
    credits,
    projects: projects.size,
    byKind,
    outputs,
    lastAt: list.length ? list[0].at : null
  }
}

// ---------------------------------------------------------------------------
// 设置：项目根目录（页面「扫描目录」用）
// ---------------------------------------------------------------------------
export function readSettings() {
  const raw = readJson(SETTINGS_FILE, {})
  const roots = Array.isArray(raw.roots)
    ? raw.roots.filter((r) => typeof r === 'string' && r.trim()).map((r) => resolve(r.trim()))
    : []
  return { roots, lastRoot: typeof raw.lastRoot === 'string' && raw.lastRoot ? resolve(raw.lastRoot) : '' }
}

export function writeSettings(patch) {
  const current = readSettings()
  const next = { ...current, ...patch }
  if (Array.isArray(patch?.roots)) {
    const seen = new Set()
    next.roots = patch.roots
      .filter((r) => typeof r === 'string' && r.trim())
      .map((r) => resolve(r.trim()))
      .filter((r) => (seen.has(normalizePath(r)) ? false : seen.add(normalizePath(r))))
  }
  atomicWrite(SETTINGS_FILE, next)
  return next
}

// 页面打开时扫哪些目录：roots 优先，没配过就用当前工作目录。
export function scanRoots() {
  const { roots } = readSettings()
  if (roots.length) return roots
  const cwd = process.cwd()
  return [cwd]
}
