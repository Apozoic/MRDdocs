// app\src\app\admin\mrd\sentiens-fiction\projects\[id]\sbor\general-pipeline.tsx
'use client'

import { useState, useEffect } from 'react'
import { ExternalLink, Shuffle, ChevronDown, ScanText, X, Loader2, Bot, Eye, FileText, ArrowRight, Ban, ClipboardPaste, RefreshCw } from 'lucide-react'
import { useSbor, type PipelineState, type FcState, type FcQueryResult, type ScrapeItem } from './sbor-context'
import { useTheme } from './theme-context'
import { SEARCH_TEMPLATES, buildGoogleUrl, applyTemplate, GLOBAL_EXCLUDE } from './sbor-search-templates'
import { GENERAL_THEMES, GENERAL_IDS, PROGRAM_IDS, THEMES_BY_ID, type Theme, type EntriesState } from './sbor-data'
import { EXPANDED } from './general/expanded-config'
import { ApiViewer, type ApiViewerModel, type ApiViewerData } from '@/components/api-viewer'
import { processMarkdown } from './markdown-clean'

const DISTRIBUTE_ALLOWED_MODELS = ['gpt-oss-120b', 'deepseek-v4-pro', 'minimax-m2.7', 'minimax-m3', 'qwen3.7-plus']

// Некоторые модели оборачивают валидный JSON в markdown-блок (```json … ```)
// или добавляют пояснения вокруг. Достаём чистый JSON перед парсингом.
function extractJson(raw: string): string {
  let s = raw.trim()
  // снимаем ограждение ```json … ``` или ``` … ```
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i)
  if (fence) s = fence[1].trim()
  // если вокруг JSON остался текст — вырезаем первый сбалансированный {…} или […]
  if (s[0] !== '{' && s[0] !== '[') {
    const obj = s.indexOf('{'), arr = s.indexOf('[')
    const start = obj === -1 ? arr : arr === -1 ? obj : Math.min(obj, arr)
    if (start >= 0) {
      const open = s[start], close = open === '{' ? '}' : ']'
      const end = s.lastIndexOf(close)
      if (end > start) s = s.slice(start, end + 1)
    }
  }
  return s.trim()
}

async function openWithDelay(urls: string[]) {
  for (const url of urls) {
    window.open(url, '_blank', 'noopener,noreferrer')
    await new Promise(r => setTimeout(r, 300))
  }
}

function getLabel(id: string): string {
  return THEMES_BY_ID[id]?.label ?? id
}

function themeChildren(parentId: string): Theme[] {
  return EXPANDED[parentId] ?? []
}

function themeKeys(parentId: string): string[] {
  const subs = themeChildren(parentId)
  return subs.length ? subs.map(t => t.id) : [parentId]
}

function getThemeUrls(parentId: string, projectUrl: string, projectName?: string, excludeChildLabels?: Set<string>): string[] {
  const subs = themeChildren(parentId).filter(s => !excludeChildLabels?.has(s.label))
  const urls: string[] = []
  const push = (q: string) => urls.push(buildGoogleUrl(projectUrl, applyTemplate(q, projectName)))
  if (subs.length) {
    subs.forEach(sub => SEARCH_TEMPLATES[sub.label]?.forEach(t => push(t.query)))
  } else if (!themeChildren(parentId).length) {
    SEARCH_TEMPLATES[getLabel(parentId)]?.forEach(t => push(t.query))
  }
  return urls
}

function getThemeQueries(parentId: string, projectUrl: string, projectName?: string, excludeChildLabels?: Set<string>): Array<{ key: string; query: string }> {
  const subs = themeChildren(parentId).filter(s => !excludeChildLabels?.has(s.label))
  const raw: Array<{ key: string; query: string }> = []
  if (subs.length) {
    subs.forEach(sub => SEARCH_TEMPLATES[sub.label]?.forEach(t => raw.push({ key: sub.id, query: applyTemplate(t.query, projectName) })))
  } else if (themeChildren(parentId).length) {
    // all subtopics excluded — no queries for this parent
  } else {
    SEARCH_TEMPLATES[getLabel(parentId)]?.forEach(t => raw.push({ key: parentId, query: applyTemplate(t.query, projectName) }))
  }
  let domain = ''
  try { domain = new URL(projectUrl).hostname.replace(/^www\./, '') } catch {}
  return raw.map(r => ({ key: r.key, query: domain ? `site:${domain} ${r.query} ${GLOBAL_EXCLUDE}` : `${r.query} ${GLOBAL_EXCLUDE}` }))
}

type ApiHit = { url: string; title?: string; description?: string }
type ApiItem = { query: string; hits: ApiHit[]; error?: string }

type Link = { url: string; title?: string }
type Batch = Link[]

