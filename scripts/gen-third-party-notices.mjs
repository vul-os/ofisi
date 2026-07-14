#!/usr/bin/env node
// Generates a third-party notices file from the ACTUAL dependency graph.
//
// WHY THIS EXISTS
// ---------------
// MIT, BSD, ISC, Apache-2.0 and OFL-1.1 all require that the copyright notice
// and the licence text travel with every copy of the software. A JS bundle
// served to a browser is a copy; so is a Go binary we ship or host. Apache-2.0
// section 4(d) goes further: any NOTICE file the dependency ships must be
// propagated too.
//
// The file this script writes is what discharges those obligations. It is
// GENERATED, never hand-maintained -- a hand-written list is wrong the day the
// next dependency lands, which is exactly how such lists go stale.
//
// SOURCES OF TRUTH (both are real dependency-graph tools, not guesses):
//   npm -> license-checker-rseidelsohn --production   (a devDependency here)
//   Go  -> github.com/google/go-licenses              (resolved at run time)
//
// The npm and Go graphs are written to SEPARATE files on purpose: they are
// produced by different toolchains in different CI jobs, and a job that has
// node but no Go must never be able to overwrite the Go notices with a file
// that silently omits them.
//
// Usage:
//   node scripts/gen-third-party-notices.mjs --out THIRD-PARTY-NOTICES.txt \
//        [--npm-start .] [--title "..."]
//   node scripts/gen-third-party-notices.mjs --no-npm --go-dir . \
//        --out THIRD-PARTY-NOTICES-GO.txt [--tolerate-missing-toolchain]
//
// Exits non-zero if a requested section cannot be enumerated: an incomplete
// notices file is worse than a loud failure, because it under-reports what we
// ship without saying so. The one exception is --tolerate-missing-toolchain,
// used on the frontend build path: if the Go toolchain is not present there it
// warns loudly and leaves the committed Go notices file untouched (that file is
// complete; it just cannot be refreshed without Go).

import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const GO_TPL = join(HERE, 'go-licenses.json.tpl')
const GO_LICENSES_VERSION = 'v1.6.0'

const RULE = '='.repeat(78)
const THIN = '-'.repeat(78)

function parseArgs(argv) {
  const opts = { out: [], npmStart: '.', npm: true, goDir: null, goPackages: './...', title: null, tolerate: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--out') opts.out.push(argv[++i])
    else if (a === '--npm-start') opts.npmStart = argv[++i]
    else if (a === '--no-npm') opts.npm = false
    else if (a === '--go-dir') opts.goDir = argv[++i]
    else if (a === '--go-packages') opts.goPackages = argv[++i]
    else if (a === '--title') opts.title = argv[++i]
    else if (a === '--tolerate-missing-toolchain') opts.tolerate = true
    else throw new Error(`unknown argument: ${a}`)
  }
  if (!opts.out.length) throw new Error('--out is required')
  return opts
}

// Read a licence/NOTICE file. Returns null -- never a lie -- when absent.
function readIfPresent(path) {
  try {
    if (!path || !existsSync(path)) return null
    const text = readFileSync(path, 'utf8').trim()
    return text.length ? text : null
  } catch {
    return null
  }
}

// Apache-2.0 section 4(d): a NOTICE file shipped by a dependency must travel
// with every distribution of that dependency. Look for one in the package root.
const NOTICE_NAMES = ['NOTICE', 'NOTICE.txt', 'NOTICE.md', 'NOTICES', 'NOTICE.TXT', 'notice.txt']
function findNotice(pkgDir) {
  if (!pkgDir) return null
  for (const n of NOTICE_NAMES) {
    const t = readIfPresent(join(pkgDir, n))
    if (t) return t
  }
  return null
}

// ---------------------------------------------------------------- npm section

function collectNpm(startDir) {
  const start = resolve(startDir)
  const bin = join(start, 'node_modules', '.bin', 'license-checker-rseidelsohn')
  if (!existsSync(bin)) {
    throw new Error(
      `license-checker-rseidelsohn not found at ${bin}. It is a devDependency ` +
        'of this package -- run `npm install` first.',
    )
  }
  const json = execFileSync(bin, ['--production', '--json', '--start', start], {
    encoding: 'utf8',
    maxBuffer: 512 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'inherit'],
  })
  const data = JSON.parse(json)

  let selfName = null
  try {
    selfName = JSON.parse(readFileSync(join(start, 'package.json'), 'utf8')).name
  } catch {
    /* no package.json name -- treat everything as third party */
  }

  const pkgs = []
  for (const [key, v] of Object.entries(data)) {
    const at = key.lastIndexOf('@')
    const name = key.slice(0, at)
    const version = key.slice(at + 1)
    if (name === selfName) continue // we are not a third party to ourselves
    pkgs.push({
      name,
      version,
      license: v.licenses || 'UNKNOWN',
      repository: v.repository || null,
      publisher: v.publisher || null,
      text: readIfPresent(v.licenseFile),
      notice: findNotice(v.path),
    })
  }
  pkgs.sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version))
  return pkgs
}

