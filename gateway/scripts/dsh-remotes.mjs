#!/usr/bin/env node
// Lists the Remote endpoints of one or more DSH installs: each endpoint's mode and the
// wire names of its arguments, with the top-level fields of object arguments. The
// gateway's session rules are checked against this list (test/fixtures/dsh-remotes.json),
// so a DSH upgrade that adds a method without a rule fails the tests.
//
//   node scripts/dsh-remotes.mjs <node_modules/@deepseek-ai> [...] > test/fixtures/dsh-remotes.json
//
// It reads the generated descriptors (lib/typert.host.js) of each package; it changes nothing.
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const WRAPPERS = new Set(['ZodReadonly', 'readonly', 'ZodOptional', 'optional', 'ZodNullable', 'nullable', 'ZodLazy', 'lazy', 'ZodEffects', 'pipe'])

function unwrap(schema) {
  for (let depth = 0; depth < 10 && schema; depth += 1) {
    const def = schema._def ?? schema.def
    if (!WRAPPERS.has(def?.typeName ?? def?.type)) break
    schema = def.innerType ?? def.schema ?? (typeof def.getter === 'function' ? def.getter() : undefined) ?? def.in
  }
  return schema
}

function fieldsOf(schema) {
  schema = unwrap(schema)
  if (!schema) return []
  const shape = typeof schema.shape === 'function' ? schema.shape() : schema.shape
  if (shape && typeof shape === 'object') return Object.keys(shape)
  const options = schema.options ?? schema._def?.options ?? schema.def?.options
  return Array.isArray(options) ? [...new Set(options.flatMap(fieldsOf))] : []
}

const endpoints = {}
const versions = []
for (const root of process.argv.slice(2)) {
  versions.push(JSON.parse(readFileSync(join(root, 'dsh', 'package.json'), 'utf8')).version)
  for (const pkg of readdirSync(root).sort()) {
    const file = join(root, pkg, 'lib', 'typert.host.js')
    if (!existsSync(file)) continue
    const { TYPERT } = await import(pathToFileURL(file).href)
    for (const [key, descriptor] of Object.entries(TYPERT?.invocations ?? {})) {
      const name = descriptor.namespace ? `${descriptor.namespace}/${descriptor.method}` : key
      const entry = (endpoints[name] ??= { stream: descriptor.mode === 'stream', args: {} })
      for (const parameter of descriptor.parameters ?? []) {
        let fields = []
        try {
          fields = fieldsOf((parameter.strictCodec ?? parameter.codec)?.create?.())
        } catch {}
        const wire = parameter.wire ?? parameter.name
        entry.args[wire] = [...new Set([...(entry.args[wire] ?? []), ...fields])].sort()
      }
    }
  }
}

const sorted = Object.fromEntries(Object.keys(endpoints).sort().map(name => [name, endpoints[name]]))
console.log(JSON.stringify({ versions, endpoints: sorted }, null, 1))
