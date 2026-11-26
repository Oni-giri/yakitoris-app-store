#!/usr/bin/env node
// Resolve an image tag to a pinned, multi-arch reference for docker-compose.yml.
//
// Usage:
//   node resolve-image.mjs <image>:<tag> [<image>:<tag> ...] [--allow-single-arch]
//
// Prints one pinned reference per line on stdout (paste it into `image:`), and
// the platforms it covers on stderr.
// Exits 1 if any image is missing, private, not a multi-arch index, or lacks
// linux/amd64 or linux/arm64 (unless --allow-single-arch, which still warns).
//
// Uses the registry HTTP API anonymously (Docker Hub, ghcr.io, quay.io, lscr.io,
// gcr.io, and other OCI registries with bearer-token auth). No Docker needed.

import process from 'node:process'

const INDEX_TYPES = ['application/vnd.oci.image.index.v1+json', 'application/vnd.docker.distribution.manifest.list.v2+json']
const SINGLE_TYPES = ['application/vnd.oci.image.manifest.v1+json', 'application/vnd.docker.distribution.manifest.v2+json']
const REQUIRED = ['linux/amd64', 'linux/arm64']
const TIMEOUT_MS = 20_000 // registries normally answer in < 2 s; allow slow mirrors

function parseRef(input) {
	const ref = input.replace(/@sha256:[a-f0-9]{64}$/i, '')
	const m = ref.match(/^(?<name>[^@]+?)(?::(?<tag>[^:/@]+))?$/)
	if (!m?.groups?.tag) throw new Error(`${input}: give an explicit tag, e.g. ${input}:1.2.3`)
	const parts = m.groups.name.split('/')
	let registry = 'docker.io'
	if (parts.length > 1 && (parts[0].includes('.') || parts[0].includes(':') || parts[0] === 'localhost')) registry = parts.shift()
	let repository = parts.join('/')
	if (registry === 'docker.io' && !repository.includes('/')) repository = `library/${repository}`
	return {
		display: m.groups.name,
		registry,
		apiHost: registry === 'docker.io' ? 'registry-1.docker.io' : registry,
		repository,
		tag: m.groups.tag,
	}
}

async function get(url, headers = {}) {
	return fetch(url, {headers, redirect: 'follow', signal: AbortSignal.timeout(TIMEOUT_MS)})
}

async function token(challenge, image) {
	if (!challenge?.startsWith('Bearer ')) throw new Error(`registry requires unsupported auth (${challenge ?? 'none'}); is the image private?`)
	const params = Object.fromEntries([...challenge.matchAll(/(\w+)="([^"]*)"/g)].map((m) => [m[1], m[2]]))
	const url = new URL(params.realm)
	if (params.service) url.searchParams.set('service', params.service)
	url.searchParams.set('scope', params.scope ?? `repository:${image.repository}:pull`)
	const res = await get(url)
	if (!res.ok) throw new Error(`anonymous token request failed (HTTP ${res.status}); the image is probably private`)
	const body = await res.json()
	return body.token ?? body.access_token
}

async function manifest(image, reference, accept) {
	const url = `https://${image.apiHost}/v2/${image.repository}/manifests/${encodeURIComponent(reference)}`
	let res = await get(url, {Accept: accept.join(', ')})
	if (res.status === 401) res = await get(url, {Accept: accept.join(', '), Authorization: `Bearer ${await token(res.headers.get('www-authenticate'), image)}`})
	if (res.status === 404) throw new Error(`${image.display}:${reference} not found`)
	if (!res.ok) throw new Error(`${image.display}:${reference}: HTTP ${res.status}`)
	return {body: await res.json(), digest: res.headers.get('docker-content-digest'), type: res.headers.get('content-type')}
}

async function resolve(input, allowSingleArch) {
	const image = parseRef(input)
	const res = await manifest(image, image.tag, [...INDEX_TYPES, ...SINGLE_TYPES])
	const mediaType = res.body.mediaType ?? res.type ?? ''
	if (!res.digest) throw new Error(`${input}: registry did not return a digest`)
	const ref = `${image.display}:${image.tag}@${res.digest}`
	if (!INDEX_TYPES.some((t) => mediaType.includes(t)) && !Array.isArray(res.body.manifests)) {
		const message = `${ref}  [single-platform manifest: not a multi-arch index]`
		if (!allowSingleArch) throw new Error(message)
		return {ref, warning: message}
	}
	const platforms = [...new Set((res.body.manifests ?? []).map((m) => m.platform).filter((p) => p?.os && p.os !== 'unknown').map((p) => `${p.os}/${p.architecture}${p.variant ? `/${p.variant}` : ''}`))]
	const base = new Set(platforms.map((p) => p.split('/').slice(0, 2).join('/')))
	const missing = REQUIRED.filter((p) => !base.has(p))
	const line = `${ref}  [${platforms.join(', ')}]`
	if (missing.length) {
		const message = `${line}  MISSING ${missing.join(', ')}`
		if (!allowSingleArch) throw new Error(message)
		return {ref, warning: message}
	}
	return {ref, platforms}
}

const args = process.argv.slice(2)
const allowSingleArch = args.includes('--allow-single-arch')
const images = args.filter((a) => !a.startsWith('--'))
if (images.length === 0) {
	console.error('usage: node resolve-image.mjs <image>:<tag> [...] [--allow-single-arch]')
	process.exit(2)
}

let failed = false
for (const input of images) {
	try {
		const r = await resolve(input, allowSingleArch)
		console.log(r.ref)
		if (r.platforms) console.error(`  platforms: ${r.platforms.join(', ')}`)
		if (r.warning) console.error(`WARNING ${r.warning}`)
	} catch (error) {
		failed = true
		console.error(`ERROR ${error.message}`)
	}
}
process.exit(failed ? 1 : 0)