// ----------------------------------------------------------------- Go section

// go-licenses is a build-time tool, deliberately NOT a module dependency: it
// drags in cobra/klog/go-git and has no business in our go.mod. Resolve it from
// GOPATH/bin or PATH, and fall back to running it straight from its module.
function goLicensesArgv() {
  let gopath = ''
  try {
    gopath = execFileSync('go', ['env', 'GOPATH'], { encoding: 'utf8' }).trim()
  } catch {
    throw new Error('the `go` toolchain is not on PATH')
  }
  const local = join(gopath, 'bin', 'go-licenses')
  if (existsSync(local)) return [local]
  try {
    execFileSync('which', ['go-licenses'], { stdio: 'ignore' })
    return ['go-licenses']
  } catch {
    /* not installed -- run it from the module instead */
  }
  return ['go', 'run', `github.com/google/go-licenses@${GO_LICENSES_VERSION}`]
}

function runGoLicenses(argv, cwd, env) {
  return execFileSync(argv[0], [...argv.slice(1), 'report', '--template', GO_TPL, './...'], {
    cwd,
    encoding: 'utf8',
    maxBuffer: 512 * 1024 * 1024,
    // go-licenses is chatty on stderr (klog); capture it so a failure can quote it.
    stdio: ['ignore', 'pipe', 'pipe'],
    env,
  })
}

function collectGo(goDir, goPackages) {
  const dir = resolve(goDir)
  if (!existsSync(join(dir, 'go.mod'))) throw new Error(`no go.mod in ${dir}`)
  if (!existsSync(GO_TPL)) throw new Error(`missing template: ${GO_TPL}`)

  const argv = goLicensesArgv()
  // GOOS is pinned to the platform we actually ship (Linux containers) so the
  // module set does not change with the developer's laptop, and GOTOOLCHAIN is
  // pinned to `local` because go-licenses cannot classify the standard library
  // when GOROOT points into a downloaded toolchain in the module cache
  // (it reports "package X does not have module info" and dies).
  const base = { ...process.env, GOOS: 'linux' }
  let raw
  try {
    raw = runGoLicenses(argv, dir, { ...base, GOTOOLCHAIN: 'local' })
  } catch (localErr) {
    try {
      raw = runGoLicenses(argv, dir, base)
    } catch (err) {
      const detail = String(err.stderr || localErr.stderr || err.message)
        .split('\n')
        .filter((l) => l.startsWith('F') || l.startsWith('E') || l.includes('error'))
        .slice(-6)
        .join('\n')
      throw new Error(
        `go-licenses failed in ${dir}.\nInstall it with:\n` +
          `  go install github.com/google/go-licenses@${GO_LICENSES_VERSION}\n` +
          (detail ? `\ngo-licenses said:\n${detail}\n` : ''),
      )
    }
  }

  const start = raw.indexOf('[')
  if (start < 0) throw new Error('go-licenses produced no JSON output')
  const mods = JSON.parse(raw.slice(start))

  const selfMod = readFileSync(join(dir, 'go.mod'), 'utf8').match(/^module\s+(\S+)/m)?.[1]
  const out = []
  for (const m of mods) {
    if (!m.name || m.name === selfMod || m.name.startsWith(`${selfMod}/`)) continue
    out.push({
      name: m.name,
      version: m.version || '(version not reported by the module graph)',
      license: m.license || 'UNKNOWN',
      repository: m.url || null,
      publisher: null,
      text: readIfPresent(m.path),
      // Go modules put NOTICE beside LICENSE at the module (or package) root.
      notice: m.path ? findNotice(dirname(m.path)) : null,
    })
  }
  out.sort((a, b) => a.name.localeCompare(b.name))
  return out
}

// --------------------------------------------------------------------- render

function renderComponent(c, ecosystem) {
  const lines = [RULE, `${c.name}  ${c.version}`, `Licence declared by the component: ${c.license}`]
  if (c.repository) lines.push(`Source: ${c.repository}`)
  if (c.publisher) lines.push(`Publisher: ${c.publisher}`)
  lines.push(`Ecosystem: ${ecosystem}`, THIN)
  if (c.text) {
    lines.push(c.text)
  } else {
    lines.push(
      'NO LICENCE TEXT IS SHIPPED INSIDE THE DISTRIBUTED PACKAGE.',
      `The package declares "${c.license}" but carries no licence file.`,
      c.repository
        ? `Obtain the licence text from the upstream project: ${c.repository}`
        : 'Obtain the licence text from the upstream project.',
    )
  }
  if (c.notice) {
    lines.push(
      '',
      THIN,
      'NOTICE file shipped by this component, reproduced as required by',
      'Apache License 2.0 section 4(d):',
      THIN,
      c.notice,
    )
  }
  lines.push('')
  return lines.join('\n')
}

