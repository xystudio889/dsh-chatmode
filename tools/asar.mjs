#!/usr/bin/env node
/**
 * Minimal Electron ASAR reader used only for local investigation of the
 * installed Harness: `list <regex>` prints matching entry paths, `cat <path>`
 * writes one entry's bytes to stdout, `grep <regex> [pathPrefix]` prints
 * matching lines with entry paths.
 *
 * Usage: node tools/asar.mjs <asar> <command> [arg] [extra]
 */
import { openSync, readSync, closeSync, readFileSync } from 'node:fs'

function readHeader(file) {
  const fd = openSync(file, 'r')
  try {
    const head = Buffer.alloc(16)
    readSync(fd, head, 0, 16, 0)
    const headerSize = head.readUInt32LE(4)
    const pickle = Buffer.alloc(headerSize)
    readSync(fd, pickle, 0, headerSize, 8)
    const stringLength = pickle.readUInt32LE(4)
    const json = pickle.subarray(8, 8 + stringLength).toString('utf8')
    return { header: JSON.parse(json), base: 8 + headerSize }
  } finally {
    closeSync(fd)
  }
}

function walk(node, prefix, out) {
  for (const [name, child] of Object.entries(node.files ?? {})) {
    const path = prefix === '' ? name : `${prefix}/${name}`
    if (child.files !== undefined) walk(child, path, out)
    else out.push({ path, size: child.size, offset: child.offset, unpacked: child.unpacked === true })
  }
}

const [file, command, arg, extra] = process.argv.slice(2)
if (file === undefined || command === undefined) {
  console.error('usage: node tools/asar.mjs <asar> list|cat|grep <arg> [extra]')
  process.exit(2)
}
const { header, base } = readHeader(file)
const entries = []
walk(header, '', entries)

if (command === 'list') {
  const re = new RegExp(arg, 'u')
  for (const entry of entries) if (re.test(entry.path)) console.log(`${entry.size}\t${entry.path}`)
} else if (command === 'cat') {
  const entry = entries.find((candidate) => candidate.path === arg)
  if (entry === undefined) {
    console.error(`no entry: ${arg}`)
    process.exit(1)
  }
  if (entry.unpacked === true) {
    console.error(`unpacked entry, read from disk: ${arg}`)
    process.exit(3)
  }
  const fd = openSync(file, 'r')
  try {
    const buffer = Buffer.alloc(entry.size)
    readSync(fd, buffer, 0, entry.size, base + Number(entry.offset))
    process.stdout.write(buffer)
  } finally {
    closeSync(fd)
  }
} else if (command === 'grep') {
  const re = new RegExp(arg, 'u')
  const prefix = extra ?? ''
  const fd = openSync(file, 'r')
  try {
    for (const entry of entries) {
      if (entry.unpacked === true || !entry.path.startsWith(prefix)) continue
      if (!/\.(?:js|mjs|cjs|ts|json|yml|yaml|md)$/u.test(entry.path)) continue
      if (entry.size > 4 * 1024 * 1024) continue
      const buffer = Buffer.alloc(entry.size)
      readSync(fd, buffer, 0, entry.size, base + Number(entry.offset))
      const text = buffer.toString('utf8')
      if (!re.test(text)) continue
      const lines = text.split('\n')
      lines.forEach((line, index) => {
        if (re.test(line)) console.log(`${entry.path}:${index + 1}: ${line.trim().slice(0, 300)}`)
      })
    }
  } finally {
    closeSync(fd)
  }
} else {
  console.error(`unknown command: ${command}`)
  process.exit(2)
}
