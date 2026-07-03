// Папочная логика курса: дерево файлов и сборка Markdown с оглавлением.
// Без зависимостей от Electron — чтобы можно было тестировать напрямую.
const path = require('node:path')
const fs = require('node:fs')

const MEDIA_EXT = ['mp3', 'wav', 'm4a', 'aac', 'ogg', 'oga', 'opus', 'flac',
  'mp4', 'mov', 'm4v', 'webm', 'mkv', 'wma', 'aiff', 'aif']

// Натуральная сортировка: "2" раньше "10", "5-6" между 5 и 7.
function natCompare(a, b) {
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' })
}

// Строит дерево папки. В каждом узле entries отсортированы натурально,
// папки и файлы вперемешку — чтобы сохранить реальный порядок курса.
function buildTree(dir) {
  const node = { entries: [] }
  let ents
  try {
    ents = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return node
  }
  ents = ents
    .filter((e) => !e.name.startsWith('.'))
    .sort((a, b) => natCompare(a.name, b.name))
  for (const e of ents) {
    const abs = path.join(dir, e.name)
    if (e.isDirectory()) {
      node.entries.push({ type: 'dir', name: e.name, abs, node: buildTree(abs) })
    } else {
      const ext = path.extname(e.name).slice(1).toLowerCase()
      node.entries.push({
        type: 'file',
        name: e.name,
        abs,
        isMedia: MEDIA_EXT.includes(ext),
      })
    }
  }
  return node
}

// Плоский список медиафайлов в порядке обхода (для распознавания).
function collectMedia(node, out = []) {
  for (const e of node.entries) {
    if (e.type === 'dir') collectMedia(e.node, out)
    else if (e.isMedia) out.push(e.abs)
  }
  return out
}

// Есть ли в поддереве хоть какой-то файл (чтобы не показывать пустые папки).
function nodeHasFiles(node) {
  return node.entries.some(
    (e) => e.type === 'file' || (e.type === 'dir' && nodeHasFiles(e.node)),
  )
}

// Собирает единый Markdown курса с оглавлением по структуре папок.
// results: Map<absPath, { text, srt, error? }>
function buildCourseMarkdown(root, courseName, tree, results) {
  let idc = 0
  const nextId = () => 's' + ++idc
  const toc = []
  const body = []
  const stripExt = (n) => n.replace(/\.[^.]+$/, '')

  function render(node, depth) {
    for (const e of node.entries) {
      if (e.type === 'dir') {
        if (!nodeHasFiles(e.node)) continue // пропускаем пустые папки
        const id = nextId()
        const level = Math.min(depth + 2, 6)
        toc.push(`${'  '.repeat(depth)}- [📁 ${e.name}](#${id})`)
        body.push(`\n<a id="${id}"></a>\n\n${'#'.repeat(level)} 📁 ${e.name}\n`)
        render(e.node, depth + 1)
      } else if (e.isMedia) {
        const id = nextId()
        const level = Math.min(depth + 2, 6)
        const title = stripExt(e.name)
        toc.push(`${'  '.repeat(depth)}- [${title}](#${id})`)
        const r = results.get(e.abs) || {}
        body.push(`\n<a id="${id}"></a>\n\n${'#'.repeat(level)} ${title}\n`)
        body.push(`\n*Файл: \`${path.relative(root, e.abs)}\`*\n`)
        if (r.error) body.push(`\n> ⚠️ Не удалось распознать: ${r.error}\n`)
        else if (!r.text) body.push(`\n> _(пусто)_\n`)
        else body.push(`\n${r.text}\n`)
      } else {
        // Не медиа (PDF, DOCX и т.п.) — материал курса, показываем ссылкой.
        body.push(`\n> 📎 Материал: \`${path.relative(root, e.abs)}\`\n`)
      }
    }
  }
  render(tree, 0)

  const mediaCount = collectMedia(tree).length
  return (
    `# ${courseName}\n\n` +
    `> Транскрипция курса · аудио/видео: ${mediaCount} · создано в Транскрибере\n\n` +
    `## Оглавление\n\n${toc.join('\n')}\n\n---\n` +
    body.join('\n') +
    '\n'
  )
}

module.exports = {
  MEDIA_EXT,
  natCompare,
  buildTree,
  collectMedia,
  buildCourseMarkdown,
}