function tally(pkgs) {
  const t = {}
  for (const p of pkgs) t[p.license] = (t[p.license] || 0) + 1
  return Object.entries(t)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([l, n]) => `    ${String(n).padStart(4)}  ${l}`)
}

function render(components, { title, ecosystem, tool }) {
  const missing = components.filter((c) => !c.text)
  const notices = components.filter((c) => c.notice)

  const head = [
    RULE,
    `THIRD-PARTY NOTICES -- ${title}`,
    RULE,
    '',
    "This software's production dependency graph contains the third-party",
    'components listed below: they are bundled into what we ship, or required by',
    'it at run time. Each entry gives the component name, the version resolved in',
    'that graph, the licence the component declares, and that component\'s licence',
    'text exactly as the component ships it. Where a component ships a NOTICE',
    'file, the NOTICE is reproduced too, as Apache License 2.0 section 4(d)',
    'requires.',
    '',
    'These are the licences of the third-party components. They are not the',
    "licence of this software: that one is in the LICENSE file at the root of",
    'this repository.',
    '',
    'GENERATED FILE -- DO NOT EDIT BY HAND.',
    `Produced by scripts/gen-third-party-notices.mjs from the real ${ecosystem}`,
    `dependency graph, via ${tool}.`,
    'A hand-maintained list would be wrong the day the next dependency lands, so',
    'this one is regenerated from the graph instead.',
    '',
    THIN,
    'SUMMARY',
    THIN,
    `Components: ${components.length}`,
    ...tally(components),
    '',
    `Components reproducing an upstream NOTICE file: ${notices.length}`,
    `Components that ship no licence text of their own: ${missing.length}`,
    ...(missing.length
      ? [
          '',
          'The components below declare a licence but ship no licence file inside',
          'the distributed package. They are listed in full in the body of this',
          'file with a pointer upstream. Nothing is being omitted quietly:',
          ...missing.map((c) => `    ${c.name}@${c.version} (${c.license})`),
        ]
      : []),
    '',
    '',
    RULE,
    `COMPONENTS (${components.length})`,
    RULE,
    '',
  ].join('\n')

  return head + components.map((c) => renderComponent(c, ecosystem)).join('\n') + '\n'
}

function write(outs, content) {
  for (const o of outs) {
    const p = resolve(o)
    mkdirSync(dirname(p), { recursive: true })
    writeFileSync(p, content)
    console.log(`third-party notices -> ${o}`)
  }
}

function main() {
  const a = parseArgs(process.argv.slice(2))
  const title = a.title || 'this software'

  if (a.npm && !a.goDir) {
    const npm = collectNpm(a.npmStart)
    if (!npm.length) throw new Error('the npm production graph came back empty -- refusing to write an empty notices file')
    write(a.out, render(npm, { title, ecosystem: 'npm', tool: 'license-checker-rseidelsohn --production' }))
    summarise(npm)
    return
  }

  if (!a.npm && a.goDir) {
    let go
    try {
      go = collectGo(a.goDir, a.goPackages)
    } catch (err) {
      if (!a.tolerate) throw err
      console.warn(
        `\n  !! Go third-party notices NOT refreshed: ${err.message.split('\n')[0]}\n` +
          '  !! The committed Go notices file is being left as it is. It is complete,\n' +
          '  !! but it will go stale if go.mod changed. Regenerate it with Go on PATH:\n' +
          '  !!     npm run notices:go\n',
      )
      return
    }
    if (!go.length) throw new Error('the Go module graph came back empty -- refusing to write an empty notices file')
    write(a.out, render(go, { title, ecosystem: 'Go', tool: `github.com/google/go-licenses@${GO_LICENSES_VERSION}` }))
    summarise(go)
    return
  }

  throw new Error('pass either an npm graph (--npm-start) or a Go graph (--no-npm --go-dir), not both')
}

function summarise(components) {
  const missing = components.filter((c) => !c.text).length
  const notices = components.filter((c) => c.notice).length
  console.log(
    `  ${components.length} component(s), ${notices} upstream NOTICE file(s) reproduced` +
      (missing ? `, ${missing} shipping no licence text` : ''),
  )
  if (missing) {
    console.warn(`  warning: ${missing} component(s) ship no licence text; each is named in the notices file with a pointer upstream.`)
  }
}

try {
  main()
} catch (err) {
  console.error(`gen-third-party-notices: ${err.message}`)
  process.exit(1)
}
