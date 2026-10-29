// Rejects compiled `:has()` rules that make Blink restyle the anchor's whole subtree on any
// mutation (#34312). Checks Tailwind's real output, so every spelling of a utility is covered.
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import process from 'node:process'
import { pathToFileURL } from 'node:url'

const TAILWIND_ENTRY = 'src/renderer/src/assets/main.css'
// Plain pathspec `*` also matches `/`; files main.css imports are rescanned harmlessly.
const PLAIN_CSS = ['src/renderer/*.css', 'src/shared/*.css']
const SPECIFIC = new Set(['class', 'id', 'attribute'])
const SIBLING = new Set(['next-sibling', 'later-sibling'])

// Tailwind's own packages, resolved through the direct @tailwindcss/vite dependency.
function loadToolchain(root) {
  const fromVite = createRequire(
    createRequire(path.join(root, 'package.json')).resolve('@tailwindcss/vite')
  )
  const nodePath = fromVite.resolve('@tailwindcss/node')
  return {
    tailwind: fromVite(nodePath),
    oxide: fromVite('@tailwindcss/oxide'),
    lightningcss: createRequire(nodePath)('lightningcss')
  }
}

function compounds(selector) {
  const result = [[]]
  for (const component of selector) {
    if (component.type === 'combinator') {
      result.push([])
    } else {
      result.at(-1).push(component)
    }
  }
  return result.filter((compound) => compound.length > 0)
}

// Blink's descendant invalidation set keys on the subject's class/id/attribute; without one it is the whole subtree.
function isBroad(compound) {
  return !compound.some((component) => SPECIFIC.has(component.type))
}

// `:has(+ x)` / `:has(~ x)` only look at siblings; an argument without a combinator is a descendant.
function isSiblingOnly(relativeSelectors) {
  return relativeSelectors.every((selector) => {
    const combinators = selector.filter((component) => component.type === 'combinator')
    return combinators.length > 0 && combinators.every(({ value }) => SIBLING.has(value))
  })
}

// `outerSubject` is the compound that a match of this selector's own subject still feeds into, or null.
function visitSelector(selector, outerSubject, report) {
  const parts = compounds(selector)
  parts.forEach((compound, index) => {
    const subject = index === parts.length - 1 ? outerSubject : parts.at(-1)
    for (const component of compound) {
      if (component.type !== 'pseudo-class' || !component.selectors) {
        continue
      }
      if (component.kind === 'has') {
        if (subject && isBroad(subject) && !isSiblingOnly(component.selectors)) {
          report()
        }
        component.selectors.forEach((nested) => visitSelector(nested, null, report))
      } else {
        // :is()/:where()/:not() arguments match this same element, so they keep its context.
        component.selectors.forEach((nested) => visitSelector(nested, subject, report))
      }
    }
  })
}

// Top-level commas only; escapes and brackets in Tailwind class names stay intact.
function splitSelectorList(text) {
  const parts = ['']
  let depth = 0
  for (let index = 0; index < text.length; index++) {
    const char = text[index]
    if (char === '\\') {
      parts[parts.length - 1] += text.slice(index, index + 2)
      index++
      continue
    }
    depth += '(['.includes(char) ? 1 : ')]'.includes(char) ? -1 : 0
    if (char === ',' && depth === 0) {
      parts.push('')
    } else {
      parts[parts.length - 1] += char
    }
  }
  return parts.map((part) => part.trim().replace(/\s+/g, ' '))
}

/** Selectors whose non-subject `:has()` invalidates a whole subtree; nesting is lowered first. */
export function findHasRestyleProblems(css, { lightningcss } = loadToolchain(process.cwd())) {
  const flat = lightningcss
    .transform({
      filename: 'input.css',
      code: Buffer.from(css),
      include: lightningcss.Features.Nesting,
      errorRecovery: true
    })
    .code.toString()
  const lines = flat.split('\n')
  const problems = new Set()
  lightningcss.transform({
    filename: 'flat.css',
    code: Buffer.from(flat),
    errorRecovery: true,
    visitor: {
      Rule: {
        style(rule) {
          const { line, column } = rule.value.loc
          const rest = lines
            .slice(line)
            .join('\n')
            .slice(column - 1)
          const texts = splitSelectorList(rest.slice(0, rest.indexOf('{')))
          rule.value.selectors.forEach((selector, index) =>
            visitSelector(selector, null, () => problems.add(texts[index] ?? texts.join(', ')))
          )
        }
      }
    }
  })
  return [...problems]
}

async function compileTailwind(root, { tailwind, oxide }) {
  const base = path.join(root, path.dirname(TAILWIND_ENTRY))
  const compiler = await tailwind.compile(readFileSync(path.join(root, TAILWIND_ENTRY), 'utf8'), {
    base,
    onDependency() {}
  })
  const detected =
    compiler.root === 'none'
      ? []
      : compiler.root === null
        ? [{ base: path.join(root, 'src/renderer'), pattern: '**/*', negated: false }]
        : [{ ...compiler.root, negated: false }]
  const scanner = new oxide.Scanner({ sources: [...detected, ...compiler.sources] })
  return compiler.build(scanner.scan())
}

export async function main(root = process.cwd()) {
  const toolchain = loadToolchain(root)
  const plainFiles = execFileSync('git', ['ls-files', '-z', '--', ...PLAIN_CSS], {
    cwd: root,
    encoding: 'utf8'
  })
    .split('\0')
    .filter((file) => file && file !== TAILWIND_ENTRY)
  const sources = [
    { name: `${TAILWIND_ENTRY} (compiled)`, css: await compileTailwind(root, toolchain) },
    ...plainFiles.map((file) => ({ name: file, css: readFileSync(path.join(root, file), 'utf8') }))
  ]
  const findings = sources.flatMap(({ name, css }) =>
    findHasRestyleProblems(css, toolchain).map((selector) => ({ name, selector }))
  )
  if (findings.length > 0) {
    console.error(`:has() restyle-scope check failed with ${findings.length} finding(s):`)
    for (const { name, selector } of findings) {
      console.error(`- ${name}: ${selector}`)
    }
    console.error(
      'A :has() followed by a combinator into a subject with no class, id or attribute makes ' +
        'Blink restyle the whole subtree on any mutation (#34312). Give the subject a class, e.g. ' +
        "[[class~='group/x']:has(…)_&]:… instead of group-has-*."
    )
    return 1
  }
  console.log(`:has() restyle-scope check passed (${sources.length} stylesheets).`)
  return 0
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(await main())
}