function parseLine(line: string): Link | null {
  // markdown-ссылка [title](url)
  if (line.startsWith('[')) {
    const sep = line.indexOf('](')
    if (sep > 0 && line.endsWith(')')) {
      const title = line.slice(1, sep).trim()
      const url = line.slice(sep + 2, -1).trim()
      try { new URL(url); return { title: title || undefined, url } } catch {}
    }
  }
  // строка целиком — URL
  try { new URL(line); return { url: line } } catch {}
  // комбинированный формат: «Текст — https://...», «1. https://...» и т.п.
  // вытаскиваем первый http(s)-URL, остальное считаем заголовком.
  const m = line.match(/https?:\/\/[^\s)<>"']+/)
  if (m) {
    const url = m[0].replace(/[.,;]+$/, '')
    try {
      new URL(url)
      const title = line.replace(m[0], '').replace(/^[\s\-–—•·:|)\].]+|[\s\-–—•·:|([]+$/g, '').trim()
      return { url, title: title || undefined }
    } catch {}
  }
  return null
}

const DISTRIBUTE_THEME_IDS = ['glavnaya', 'pochemu']

const SIZE_WARN = 5000
const SIZE_DANGER = 10000
type SizeLevel = 'ok' | 'warn' | 'danger'
function sizeLevel(len: number): SizeLevel {
  if (len > SIZE_DANGER) return 'danger'
  if (len > SIZE_WARN) return 'warn'
  return 'ok'
}


// Строгая JSON-схема: объект, где ключи — ровно допустимые темы, значения — массивы id.
// strict + additionalProperties:false запрещают модели менять форму ответа (обёртки, лишние ключи).
function buildResponseFormat(validLabels: string[]) {
  return {
    type: 'json_schema',
    json_schema: {
      name: 'distribution',
      strict: true,
      schema: {
        type: 'object',
        properties: Object.fromEntries(
          validLabels.map(l => [l, { type: 'array', items: { type: 'string' } }])
        ),
        required: validLabels,
        additionalProperties: false,
      },
    },
  }
}

// Простой JSON-режим — фолбэк для моделей, не умеющих json_schema.
const JSON_OBJECT_FORMAT = { type: 'json_object' }

// Похоже ли, что провайдер не поддержал structured output (json_schema)?
function isSchemaUnsupported(err: string): boolean {
  const s = err.toLowerCase()
  return s.includes('json_schema') || s.includes('response_format')
    || s.includes('structured output') || s.includes('response format')
}

function cleanQuery(q: string): string {
  return q.split(/\s+/).filter(t => !t.startsWith('-') && !t.startsWith('site:') && !t.startsWith('filetype:') && !t.startsWith('inurl:') && !t.startsWith('intitle:')).join(' ').trim()
}

function buildSubtopicHints(children: Theme[], projectName?: string): Record<string, string[]> {
  const out: Record<string, string[]> = {}
  children.forEach(c => {
    const templates = SEARCH_TEMPLATES[c.label] ?? []
    const queries = templates.map(t => cleanQuery(applyTemplate(t.query, projectName))).filter(Boolean)
    if (queries.length) out[c.label] = queries
  })
  return out
}

function buildSystemPrompt(validLabels: string[], hints: Record<string, string[]>): string {
  const hintsBlock = Object.entries(hints).map(([k, qs]) => `  "${k}": [${qs.map(q => `"${q}"`).join(', ')}]`).join(',\n')
  return `Мы собираемся собрать самую фундаментальную информацию о заведении для студентов, чтобы дать ему характеристику в сравнении с другими. Распредели действительно необходимые для раскрытия подтем ссылки по соответствующим подтемам. Основывайся в первую очередь на сниппете, но при необходимости можно пользоваться контекстом тайтла и адресной строки.

Допустимые ключи (используй только их, точно как написано):
${validLabels.join(', ')}

Контекст по подтемам — какие поисковые запросы мы использовали для сбора ссылок к каждой подтеме. Это подсказка о том, какую фактуру мы ожидаем видеть в каждой из подтем. Поэтому старайся закрывать подтемы в соответствии с нашими ожиданиями - мы не просто так делали эти запросы:
{
${hintsBlock}
}

- Входные данные — JSON-массив объектов вида { "id": "L0", "title": "...", "url": "...", "snippet": "..." }.
- Возвращай только идентификаторы (L0, L1, ...) — не URL и не заголовки.
- Поля title и snippet могут отсутствовать — в таком случае ориентируйся на оставшиеся поля.
- Если у ссылки нет ни title, ни snippet (часто так у добавленных вручную ссылок) — распределяй по «говорящему» пути URL (slug): например /accommodation → проживание, /fees|/tuition → стоимость, /campus → кампус, /careers → карьера. Не выбрасывай такую ссылку только из-за отсутствия title/snippet — раз её добавили вручную, она почти наверняка нужна; постарайся подобрать наиболее подходящий ключ по URL.
- Те ID, которые ты решил заппрувить, должны аппрувнуться один раз в какую-то подтему - без дубликатов. Если ты не заполнил какую-либо подтему ни одной ссылкой - просто не включай ее в ответ.
- Подтемы могут оставаться пустыми, если среди ссылок нет подходящей фактуры или примеров для её раскрытия — это редко, но случается, не нужно притягивать ссылку «лишь бы заполнить».

- Нам не нужны все ссылки - лишь те, что согласно сниппету и косвенным признакам (тайтл/ссылка) хранят в себе фактуру по подтеме. Распределяй те ссылки, которые фундаментальны/интересны, чтобы раскрыть подтему. И игнорируй утилитарные, второстепенные. Т.е. ссылку, не дающую полезной фактуры ни одной из подтем, просто не включай в ответ — это нормально и ожидаемо.
- Дополнительный лимит - любая подтема не может включать более 7 ссылок. Выбирай наиболее приоритетные/интересные.
- При этом старайся тщательно уделить внимание какие запросы мы использовали для сбора ссылок к подтемам - нас интересуют различные подтемы. Например, в студенческой жизни - и жизнь, и клубы, и спорт. В карьере - и возможности, и рабочий опыт и т.д.
- Выбираемая для подтемы ссылка может быть не только обзорно/профильной, но и предоставлять примеры. Это характерно, например, для рейтингов, достижений и тд.
- Нас не интересуют отзывы студентов, записи в блогах.

Вот пример того как мы думаем:
Об университете: базовая информация и статистика, история, миссия и т.д. - фундамент заведения.
Расположение: географическая локация и доступность.
Кампусы: название и характеристика кампуса / кампусов (если их несколько)
Инфраструктура: общие странице о материальных возможностях университете, но не частных.
Структура: имеется ввиду факультеты/школы или типа того. Именно перечень, а не упоминание рандомных частных.
Акад. предложение: не список всех программ, а наличие статистики о программах, либо о предметных областях, которые предлагает вуз.
Студенческая жизнь: все, что относится к тому что вне учебы - жизнь в городе, развлечения, спорт и сообщества, волонтерство и тд.
Проживание: информация о проживании, размещении - блоки и общежития, типы комнат, стоимость проживания (преимущественно универсально международного контекста либо общее)
Почему: прямой ответ университета в формате why, reasons и т.д.
Аккредитации: интересует либа общая суммирующая страница об аккредитациях, либо 3-4 из факультетов/программ - не более.
Рейтинг: страницы с указанием мест заведения в рейтингах. Предпочительны суммирующие, н при неналичии допустимы предметные.
Достижения: любые действительно заслуживающие внимания достижения вуза - либо суммирующие страницы, либо из новостей, но без акцента на конкретных личностях или чем-то очень косвенном вроде экологии.
Знаменитые выпускники: только если университет действительно явно указывает выпускников-глобального или корпоративного масштаба. Нас не интересуют рядовые выпускники которые просто нашли где то работу.
Карьера: интересует именно характеристика университета как он подходит к вопросу карьеры студентов: в приоритете упоминания компаний, описания стажировок и работы за границей, деятельность отдела.
Международность: мы пишем текст для универсально международных учеников. Сюда можно отнести одну-несколько страниц, если университет позиционирует себя международным и что-то обещает. Нас не интересуют страницы по конкретным странам или Евросоюзу.



Пример ответа:
{"Кампус": ["L1"], "Рейтинг": ["L2"], "Проживание": ["L3"]}

Только JSON-объект, без пояснений.`
}

type DistrPart = { system: string; user: string; data: ApiViewerData }
type DistrState = {
  model: ApiViewerModel
  parts: Record<string, DistrPart>  // keyed by parent id
}


function BatchSpoiler({ batch, idx, onDelete, cls }: {
  batch: Batch
  idx: number
  onDelete: () => void
  cls: { dim: string; url: string }
}) {
  const [open, setOpen] = useState(false)
  return (
    <div onContextMenu={e => { e.preventDefault(); if (window.confirm('Удалить итерацию?')) onDelete() }}>
      <button onClick={() => setOpen(v => !v)}
        className={`flex items-center gap-1.5 text-[10px] transition-colors ${cls.dim} hover:opacity-80`}>
        <ChevronDown size={10} className={`transition-transform duration-150 ${open ? 'rotate-180' : ''}`} />
        <span className="font-mono">#{idx + 1}</span>
        <span className="font-mono opacity-60">{batch.length}</span>
      </button>
      {open && (
        <div className="mt-1 ml-3 flex flex-col gap-0.5">
          {batch.map(({ url, title }, i) => (
            <a key={`${i}:${url}`} href={url} target="_blank" rel="noopener noreferrer"
              className={`text-[10px] truncate block transition-colors ${cls.url}`}
              title={url}>
              {title ?? url.replace(/^https?:\/\//, '')}
            </a>
          ))}
        </div>
      )}
    </div>
  )
}

function DistrOverlay({ distr, onClose, onRetry, retryingPart }: {
  distr: DistrState; onClose: () => void
  onRetry: (parentId: string) => void
  retryingPart: string | null
}) {
  const parentIds = Object.keys(distr.parts)
  const [active, setActive] = useState(parentIds[0] ?? '')
  const part = distr.parts[active]
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-6 bg-black/60" onClick={onClose}>
      <div className="relative w-full max-w-2xl max-h-[85vh] rounded-xl overflow-hidden flex flex-col"
        onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between px-4 py-2.5 bg-[#1c1b19] border-b border-[#38362f]">
          <div className="flex items-center gap-3">
            <span className="text-[11px] font-medium text-[#999]">Ответ нейронки</span>
            <div className="flex items-center gap-1">
              {parentIds.map(pid => (
                <button key={pid} onClick={() => setActive(pid)}
                  className={`text-[10px] px-2 py-0.5 rounded transition-colors ${
                    pid === active ? 'bg-[#38362f] text-[#ddd]' : 'text-[#777] hover:text-[#aaa]'
                  } ${distr.parts[pid].data.error ? 'text-red-400' : ''}`}>
                  {pid === '__general' ? 'Общие' : getLabel(pid)}
                </button>
              ))}
            </div>
          </div>
          <button onClick={onClose} className="text-[#555] hover:text-[#999] transition-colors"><X size={14} /></button>
        </div>
        {part && <div className="overflow-y-auto">
          {part.data.error && (
            <div className="flex items-center justify-between gap-3 px-4 py-2 bg-[#2a0a0a] border-b border-[#5a2020]">
              <span className="text-[11px] text-[#f08080] truncate">⚠ {part.data.error}</span>
              <button onClick={() => onRetry(active)} disabled={retryingPart != null}
                title="Пере-раздать только эту тему"
                className="flex items-center gap-1 px-2 py-0.5 rounded border text-[10px] shrink-0 transition-colors disabled:opacity-50 border-red-400/50 text-red-400 hover:text-red-300">
                {retryingPart === active ? <Loader2 size={10} className="animate-spin" /> : <RefreshCw size={10} />}
                <span>повторить</span>
              </button>
            </div>
          )}
          <ApiViewer model={distr.model} data={part.data} />
        </div>}
      </div>
    </div>
  )
}

function FirecrawlOverlay({ parentLabel, queries, onClose }: { parentLabel: string; queries: FcQueryResult[]; onClose: () => void }) {
  const last = queries.reduce((m, q) => Math.max(m, q.runAt), 0)
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-6 bg-black/60" onClick={onClose}>
      <div className="relative w-full max-w-2xl max-h-[85vh] rounded-xl overflow-hidden flex flex-col bg-[#1c1b19] border border-[#38362f]"
        onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between px-4 py-2.5 border-b border-[#38362f]">
          <span className="text-[11px] font-medium text-[#999]">Firecrawl · {parentLabel} · {new Date(last).toLocaleString()}</span>
          <button onClick={onClose} className="text-[#555] hover:text-[#999] transition-colors"><X size={14} /></button>
        </div>
        <div className="overflow-y-auto p-4 flex flex-col gap-3">
          {queries.map((r, i) => (
            <div key={i} className="text-[11px] flex flex-col gap-1.5">
              <div className="font-mono text-[#777] flex items-center gap-2">
                <span>{r.query}</span>
                {!r.error && <span className="text-[#555]">· {r.hits.length}</span>}
              </div>
              {r.error
                ? <div className="text-red-400/80 ml-3">⚠ {r.error}</div>
                : (
                  <ol className="ml-3 flex flex-col gap-1.5 list-decimal list-inside marker:text-[#555]">
                    {r.hits.map((h, j) => (
                      <li key={j} className="flex flex-col gap-0.5">
                        <a href={h.url} target="_blank" rel="noopener noreferrer" className="text-[#9cb4d9] hover:underline truncate inline">
                          {h.title ?? h.url}
                        </a>
                        <div className="text-[#888] truncate ml-4">{h.url}</div>
                        {h.description && <div className="text-[#aaa] text-[10.5px] ml-4">{h.description}</div>}
                      </li>
                    ))}
                  </ol>
                )}
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

function ScrapeOverlay({ parentLabel, items, onClose, onToggleExclude, onRetry, onRemove, retrying }: {
  parentLabel: string
  items: Array<ScrapeItem & { subtopicId: string }>
  onClose: () => void
  onToggleExclude: (subtopicId: string, url: string) => void
  onRetry: (subtopicId: string, url: string) => void
  onRemove: (subtopicId: string, url: string) => void
  retrying: boolean
}) {
  const errCount = items.filter(i => i.error).length
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-6 bg-black/60" onClick={onClose}>
      <div className="relative w-full max-w-3xl max-h-[85vh] rounded-xl overflow-hidden flex flex-col bg-[#1c1b19] border border-[#38362f]"
        onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between px-4 py-2.5 border-b border-[#38362f]">
          <div className="flex items-center gap-3">
            <span className="text-[11px] font-medium text-[#999]">Firecrawl scrape · {parentLabel} · {items.length}</span>
            {errCount > 0 && (
              <button onClick={() => items.filter(i => i.error).forEach(i => onRetry(i.subtopicId, i.url))}
                disabled={retrying}
                title={`Повторить все упавшие (${errCount})`}
                className="flex items-center gap-1 px-1.5 py-0.5 rounded border text-[10px] transition-colors disabled:opacity-50 border-red-400/50 text-red-400 hover:text-red-300">
                {retrying ? <Loader2 size={10} className="animate-spin" /> : <RefreshCw size={10} />}
                <span>{errCount}</span>
              </button>
            )}
          </div>
          <button onClick={onClose} className="text-[#555] hover:text-[#999] transition-colors"><X size={14} /></button>
        </div>
        <div className="overflow-y-auto p-4 flex flex-col gap-2">
          {items.map((it, i) => {
            const processed = it.markdown ? processMarkdown(it.markdown) : ''
            const len = processed.length
            const lvl = sizeLevel(len)
            const lenCls = lvl === 'danger' ? 'text-red-300' : lvl === 'warn' ? 'text-amber-300' : 'text-[#888]'
            const cardCls = lvl === 'danger'
              ? 'border-red-400/40 bg-red-500/10'
              : lvl === 'warn'
                ? 'border-amber-400/40 bg-amber-500/10'
                : 'border-[#2a2925]'
            const rowCls = it.excluded ? 'opacity-40' : ''
            return (
              <div key={i} className={`text-[11px] flex flex-col gap-0.5 border rounded p-2 ${cardCls} ${rowCls}`}>
                <div className="flex items-center gap-2">
                  <span className="font-mono text-[10px] text-[#666]">{getLabel(it.subtopicId)}</span>
                  {it.error
                    ? <span className="text-red-400/80">⚠ {it.error}</span>
                    : <span className={`font-mono ${lenCls}`}>{len.toLocaleString()} chars{it.tokens != null ? ` / ${it.tokens.toLocaleString()} tok` : ''}</span>}
                  <div className="flex-1" />
                  {!it.error && (
                    <button onClick={() => onToggleExclude(it.subtopicId, it.url)}
                      title={it.excluded ? 'Разрешить перенос' : 'Запретить перенос в подтемы'}
                      className={`flex items-center gap-1 px-1.5 py-0.5 rounded border text-[10px] transition-colors ${
                        it.excluded
                          ? 'border-red-400/40 text-red-400 hover:text-red-300'
                          : 'border-[#38362f] text-[#666] hover:text-[#aaa]'
                      }`}>
                      <Ban size={9} />
                      {it.excluded ? 'запрещено' : ''}
                    </button>
                  )}
                  {it.error && (
                    <>
                      <button onClick={() => onRetry(it.subtopicId, it.url)} disabled={retrying}
                        title="Повторить скрейп"
                        className="flex items-center gap-1 px-1.5 py-0.5 rounded border text-[10px] transition-colors disabled:opacity-50 border-red-400/40 text-red-400 hover:text-red-300">
                        {retrying ? <Loader2 size={9} className="animate-spin" /> : <RefreshCw size={9} />}
                      </button>
                      <button onClick={() => onRemove(it.subtopicId, it.url)}
                        title="Убрать упавшую страницу"
                        className="flex items-center px-1.5 py-0.5 rounded border text-[10px] transition-colors border-[#38362f] text-[#666] hover:text-[#aaa]">
                        <X size={9} />
                      </button>
                    </>
                  )}
                </div>
                <a href={it.url} target="_blank" rel="noopener noreferrer" className="text-[#9cb4d9] hover:underline truncate">
                  {it.title ?? it.url}
                </a>
                {processed && !it.error && (
                  <details className="mt-0.5">
                    <summary className="text-[#666] cursor-pointer hover:text-[#999] text-[10px]">preview (очищено)</summary>
                    <pre className="mt-1 text-[10px] text-[#aaa] whitespace-pre-wrap max-h-48 overflow-y-auto bg-[#15140f] p-2 rounded">{processed.slice(0, 2000)}{processed.length > 2000 ? '\n...' : ''}</pre>
                  </details>
                )}
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}

export function GeneralPipeline() {
  const { checks, toggle, projectUrl, projectName, pipeline: batches, savePipeline, appendPipelineBatch, replaceEntries, entries, fc, mergeFc, clearFc, scrape, mergeScrape, upsertScrape, removeScrapeItem, clearScrape, toggleScrapeExclude, stages, toggleStage } = useSbor()
  const theme = useTheme()

  const [distributeModel, setDistributeModel] = useState<ApiViewerModel | null>(null)
  const [models, setModels] = useState<ApiViewerModel[]>([])
  const [distributingKey, setDistributingKey] = useState(false)
  const [distributingGeneral, setDistributingGeneral] = useState(false)
  const [distrKeyState, setDistrKeyState] = useState<DistrState | null>(null)
  const [distrGeneralState, setDistrGeneralState] = useState<DistrState | null>(null)
  const [showKeyOverlay, setShowKeyOverlay] = useState(false)
  const [showGeneralOverlay, setShowGeneralOverlay] = useState(false)
  const [retryingPart, setRetryingPart] = useState<string | null>(null)
  const [keyTab, setKeyTab] = useState('')
  const [generalTab, setGeneralTab] = useState('')

  const [fcLoading, setFcLoading] = useState<Set<string>>(new Set())
  const [fcOverlay, setFcOverlay] = useState<string | null>(null)

  const [scrapeLoading, setScrapeLoading] = useState<Set<string>>(new Set())
  const [scrapeOverlay, setScrapeOverlay] = useState<string | null>(null)

  const lsKey = `sbor:distr:${typeof window !== 'undefined' ? window.location.pathname : ''}`
  const lsKeyKey = `${lsKey}:key`
  const lsKeyGeneral = `${lsKey}:general`
  const lsKeyModel = `${lsKey}:model`

  async function runFirecrawl(parentId: string) {
    if (!projectUrl) return
    const items = getThemeQueries(parentId, projectUrl, projectName)
    if (!items.length) return
    setFcLoading(prev => new Set(prev).add(parentId))
    try {
      const res = await fetch('/api/mrd/firecrawl-search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ queries: items.map(i => i.query) }),
      })
      const json = await res.json()
      if (json.results) {
        const runAt: number = json.runAt ?? Date.now()
        const grouped: FcState = {}
        ;(json.results as ApiItem[]).forEach((r, idx) => {
          const key = items[idx]?.key
          if (!key) return
          ;(grouped[key] ||= []).push({ query: r.query, hits: r.hits ?? [], runAt, error: r.error })
        })
        mergeFc(grouped)

        const seen = new Set<string>()
        const fresh: Link[] = []
        ;(json.results as ApiItem[]).forEach(r => (r.hits ?? []).forEach(h => {
          if (!h.url || seen.has(h.url)) return
          seen.add(h.url)
          fresh.push({ url: h.url, title: h.title })
        }))
        if (fresh.length) appendPipelineBatch(parentId, fresh)
      } else if (json.error) {
        alert(`Firecrawl: ${json.error}`)
      }
    } catch (e) {
      console.error('firecrawl error:', e)
    } finally {
      setFcLoading(prev => { const n = new Set(prev); n.delete(parentId); return n })
    }
  }

  function applyImportedResults(parentId: string, parsed: ApiItem[]): number {
    if (!projectUrl) return 0
    const items = getThemeQueries(parentId, projectUrl, projectName)
    if (!items.length) return 0
    const byQuery = new Map(parsed.map(p => [p.query?.trim(), p]))
    const runAt = Date.now()
    const grouped: FcState = {}
    const fresh: Link[] = []
    const seen = new Set<string>()
    let matched = 0
    items.forEach(it => {
      const m = byQuery.get(it.query.trim())
      if (!m) return
      matched++
      ;(grouped[it.key] ||= []).push({ query: m.query, hits: m.hits ?? [], runAt })
      ;(m.hits ?? []).forEach(h => {
        if (!h.url || seen.has(h.url)) return
        seen.add(h.url)
        fresh.push({ url: h.url, title: h.title })
      })
    })
    if (!matched) return 0
    mergeFc(grouped)
    if (fresh.length) appendPipelineBatch(parentId, fresh)
    return matched
  }

  async function importFromExtension(parentId: string) {
    let text = ''
    try { text = await navigator.clipboard.readText() } catch { alert('Не удалось прочитать буфер'); return }
    let parsed: ApiItem[]
    try {
      const j = JSON.parse(text)
      parsed = Array.isArray(j) ? j : []
    } catch { alert('В буфере не JSON из расширения'); return }
    if (!parsed.length) { alert('Пустой массив в буфере'); return }
    const matched = applyImportedResults(parentId, parsed)
    if (!matched) alert('Ни один запрос из буфера не совпал с шаблонами темы')
  }

  function resetFirecrawl(parentId: string) {
    clearFc(themeKeys(parentId))
    if (fcOverlay === parentId) setFcOverlay(null)
  }

  function themeScrapeUrls(parentId: string): Array<{ subtopicId: string; url: string }> {
    const out: Array<{ subtopicId: string; url: string }> = []
    themeKeys(parentId).forEach(subId => {
      (entries[subId] ?? []).forEach(e => { if (e.url) out.push({ subtopicId: subId, url: e.url }) })
    })
    return out
  }

  function themeScrapeItems(parentId: string): Array<ScrapeItem & { subtopicId: string }> {
    const out: Array<ScrapeItem & { subtopicId: string }> = []
    themeKeys(parentId).forEach(subId => {
      (scrape[subId] ?? []).forEach(it => out.push({ ...it, subtopicId: subId }))
    })
    return out
  }

  function themeScrapeErrors(parentId: string): Array<{ subtopicId: string; url: string }> {
    return themeScrapeItems(parentId).filter(i => i.error).map(i => ({ subtopicId: i.subtopicId, url: i.url }))
  }

  // retryTargets задан — ретрай конкретных (упавших) URL с перезаписью по URL;
  // иначе — скрейп только ещё не пробованных страниц.
  async function runScrape(parentId: string, retryTargets?: Array<{ subtopicId: string; url: string }>) {
    let targets = retryTargets
    if (!targets) {
      const scrapedUrls = new Set(themeKeys(parentId).flatMap(k => (scrape[k] ?? []).map(i => i.url)))
      targets = themeScrapeUrls(parentId).filter(i => !scrapedUrls.has(i.url))
    }
    if (!targets.length) return

    setScrapeLoading(prev => new Set(prev).add(parentId))
    try {
      const res = await fetch('/api/mrd/firecrawl-scrape', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ urls: targets.map(f => f.url) }),
      })
      const json = await res.json()
      if (json.results) {
        const runAt: number = json.runAt ?? Date.now()
        const grouped: Record<string, ScrapeItem[]> = {}
        ;(json.results as Array<{ url: string; markdown?: string; title?: string; tokens?: number; error?: string }>).forEach(r => {
          const subId = targets!.find(f => f.url === r.url)?.subtopicId
          if (!subId) return
          ;(grouped[subId] ||= []).push({
            url: r.url,
            markdown: r.markdown,
            title: r.title,
            tokens: r.tokens,
            scrapedAt: runAt,
            error: r.error,
          })
        })
        if (retryTargets) upsertScrape(grouped)
        else mergeScrape(grouped)
      } else if (json.error) {
        alert(`Firecrawl scrape: ${json.error}`)
      }
    } catch (e) {
      console.error('firecrawl scrape error:', e)
    } finally {
      setScrapeLoading(prev => { const n = new Set(prev); n.delete(parentId); return n })
    }
  }

  function resetScrape(parentId: string) {
    clearScrape(themeKeys(parentId))
    if (scrapeOverlay === parentId) setScrapeOverlay(null)
  }

  function transferScrapeToEntries(parentId: string) {
    const items = themeScrapeItems(parentId).filter(i => i.markdown && !i.error && !i.excluded)
    if (!items.length) return
    const urls = new Set(items.map(i => i.url))
    const next: typeof entries = {}
    let removed = 0
    for (const [k, list] of Object.entries(entries)) {
      const kept = (list ?? []).filter(e => {
        if (e.url && urls.has(e.url)) { removed++; return false }
        return true
      })
      next[k] = kept
    }
    if (!window.confirm(`Перенести ${items.length} текстов?${removed ? ` Будет перезаписано ${removed} существующих по URL.` : ''}`)) return
    items.forEach(it => {
      const payload = JSON.stringify({
        title: it.title ?? '',
        url: it.url,
        content: processMarkdown(it.markdown!),
      }, null, 2)
      next[it.subtopicId] = [...(next[it.subtopicId] ?? []), { id: crypto.randomUUID(), url: it.url, text: payload, title: it.title }]
    })
    replaceEntries(next)
  }

  function themeFcQueries(parentId: string): FcQueryResult[] {
    return themeKeys(parentId).flatMap(k => fc[k] ?? [])
  }

  useEffect(() => {
    fetch('/api/mrd/model-settings').then(r => r.json()).then((data: ApiViewerModel[]) => {
      const MODEL_ORDER = ['sonnet-46-ext', 'sonnet-46', 'sonnet-45-ext', 'sonnet-45', 'haiku-45', 'haiku-3', 'gpt-oss-120b', 'deepseek-v4-pro', 'minimax-m2.7', 'minimax-m3', 'qwen3.7-plus']
      const sorted = [...data].sort((a, b) => MODEL_ORDER.indexOf(a.model_key) - MODEL_ORDER.indexOf(b.model_key))
      setModels(sorted)
      const allowed = sorted.filter(m => DISTRIBUTE_ALLOWED_MODELS.includes(m.model_key))
      setModels(allowed)
      let savedModelKey: string | null = null
      try { savedModelKey = localStorage.getItem(lsKeyModel) } catch {}
      const m = allowed.find(m => m.model_key === savedModelKey)
        ?? allowed.find(m => m.model_key === DISTRIBUTE_ALLOWED_MODELS[0])
        ?? allowed[0] ?? null
      setDistributeModel(m)

      // restore last results from localStorage (ключевые и общие — раздельно)
      try {
        const savedKey = localStorage.getItem(lsKeyKey)
        if (savedKey && m) { const p = JSON.parse(savedKey); if (p.parts) setDistrKeyState({ model: m, parts: p.parts }) }
        const savedGen = localStorage.getItem(lsKeyGeneral)
        if (savedGen && m) { const p = JSON.parse(savedGen); if (p.parts) setDistrGeneralState({ model: m, parts: p.parts }) }
      } catch {}
    }).catch(() => {})
  }, [])

  const isDark   = theme === 'dark'
  const dimCls   = isDark ? 'text-white/35' : 'text-black/30'
  const nameCls  = isDark ? 'text-white/80' : 'text-black/75'
  const lineCls  = isDark ? 'bg-white/10' : 'bg-black/10'
  const dotCls   = isDark ? 'border-white/20 text-white/35' : 'border-black/15 text-black/30'
  const dotOnCls = isDark ? 'border-white/45 text-white/65' : 'border-black/35 text-black/55'
  const btnCls   = isDark
    ? 'border-white/15 text-white/40 hover:text-white/75 hover:border-white/30'
    : 'border-black/12 text-black/35 hover:text-black/65 hover:border-black/25'
  const inputCls = isDark
    ? 'bg-transparent border-white/10 text-white/55 placeholder:text-white/15 focus:border-white/25'
    : 'bg-transparent border-black/10 text-black/55 placeholder:text-black/15 focus:border-black/20'
  const spoilerCls = { dim: dimCls, url: isDark ? 'text-white/30 hover:text-white/60' : 'text-black/30 hover:text-black/60' }

  const selectedThemes: Theme[] = GENERAL_THEMES.filter(t => checks[t.id])

  function allExistingUrls(): Set<string> {
    const set = new Set<string>()
    Object.values(batches).forEach(bs => bs.forEach(b => b.forEach(l => set.add(l.url))))
    return set
  }

  // URL'ы, против которых дедуплицируется вставка в тему `key`:
  // сама тема + все темы выше неё по списку (цепочка приоритета сверху вниз).
  // Для псевдо-ключей (не темы, напр. '__extra') — против всех.
  function urlsBlockedFor(key: string): Set<string> {
    const order = GENERAL_IDS.indexOf(key)
    if (order === -1) return allExistingUrls()
    const set = new Set<string>()
    Object.entries(batches).forEach(([k, bs]) => {
      const ki = GENERAL_IDS.indexOf(k)
      if (k !== key && (ki === -1 || ki >= order)) return
      bs.forEach(b => b.forEach(l => set.add(l.url)))
    })
    return set
  }

  function handlePaste(key: string, e: React.ClipboardEvent<HTMLInputElement>) {
    const lines = e.clipboardData.getData('text').split(/[\n\r]+/).map(l => l.trim()).filter(Boolean)
    e.preventDefault()
    ;(e.target as HTMLInputElement).value = ''
    if (!lines.length) return
    const blocked = urlsBlockedFor(key)
    const fresh = lines.map(parseLine).filter((l): l is Link => !!l && !blocked.has(l.url))
    if (!fresh.length) return
    const next = { ...batches, [key]: [...((batches as PipelineState)[key] ?? []), fresh] }
    savePipeline(next)
  }

  function deleteBatch(key: string, idx: number) {
    const updated = ((batches as PipelineState)[key] ?? []).filter((_, i) => i !== idx)
    const next = { ...batches, [key]: updated }
    savePipeline(next)
  }

  const keyThemes     = selectedThemes.filter(t => DISTRIBUTE_THEME_IDS.includes(t.id))   // Почему, Главная
  const generalThemes = selectedThemes.filter(t => !DISTRIBUTE_THEME_IDS.includes(t.id))  // самостоятельные общие темы
  // Темы для чекбоксов шага 3 — все общие, кроме ключевых (они обрабатываются на шагах 1-2).
  const generalSelectable = GENERAL_THEMES.filter(t => !DISTRIBUTE_THEME_IDS.includes(t.id))
  // Сколько общих тем нужно выбрать: 11 минус темы Программ и минус ключевые (Главная/Почему).
  const selectedProgramCount = PROGRAM_IDS.filter(id => checks[id]).length
  const generalTarget = Math.max(0, 11 - selectedProgramCount - keyThemes.length)
  const generalChosen = generalSelectable.filter(t => checks[t.id]).length

  // Собрать дедуплицированный пул ссылок по набору тем (в порядке списка).
  function poolFor(ids: string[]): Link[] {
    const seen = new Set<string>()
    const list: Link[] = []
    ids.forEach(id => (batches[id] ?? []).forEach(b => b.forEach(l => {
      if (seen.has(l.url)) return
      seen.add(l.url); list.push(l)
    })))
    return list
  }

  // Ключевые темы — каждая со своим пулом (2 промпта); общие — один объединённый пул.
  const themeLinks: Record<string, Link[]> = {}
  keyThemes.forEach(t => { themeLinks[t.id] = poolFor([t.id]) })
  const keyPool = poolFor(keyThemes.map(t => t.id))
  const generalPool = poolFor(generalThemes.map(t => t.id))

  // Ссылки из «+ добавить ещё» тоже идут в распределение (раньше были тупиком).
  const keyExtra = poolFor(['__extra'])
  const generalExtra = poolFor(['__extra_general'])
  function dedupConcat(a: Link[], b: Link[]): Link[] {
    const seen = new Set(a.map(l => l.url))
    return [...a, ...b.filter(l => !seen.has(l.url))]
  }
  const generalDistrPool = dedupConcat(generalPool, generalExtra)
  const keyHasLinks = keyThemes.some(t => themeLinks[t.id].length > 0) || keyExtra.length > 0

  // build snippet map across all collected fc results (covers общие темы и подтемы)
  const snippetMap = new Map<string, string>()
  Object.values(fc).forEach(list => list.forEach(q => q.hits.forEach(h => {
    const d = (h.description ?? '').trim()
    if (!d) return
    const cur = snippetMap.get(h.url)
    if (!cur || d.length > cur.length) snippetMap.set(h.url, d)
  })))

  const keyThemeIds = keyThemes.map(t => t.id)
  const generalThemeIds = generalThemes.map(t => t.id)
  useEffect(() => {
    if (!keyThemeIds.includes(keyTab)) setKeyTab(keyThemeIds[0] ?? '')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [keyThemeIds.join(',')])
  useEffect(() => {
    if (!generalThemeIds.includes(generalTab)) setGeneralTab(generalThemeIds[0] ?? '')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [generalThemeIds.join(',')])
  const pipelineStages = ['__collect_key', '__distr_key', '__select_general', '__collect_general', '__distr_general', '__scrape'] as const

  useEffect(() => {
    function onMessage(ev: MessageEvent) {
      const d = ev.data
      if (!d || d.source !== 'sentiens-toolkit' || d.kind !== 'serp-results') return
      const parsed = Array.isArray(d.payload) ? d.payload as ApiItem[] : []
      if (!parsed.length) return
      let bestId = ''
      let bestN = 0
      for (const themeId of selectedThemes.map(t => t.id)) {
        const n = projectUrl ? getThemeQueries(themeId, projectUrl, projectName).filter(it =>
          parsed.some(p => p.query?.trim() === it.query.trim())
        ).length : 0
        if (n > bestN) { bestN = n; bestId = themeId }
      }
      if (!bestId) { console.warn('sentiens-toolkit: no matching theme'); return }
      applyImportedResults(bestId, parsed)
    }
    window.addEventListener('message', onMessage)
    return () => window.removeEventListener('message', onMessage)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectUrl, projectName, selectedThemes.map(t => t.id).join(',')])

  // Распределить пул `links` по корзинам `buckets`.
  // bucketIsTheme=true — корзины это сами темы (общие, без подтем): в промпте «подтемы» → «темы».
  async function runDistr(buckets: Theme[], links: Link[], bucketIsTheme: boolean): Promise<{ part: DistrPart; entries: EntriesState }> {
    const validLabels = buckets.map(c => c.label)
    const labelToId: Record<string, string> = Object.fromEntries(buckets.map(c => [c.label, c.id]))

    let system = buildSystemPrompt(validLabels, buildSubtopicHints(buckets, projectName))
    if (bucketIsTheme) system = system.replace(/Подтем/g, 'Тем').replace(/подтем/g, 'тем')

    const tagged = links.map((l, i) => ({ ...l, tempId: `L${i}` }))
    const idMap = new Map(tagged.map(l => [l.tempId, l]))
    const userPayload = tagged.map(l => {
      const obj: { id: string; title?: string; url: string; snippet?: string } = { id: l.tempId, url: l.url }
      if (l.title) obj.title = l.title
      const snip = snippetMap.get(l.url)
      if (snip) obj.snippet = snip
      return obj
    })
    const user = JSON.stringify(userPayload, null, 2)
    const t0 = Date.now()

    async function callModel(responseFormat: object) {
      const res = await fetch('/api/mrd/claude', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          modelKey: distributeModel!.model_key,
          system, user,
          responseFormat,
          overrides: { max_tokens: 40000, effort: 'low' },
        }),
      })
      return res.json() as Promise<{ text?: string; raw?: unknown; provider?: string; error?: string }>
    }

    // 1) строгая схема; 2) если провайдер её не умеет — откат на json_object;
    // 3) на любой другой (транзиентной) ошибке — один авто-повтор.
    let apiResp = await callModel(buildResponseFormat(validLabels))
    if (apiResp.error && isSchemaUnsupported(apiResp.error)) apiResp = await callModel(JSON_OBJECT_FORMAT)
    if (apiResp.error) apiResp = await callModel(JSON_OBJECT_FORMAT)
    const durationMs = Date.now() - t0
    const raw = apiResp.raw as Record<string, unknown> | undefined
    const data: ApiViewerData = {
      system,
      userMessage: user,
      responseText: apiResp.text ?? '',
      durationMs,
      stopReason: (raw?.stop_reason ?? raw?.finish_reason ?? '') as string,
      messageId: raw?.id as string | undefined,
      usage: raw?.usage as ApiViewerData['usage'],
      orUsage: distributeModel!.provider === 'openrouter' ? (raw?.usage as Record<string, unknown>) : undefined,
      orProvider: apiResp.provider as string | undefined,
      error: apiResp.error,
    }
    const out: EntriesState = {}
    if (!apiResp.error) {
      try {
        let parsed: unknown = JSON.parse(extractJson(apiResp.text ?? ''))
        // некоторые модели оборачивают ответ в массив [{...}] — разворачиваем
        if (Array.isArray(parsed)) parsed = parsed[0] ?? {}
        let record = (parsed && typeof parsed === 'object') ? parsed as Record<string, unknown> : {}
        // ...или в один ключ-обёртку {"result": {...}} — если ключ не наша тема, заходим внутрь
        const keys = Object.keys(record)
        if (keys.length === 1 && !labelToId[keys[0]]) {
          const inner = record[keys[0]]
          if (inner && typeof inner === 'object' && !Array.isArray(inner)) record = inner as Record<string, unknown>
        }
        for (const [label, ids] of Object.entries(record)) {
          if (!Array.isArray(ids) || !ids.length) continue
          const targetId = labelToId[label]
          if (!targetId) continue
          const list = ids.flatMap((tid: unknown) => {
            const link = typeof tid === 'string' ? idMap.get(tid) : undefined
            return link ? [{ id: crypto.randomUUID(), url: link.url, title: link.title }] : []
          })
          if (list.length) out[targetId] = list
        }
      } catch (e) {
        data.error = `JSON parse: ${(e as Error).message}`
      }
    }
    return { part: { system, user, data }, entries: out }
  }

  function errResult(e: unknown): { part: DistrPart; entries: EntriesState } {
    return {
      part: { system: '', user: '', data: { system: '', userMessage: '', responseText: '', durationMs: 0, stopReason: '', error: String(e) } as ApiViewerData },
      entries: {} as EntriesState,
    }
  }

  // Применить результат распределения. В корзинах `bucketIds` снимаем ТОЛЬКО прежний
  // результат распределения (ссылки из пула `poolUrls`), сохраняя ручные записи —
  // тексты и ссылки, которых в пуле не было. Затем дописываем свежий результат.
  // Если задан `pruneUrls` — выкинуть эти URL'ы из всех ОСТАЛЬНЫХ корзин
  // (пост-дедуп: ссылки, попавшие в общие темы, удаляются из Главной/Почему).
  function applyDistribution(bucketIds: string[], produced: EntriesState, poolUrls: Set<string>, pruneUrls?: Set<string>) {
    const next: EntriesState = { ...entries }
    bucketIds.forEach(id => {
      const kept = (next[id] ?? []).filter(e => !e.url || !poolUrls.has(e.url))
      if (kept.length) next[id] = kept
      else delete next[id]
    })
    for (const [k, v] of Object.entries(produced)) next[k] = [...(next[k] ?? []), ...v]
    if (pruneUrls && pruneUrls.size) {
      for (const [k, list] of Object.entries(next)) {
        if (bucketIds.includes(k)) continue
        const kept = (list ?? []).filter(e => !e.url || !pruneUrls.has(e.url))
        if (kept.length) next[k] = kept
        else delete next[k]
      }
    }
    replaceEntries(next)
  }

  // Шаг 2: распределение Главной/Почему — по промпту на каждую (корзины = подтемы).
  async function handleDistributeKey() {
    if (!distributeModel || !keyHasLinks) return
    const rawJobs = keyThemes.map(t => ({ key: t.id, buckets: themeChildren(t.id), links: [...themeLinks[t.id]] }))
    // Ссылки из «+ добавить ещё» прицепляем к первой ключевой теме (Почему).
    if (keyExtra.length && rawJobs.length) rawJobs[0].links = dedupConcat(rawJobs[0].links, keyExtra)
    const jobs = rawJobs.filter(j => j.links.length > 0)
    if (!jobs.length) return
    setDistributingKey(true)
    try {
      const results = await Promise.all(jobs.map(j => runDistr(j.buckets, j.links, false).catch(errResult)))
      const parts: Record<string, DistrPart> = {}
      const produced: EntriesState = {}
      jobs.forEach((j, i) => {
        parts[j.key] = results[i].part
        for (const [k, v] of Object.entries(results[i].entries)) produced[k] = [...(produced[k] ?? []), ...v]
      })
      const state: DistrState = { model: distributeModel, parts }
      setDistrKeyState(state)
      try { localStorage.setItem(lsKeyKey, JSON.stringify(state)) } catch {}
      const bucketIds = keyThemes.flatMap(t => themeChildren(t.id).map(s => s.id))
      const poolUrls = new Set<string>()
      jobs.forEach(j => j.links.forEach(l => { if (l.url) poolUrls.add(l.url) }))
      applyDistribution(bucketIds, produced, poolUrls)
    } catch (e) {
      console.error('distribute (key) error:', e)
    } finally {
      setDistributingKey(false)
    }
  }

  // Шаг 5: распределение Общих — один промпт (корзины = сами темы), затем пост-дедуп
  // против Главной/Почему: общие в приоритете, попавшие в них ссылки уходят из ключевых.
  async function handleDistributeGeneral() {
    if (!distributeModel || generalDistrPool.length === 0) return
    setDistributingGeneral(true)
    try {
      const { part, entries: produced } = await runDistr(generalThemes, generalDistrPool, true).catch(errResult)
      const state: DistrState = { model: distributeModel, parts: { __general: part } }
      setDistrGeneralState(state)
      try { localStorage.setItem(lsKeyGeneral, JSON.stringify(state)) } catch {}
      const pruneUrls = new Set<string>()
      Object.values(produced).forEach(list => list.forEach(e => { if (e.url) pruneUrls.add(e.url) }))
      const poolUrls = new Set<string>()
      generalDistrPool.forEach(l => { if (l.url) poolUrls.add(l.url) })
      applyDistribution(generalThemes.map(t => t.id), produced, poolUrls, pruneUrls)
    } catch (e) {
      console.error('distribute (general) error:', e)
    } finally {
      setDistributingGeneral(false)
    }
  }

  // Повтор раздачи только одной (упавшей) ключевой темы — успешные не трогаем.
  async function retryDistributeKeyPart(parentId: string) {
    if (!distributeModel || !distrKeyState || retryingPart) return
    const buckets = themeChildren(parentId)
    let links = [...(themeLinks[parentId] ?? [])]
    if (keyExtra.length && keyThemes[0]?.id === parentId) links = dedupConcat(links, keyExtra)
    if (!buckets.length || !links.length) return
    setRetryingPart(parentId)
    try {
      const { part, entries: produced } = await runDistr(buckets, links, false).catch(errResult)
      const state: DistrState = { model: distributeModel, parts: { ...distrKeyState.parts, [parentId]: part } }
      setDistrKeyState(state)
      try { localStorage.setItem(lsKeyKey, JSON.stringify(state)) } catch {}
      if (!part.data.error) {
        const poolUrls = new Set<string>()
        links.forEach(l => { if (l.url) poolUrls.add(l.url) })
        applyDistribution(buckets.map(b => b.id), produced, poolUrls)
      }
    } finally {
      setRetryingPart(null)
    }
  }

  // Повтор раздачи Общих (один запрос).
  async function retryDistributeGeneral() {
    if (!distributeModel || retryingPart || generalDistrPool.length === 0) return
    setRetryingPart('__general')
    try {
      const { part, entries: produced } = await runDistr(generalThemes, generalDistrPool, true).catch(errResult)
      const state: DistrState = { model: distributeModel, parts: { __general: part } }
      setDistrGeneralState(state)
      try { localStorage.setItem(lsKeyGeneral, JSON.stringify(state)) } catch {}
      if (!part.data.error) {
        const pruneUrls = new Set<string>()
        Object.values(produced).forEach(list => list.forEach(e => { if (e.url) pruneUrls.add(e.url) }))
        const poolUrls = new Set<string>()
        generalDistrPool.forEach(l => { if (l.url) poolUrls.add(l.url) })
        applyDistribution(generalThemes.map(t => t.id), produced, poolUrls, pruneUrls)
      }
    } finally {
      setRetryingPart(null)
    }
  }

  // ── helpers рендера сбора ───────────────────────────────────────────────────
  const goldCls = 'border-amber-400/50 text-amber-400 hover:text-amber-300 hover:border-amber-400/70'
  const activeRowCls = isDark ? 'bg-white/5' : 'bg-black/4'

  function renderCollect(themes: Theme[], step: string, setStep: (s: string) => void, collectStageKey: string) {
    return (
      <>
        <div className="flex flex-col gap-0.5 mb-2">
          {themes.map((t, themeIdx) => {
            const themeUrls = projectUrl ? getThemeUrls(t.id, projectUrl, projectName) : []
            const linksN = (batches[t.id] ?? []).reduce((s, b) => s + b.length, 0)
            const fcQ = themeFcQueries(t.id)
            const done = fcQ.length > 0
            const isActive = t.id === step
            const slotCls = 'w-12 h-[18px] flex items-center justify-center shrink-0'
            const btnInner = `inline-flex items-center justify-center gap-1 w-full h-full rounded border text-[10px] transition-colors`
            return (
              <div key={t.id} className={`flex items-center gap-1.5 px-1.5 py-1 rounded ${isActive ? activeRowCls : ''}`}>
                <button onClick={() => setStep(t.id)}
                  className={`text-[12px] font-medium text-left flex-1 min-w-0 truncate ${isActive ? nameCls : dimCls} hover:opacity-100`}>
                  {t.label}
                </button>
                <span className={`text-[10px] font-mono ${dimCls} w-8 text-right shrink-0`}>{linksN > 0 ? linksN : ''}</span>
                <div className={slotCls}>
                  {themeUrls.length > 0 && (
                    <button onClick={() => openWithDelay(themeUrls)}
                      title={`Открыть ${themeUrls.length} запросов`}
                      className={`${btnInner} ${btnCls}`}>
                      <ExternalLink size={9} />
                      <span>{themeUrls.length}</span>
                    </button>
                  )}
                </div>
                <div className={slotCls}>
                  {themeUrls.length > 0 && (
                    <button onClick={() => importFromExtension(t.id)}
                      title="Импорт из расширения (буфер)"
                      style={!stages[collectStageKey] ? { animationDelay: `${themeIdx * 0.35}s` } : undefined}
                      className={`${btnInner} ${btnCls} ${!stages[collectStageKey] ? 'ring-shimmer' : ''}`}>
                      <ClipboardPaste size={9} />
                    </button>
                  )}
                </div>
                <div className={slotCls}>
                  {themeUrls.length > 0 && (
                    <button onClick={async () => {
                        if (!window.confirm('Запустить Firecrawl? Это платная альтернатива импорту из расширения.')) return
                        runFirecrawl(t.id)
                      }}
                      onContextMenu={e => { if (e.ctrlKey && done) { e.preventDefault(); resetFirecrawl(t.id) } }}
                      disabled={fcLoading.has(t.id)}
                      title={done ? 'Firecrawl прогнан · Ctrl+ПКМ чтобы сбросить' : 'Firecrawl (платная альтернатива)'}
                      className={`${btnInner} disabled:opacity-50 opacity-40 hover:opacity-100 ${done ? goldCls : btnCls}`}>
                      {fcLoading.has(t.id) ? <Loader2 size={9} className="animate-spin" /> : <Bot size={9} />}
                    </button>
                  )}
                </div>
                <div className={slotCls}>
                  {done && (
                    <button onClick={() => setFcOverlay(t.id)}
                      title="Показать результаты Firecrawl"
                      className={`${btnInner} ${btnCls}`}>
                      <Eye size={9} />
                      <span>{fcQ.length}</span>
                    </button>
                  )}
                </div>
              </div>
            )
          })}
          {!themes.length && <span className={`text-[10px] ${dimCls} italic`}>нет тем</span>}
        </div>
        {step && (() => {
          const themeBatches = batches[step] ?? []
          return (
            <div className="mt-1">
              <input type="text" placeholder="вставить ссылки..."
                onPaste={e => handlePaste(step, e)}
                className={`w-full rounded-lg border px-2.5 py-1.5 text-[11px] font-mono outline-none transition-colors ${inputCls}`}
              />
              {themeBatches.length > 0 && (
                <div className="mt-2 flex flex-col gap-1">
                  {themeBatches.map((batch, i) => (
                    <BatchSpoiler key={i} batch={batch} idx={i} onDelete={() => deleteBatch(step, i)} cls={spoilerCls} />
                  ))}
                </div>
              )}
            </div>
          )
        })()}
      </>
    )
  }

  function renderPoolSummary(pool: Link[], extraKey: string) {
    return (
      <div className="mt-3">
        <span className={`text-[12px] font-medium ${nameCls} block mb-2`}>Все ссылки</span>
        {pool.length > 0 && <BatchSpoiler batch={pool} idx={-1} onDelete={() => {}} cls={spoilerCls} />}
        <input type="text" placeholder="+ добавить ещё..."
          onPaste={e => handlePaste(extraKey, e)}
          className={`w-full mt-2 rounded-lg border px-2.5 py-1.5 text-[11px] font-mono outline-none transition-colors ${inputCls}`}
        />
        {((batches as PipelineState)[extraKey] ?? []).map((batch, i) => (
          <BatchSpoiler key={i} batch={batch} idx={i} onDelete={() => deleteBatch(extraKey, i)} cls={spoilerCls} />
        ))}
      </div>
    )
  }

  function renderModelPicker() {
    if (!models.length) return null
    return (
      <div className="flex flex-wrap gap-1 mb-2">
        {models.map(m => (
          <button key={m.model_key}
            onClick={() => { setDistributeModel(m); try { localStorage.setItem(lsKeyModel, m.model_key) } catch {} }}
            className={`px-2 py-0.5 rounded border text-[9px] font-mono transition-colors ${
              distributeModel?.model_key === m.model_key
                ? isDark ? 'border-white/30 text-white/70 bg-white/5' : 'border-black/25 text-black/65 bg-black/4'
                : isDark ? 'border-white/10 text-white/30 hover:text-white/55' : 'border-black/8 text-black/25 hover:text-black/50'
            }`}>
            {m.label}
          </button>
        ))}
      </div>
    )
  }

  return (
    <>
      {showKeyOverlay && distrKeyState && (
        <DistrOverlay distr={distrKeyState} onClose={() => setShowKeyOverlay(false)}
          onRetry={retryDistributeKeyPart} retryingPart={retryingPart} />
      )}
      {showGeneralOverlay && distrGeneralState && (
        <DistrOverlay distr={distrGeneralState} onClose={() => setShowGeneralOverlay(false)}
          onRetry={() => retryDistributeGeneral()} retryingPart={retryingPart} />
      )}
      {fcOverlay && themeFcQueries(fcOverlay).length > 0 && (
        <FirecrawlOverlay parentLabel={getLabel(fcOverlay)} queries={themeFcQueries(fcOverlay)} onClose={() => setFcOverlay(null)} />
      )}
      {scrapeOverlay && themeScrapeItems(scrapeOverlay).length > 0 && (
        <ScrapeOverlay parentLabel={getLabel(scrapeOverlay)} items={themeScrapeItems(scrapeOverlay)}
          onClose={() => setScrapeOverlay(null)}
          onToggleExclude={toggleScrapeExclude}
          onRetry={(subtopicId, url) => runScrape(scrapeOverlay!, [{ subtopicId, url }])}
          onRemove={removeScrapeItem}
          retrying={scrapeLoading.has(scrapeOverlay)} />
      )}
      <div className="h-full overflow-y-auto py-5 px-5">
        <div className="flex flex-col">
          {pipelineStages.map((stage, idx) => {
            const isLast       = idx === pipelineStages.length - 1
            const isCollectKey = stage === '__collect_key'
            const isDistrKey   = stage === '__distr_key'
            const isSelectGen  = stage === '__select_general'
            const isCollectGen = stage === '__collect_general'
            const isDistrGen   = stage === '__distr_general'
            const isScrape     = stage === '__scrape'

            return (
              <div key={stage} className="flex gap-3">
                <div className="flex flex-col items-center" style={{ width: 20 }}>
                  <button
                    onClick={() => toggleStage(stage)}
                    title={stages[stage] ? 'Этап завершён · клик чтобы снять' : 'Отметить этап как завершённый'}
                    className={`w-5 h-5 rounded-full border flex items-center justify-center shrink-0 text-[9px] font-mono mt-0.5 transition-colors cursor-pointer ${
                      stages[stage]
                        ? 'border-amber-400/50 text-amber-400 hover:text-amber-300 hover:border-amber-400/70'
                        : dotOnCls
                    }`}>
                    {idx + 1}
                  </button>
                  {!isLast && <div className={`w-px flex-1 mt-1 mb-1 ${lineCls}`} style={{ minHeight: 24 }} />}
                </div>

                <div className="flex-1 min-w-0 pb-5">

                  {isCollectKey && (
                    <>
                      {renderCollect(keyThemes, keyTab, setKeyTab, '__collect_key')}
                      {renderPoolSummary(keyPool, '__extra')}
                    </>
                  )}

                  {isDistrKey && (
                    <>
                      <span className={`text-[12px] font-medium ${nameCls} block mb-2`}>Распределить Главная / Почему</span>
                      {renderModelPicker()}
                      <div className="flex items-center gap-2">
                        <button
                          onClick={handleDistributeKey}
                          disabled={distributingKey || !keyHasLinks || !distributeModel}
                          className={`flex items-center gap-2 px-3 py-1.5 rounded-lg border text-[11px] transition-colors disabled:opacity-35 disabled:cursor-not-allowed ${btnCls}`}>
                          {distributingKey ? <Loader2 size={12} className="animate-spin" /> : <Shuffle size={12} />}
                          {distributingKey ? 'Распределяю...' : 'Распределить'}
                        </button>
                        {distrKeyState && !distributingKey && (
                          <button onClick={() => setShowKeyOverlay(true)}
                            title={Object.values(distrKeyState.parts).some(p => p.data.error) ? 'Есть упавшие темы — открой и повтори' : undefined}
                            className={`flex items-center gap-1 px-2 py-1.5 rounded-lg border text-[11px] transition-colors ${
                              Object.values(distrKeyState.parts).some(p => p.data.error) ? 'border-red-400/50 text-red-400 hover:text-red-300' : btnCls}`}>
                            <ScanText size={12} />
                          </button>
                        )}
                      </div>
                    </>
                  )}

                  {isSelectGen && (
                    <>
                      <span className={`text-[12px] font-medium ${nameCls} block mb-2`}>
                        Общие темы <span className={`font-mono text-[10px] ${generalChosen === generalTarget ? 'text-amber-400' : dimCls}`}>{generalChosen}/{generalTarget}</span>
                      </span>
                      <div className="columns-2 gap-x-3 space-y-1.5 mt-1">
                        {generalSelectable.map(item => (
                          <button key={item.id} onClick={() => toggle(item.id)}
                            className="flex items-center gap-2 text-left group break-inside-avoid w-full">
                            <div className={`w-3 h-3 rounded-sm border shrink-0 transition-colors ${isDark ? 'border-white/20' : 'border-black/20'} ${
                              checks[item.id] ? (isDark ? 'bg-white/80 border-white/80' : 'bg-black/80 border-black/80') : ''}`} />
                            <span className={`text-[12px] leading-tight transition-opacity group-hover:opacity-80 ${
                              checks[item.id] ? nameCls : dimCls}`}>
                              {item.label}
                            </span>
                          </button>
                        ))}
                      </div>
                    </>
                  )}

                  {isCollectGen && (
                    generalThemes.length > 0 ? (
                      <>
                        {renderCollect(generalThemes, generalTab, setGeneralTab, '__collect_general')}
                        {renderPoolSummary(generalPool, '__extra_general')}
                      </>
                    ) : (
                      <span className={`text-[10px] ${dimCls} italic`}>выбери общие темы на шаге 3</span>
                    )
                  )}

                  {isDistrGen && (
                    <>
                      <span className={`text-[12px] font-medium ${nameCls} block mb-2`}>Распределить Общие</span>
                      {renderModelPicker()}
                      <div className="flex items-center gap-2">
                        <button
                          onClick={handleDistributeGeneral}
                          disabled={distributingGeneral || generalDistrPool.length === 0 || !distributeModel}
                          className={`flex items-center gap-2 px-3 py-1.5 rounded-lg border text-[11px] transition-colors disabled:opacity-35 disabled:cursor-not-allowed ${btnCls}`}>
                          {distributingGeneral ? <Loader2 size={12} className="animate-spin" /> : <Shuffle size={12} />}
                          {distributingGeneral ? 'Распределяю...' : 'Распределить'}
                        </button>
                        {distrGeneralState && !distributingGeneral && (
                          <button onClick={() => setShowGeneralOverlay(true)}
                            title={Object.values(distrGeneralState.parts).some(p => p.data.error) ? 'Раздача упала — открой и повтори' : undefined}
                            className={`flex items-center gap-1 px-2 py-1.5 rounded-lg border text-[11px] transition-colors ${
                              Object.values(distrGeneralState.parts).some(p => p.data.error) ? 'border-red-400/50 text-red-400 hover:text-red-300' : btnCls}`}>
                            <ScanText size={12} />
                          </button>
                        )}
                      </div>
                    </>
                  )}

                  {isScrape && (() => {
                    const totals = selectedThemes.reduce((acc, t) => {
                      themeScrapeItems(t.id).filter(i => !i.error && !i.excluded).forEach(i => {
                        acc.chars += processMarkdown(i.markdown ?? '').length
                        acc.tokens += i.tokens ?? 0
                      })
                      return acc
                    }, { chars: 0, tokens: 0 })
                    return (
                    <>
                      <span className={`text-[12px] font-medium ${nameCls} block mb-2`}>
                        Скрейп страниц (Firecrawl)
                        {totals.chars > 0 && (
                          <span className={`font-mono text-[10px] ${dimCls} ml-1.5`}>
                            · {(totals.chars / 1000).toFixed(1)}k / {(totals.tokens / 1000).toFixed(1)}k tok
                          </span>
                        )}
                      </span>
                      <div className="flex flex-col gap-1.5">
                        {selectedThemes.map(t => {
                          const allUrls = themeScrapeUrls(t.id)
                          if (!allUrls.length) return null
                          const scraped = themeScrapeItems(t.id)
                          const ok = scraped.filter(i => !i.error)
                          const errCount = scraped.length - ok.length
                          const active = ok.filter(i => !i.excluded)
                          const levels = active.map(i => sizeLevel(processMarkdown(i.markdown ?? '').length))
                          const okCount = levels.filter(l => l === 'ok').length
                          const warnCount = levels.filter(l => l === 'warn').length
                          const dangerCount = levels.filter(l => l === 'danger').length
                          const transferCount = active.length
                          const transferTokens = active.reduce((s, i) => s + (i.tokens ?? 0), 0)
                          const totalChars = active.reduce((s, i) => s + processMarkdown(i.markdown ?? '').length, 0)
                          const pending = allUrls.length - scraped.length
                          const loading = scrapeLoading.has(t.id)
                          const goldCls = 'border-amber-400/50 text-amber-400 hover:text-amber-300 hover:border-amber-400/70'
                          const eyeCls = dangerCount > 0
                            ? 'border-red-400/50 text-red-400 hover:text-red-300 hover:border-red-400/70'
                            : warnCount > 0
                              ? goldCls
                              : btnCls
                          return (
                            <div key={t.id} className="flex items-center gap-2 flex-wrap">
                              <span className={`text-[11px] ${nameCls} min-w-[80px]`}>{t.label}</span>
                              <button onClick={() => runScrape(t.id)}
                                onContextMenu={e => { if (e.ctrlKey && scraped.length) { e.preventDefault(); resetScrape(t.id) } }}
                                disabled={loading || pending === 0}
                                title={pending === 0 ? `Все ${allUrls.length} спарсены · Ctrl+ПКМ чтобы сбросить` : `Спарсить ${pending} новых из ${allUrls.length}`}
                                className={`flex items-center gap-1 px-1.5 py-0.5 rounded border text-[10px] transition-colors disabled:opacity-50 ${scraped.length ? goldCls : btnCls}`}>
                                {loading ? <Loader2 size={9} className="animate-spin" /> : <FileText size={9} />}
                                <span>{pending > 0 ? `+${pending}` : '✓'}</span>
                              </button>
                              {scraped.length > 0 && (
                                <>
                                  <button onClick={() => setScrapeOverlay(t.id)}
                                    className={`flex items-center gap-1 px-1.5 py-0.5 rounded border text-[10px] transition-colors ${eyeCls}`}
                                    title={`ok: ${okCount}, спорных (>${SIZE_WARN}): ${warnCount}, тяжёлых (>${SIZE_DANGER}): ${dangerCount}${errCount ? `, ошибок: ${errCount}` : ''}`}>
                                    <Eye size={9} />
                                    <span className="font-mono">
                                      <span className="text-emerald-400/90">{okCount}</span>
                                      <span className="opacity-50">/</span>
                                      <span className="text-amber-400/90">{warnCount}</span>
                                      <span className="opacity-50">/</span>
                                      <span className="text-red-400/90">{dangerCount}</span>
                                      {errCount > 0 && <span className="text-red-400/70"> ⚠{errCount}</span>}
                                    </span>
                                  </button>
                                  {errCount > 0 && (
                                    <button onClick={() => runScrape(t.id, themeScrapeErrors(t.id))}
                                      disabled={loading}
                                      title={`Повторить ${errCount} упавших`}
                                      className="flex items-center gap-1 px-1.5 py-0.5 rounded border text-[10px] transition-colors disabled:opacity-50 border-red-400/50 text-red-400 hover:text-red-300 hover:border-red-400/70">
                                      {loading ? <Loader2 size={9} className="animate-spin" /> : <RefreshCw size={9} />}
                                      <span>{errCount}</span>
                                    </button>
                                  )}
                                  {transferCount > 0 && (
                                    <button onClick={() => transferScrapeToEntries(t.id)}
                                      title={`Перенести ${transferCount} текстов`}
                                      className={`flex items-center gap-1 px-1.5 py-0.5 rounded border text-[10px] transition-colors ${btnCls}`}>
                                      <ArrowRight size={9} />
                                      <span>в текст ({transferCount})</span>
                                    </button>
                                  )}
                                  <span className={`text-[10px] font-mono ${dimCls}`} title={`${totalChars.toLocaleString()} chars / ${transferTokens.toLocaleString()} tokens`}>
                                    {(totalChars / 1000).toFixed(1)}k / {(transferTokens / 1000).toFixed(1)}k tok
                                  </span>
                                </>
                              )}
                            </div>
                          )
                        })}
                        {selectedThemes.every(t => themeScrapeUrls(t.id).length === 0) && (
                          <span className={`text-[10px] ${dimCls} italic`}>нет ссылок в подтемах — сначала распредели</span>
                        )}
                      </div>
                    </>
                    )
                  })()}
                </div>
              </div>
            )
          })}
        </div>
      </div>
    </>
  )
}
