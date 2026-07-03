// Папочная логика курса: обход медиафайлов и сборка Markdown с оглавлением.
// Без зависимостей от Electron — чтобы можно было тестировать напрямую.
const path = require('node:path')
const fs = require('node:fs')

const MEDIA_EXT = ['mp3', 'wav', 'm4a', 'aac', 'ogg', 'oga', 'opus', 'flac',
  'mp4', 'mov', 'm4v', 'webm', 'mkv', 'wma', 'aiff', 'aif']

// Натуральная сортировка: "2" раньше "10".
function natCompare(a, b) {
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' })
}

// Рекурсивно собирает медиафайлы, сохраняя порядок и структуру папок.
function walkMedia(dir) {
  const out = []
  let entries
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return out
  }
  entries.sort((a, b) => natCompare(a.name, b.name))
  for (const ent of entries) {
    if (ent.name.startsWith('.')) continue
    const full = path.join(dir, ent.name)
    if (ent.isDirectory()) out.push(...walkMedia(full))
    else {
      const ext = path.extname(ent.name).slice(1).toLowerCase()
      if (MEDIA_EXT.includes(ext)) out.push(full)
    }
  }
  return out
}

// Собирает единый Markdown курса с оглавлением по структуре папок.
// results: Map<absPath, { text, srt, error? }>
function buildCourseMarkdown(root, courseName, files, results) {
  const tree = { dirs: new Map(), files: [] }
  for (const abs of files) {
    const parts = path.relative(root, abs).split(path.sep)
    let node = tree
    for (let i = 0; i < parts.length - 1; i++) {
      const p = parts[i]
      if (!node.dirs.has(p)) node.dirs.set(p, { dirs: new Map(), files: [] })
      node = node.dirs.get(p)
    }
    node.files.push({ name: parts[parts.length - 1], abs })
  }

  let idc = 0
  const nextId = () => 's' + ++idc
  const toc = []
  const body = []
  const stripExt = (n) => n.replace(/\.[^.]+$/, '')

  function render(node, depth) {
    for (const name of [...node.dirs.keys()].sort(natCompare)) {
      const id = nextId()
      const level = Math.min(depth + 2, 6)
      toc.push(`${'  '.repeat(depth)}- [📁 ${name}](#${id})`)
      body.push(`\n<a id="${id}"></a>\n\n${'#'.repeat(level)} 📁 ${name}\n`)
      render(node.dirs.get(name), depth + 1)
    }
    for (const f of node.files.sort((a, b) => natCompare(a.name, b.name))) {
      const id = nextId()
      const level = Math.min(depth + 2, 6)
      const title = stripExt(f.name)
      toc.push(`${'  '.repeat(depth)}- [${title}](#${id})`)
      const r = results.get(f.abs) || {}
      body.push(`\n<a id="${id}"></a>\n\n${'#'.repeat(level)} ${title}\n`)
      body.push(`\n*Файл: \`${path.relative(root, f.abs)}\`*\n`)
      if (r.error) body.push(`\n> ⚠️ Не удалось распознать: ${r.error}\n`)
      else if (!r.text) body.push(`\n> _(пусто)_\n`)
      else body.push(`\n${r.text}\n`)
    }
  }
  render(tree, 0)

  return (
    `# ${courseName}\n\n` +
    `> Транскрипция курса · файлов: ${files.length} · создано в Транскрибере\n\n` +
    `## Оглавление\n\n${toc.join('\n')}\n\n---\n` +
    body.join('\n') +
    '\n'
  )
}

module.exports = { MEDIA_EXT, natCompare, walkMedia, buildCourseMarkdown }
