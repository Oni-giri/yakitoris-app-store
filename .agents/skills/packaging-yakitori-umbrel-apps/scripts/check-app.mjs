#!/usr/bin/env node
// Store-specific checks for Yakitori's Umbrel community app store.
//
// Complements the official umbrel-apps linter (run both through check.sh). It
// checks what the official linter cannot: community-store rules, what umbreld
// actually does at runtime (see reference/platform.md), collisions with the
// official store, and update safety against a git base ref.
//
// Usage:
//   node check-app.mjs [APP ...] [--all] [--root DIR] [--official DIR]
//                      [--official-lint FILE.json] [--base REF] [--check-urls]
//                      [--format text|json]
//
// Exceptions: a comment `# yakitori-allow: <rule>[,<rule>] <reason>` in any of
// the app's files turns those rules' errors into "allowed" notes. A reason of at
// least three words is required, and the exception should also be disclosed in
// the manifest description.

import {execFileSync, spawnSync} from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import YAML from 'yaml'

// ---------------------------------------------------------------- constants

// app_proxy keys umbreld reads (legacy-compat/app-script, app-gateway.ts). Others are silently ignored.
const APP_PROXY_KEYS = new Set([
	'APP_HOST',
	'APP_PORT',
	'APP_PROTOCOL',
	'PROXY_AUTH_ADD',
	'PROXY_AUTH_WHITELIST',
	'PROXY_AUTH_BLACKLIST',
	'PROXY_TRUST_UPSTREAM',
	'PROXY_TIMEOUT',
])

// Files umbrelOS copies into an existing install on update (app-script pre-patch-update).
const UPDATE_COPIED = (rel) =>
	['docker-compose.yml', 'exports.sh', 'torrc', 'umbrel-app.yml'].includes(rel) ||
	(!rel.includes('/') && rel.endsWith('.template')) ||
	rel.startsWith('hooks/')

// Variables exported to compose interpolation, templates and post-env hooks by the app script,
// independent of exports.sh. APP_DATA_ROOT etc. are runtime-owned.
const RUNTIME_VARS = new Set([
	'APP_DATA_DIR',
	'APP_DATA_ROOT',
	'APP_ID',
	'APP_MANIFEST_FILE',
	'APP_VERSION',
	'APP_PROXY_PORT',
	'APP_DOMAIN',
	'APP_HIDDEN_SERVICE',
	'APP_SEED',
	'APP_PASSWORD',
	'TOR_DATA_DIR',
	'TOR_ENTRYPOINT_SCRIPT',
	'TOR_HS_APP_DIR',
	'TOR_HS_PORTS',
	'TOR_PROXY_IP',
	'TOR_PROXY_PORT',
	'TOR_PASSWORD',
	'TOR_HASHED_PASSWORD',
	'REMOTE_TOR_ACCESS',
	'UMBREL_ROOT',
	'NETWORK_IP',
	'GATEWAY_IP',
	'DEVICE_HOSTNAME',
	'DEVICE_DOMAIN_NAME',
	'BITCOIN_NETWORK',
])

// Exported only AFTER exports.sh is sourced, so unusable inside it without a default.
const SET_AFTER_EXPORTS = ['APP_ID', 'APP_SEED', 'APP_PASSWORD', 'APP_PROXY_PORT', 'APP_VERSION', 'APP_DOMAIN', 'APP_HIDDEN_SERVICE', 'APP_MANIFEST_FILE']

const RESERVED_PORTS = new Map([
	[80, 'umbrelOS dashboard HTTP'],
	[443, 'umbrelOS dashboard HTTPS'],
	[2000, 'umbrelOS app auth'],
])

const DB_IMAGE = /(^|\/)(postgres|postgis|timescaledb(-ha)?|pgvector|mariadb|mysql|mongo|mongodb|clickhouse-server)(:|$)/i
const CACHE_IMAGE = /(^|\/)(redis|valkey|keydb|dragonfly)(:|$)/i
const STATEFUL_IMAGE = new RegExp(`${DB_IMAGE.source}|${CACHE_IMAGE.source}|minio|elasticsearch|opensearch|meilisearch|rabbitmq|nats`, 'i')
const ALLOWED_VOLUME_OPTIONS = new Set(['ro', 'rw', 'z', 'Z', 'shared', 'rshared', 'slave', 'rslave', 'private', 'rprivate', 'cached', 'delegated', 'consistent'])
const RANDOM_SECRET = /\bopenssl\s+rand\b|\$RANDOM\b|\/dev\/u?random|\buuidgen\b|\bpwgen\b/
const SECRET_KEY = /(PASSWORD|PASSWD|SECRET|TOKEN|PRIVATE_KEY|API_KEY|ENCRYPTION_KEY|SIGNING_KEY|SALT)$/i
const NOT_A_SECRET_VALUE = /^(true|false|yes|no|on|off|none|null|disabled|enabled|\d+|)$/i

// Rules a `# yakitori-allow:` comment may downgrade. Everything else must be fixed.
const ALLOWABLE_RULE = /^(official:)?(access\.[a-z_]+|image\.architecture|image\.latest|service\.restart|compose\.networks)$/

// Official-lint findings that are expected differences for a community store.
const OFFICIAL_EXPECTED = new Map([
	['manifest.icon', 'community stores must host their own icon URL'],
	['manifest.gallery', 'community stores host their own gallery URLs'],
	['package.review_assets', 'icons may be committed in this store'],
	['manifest.release_notes', 'this store writes initial release notes'],
	['app.top_level', 'store-level files are allowed'],
	['lint.infrastructure', 'not applicable'],
])

// ---------------------------------------------------------------- args

function parseArgs(argv) {
	const o = {apps: [], all: false, root: null, official: null, officialLint: null, base: null, checkUrls: false, format: 'text'}
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i]
		const next = () => {
			const v = argv[++i]
			if (v === undefined) die(`Missing value for ${a}`)
			return v
		}
		if (a === '--all') o.all = true
		else if (a === '--root') o.root = path.resolve(next())
		else if (a === '--official') o.official = path.resolve(next())
		else if (a === '--official-lint') o.officialLint = path.resolve(next())
		else if (a === '--base') o.base = next()
		else if (a === '--check-urls') o.checkUrls = true
		else if (a === '--format') o.format = next()
		else if (a === '-h' || a === '--help') {
			console.log(fs.readFileSync(new URL(import.meta.url)).toString().split('\n').slice(1, 17).join('\n'))
			process.exit(0)
		} else if (a.startsWith('-')) die(`Unknown option ${a}`)
		else o.apps.push(a.replace(/\/$/, ''))
	}
	if (!o.all && o.apps.length === 0) die('Give app ids or --all.')
	if (!['text', 'json'].includes(o.format)) die('--format must be text or json')
	return o
}

function die(message) {
	console.error(`check-app: ${message}`)
	process.exit(2)
}

// ---------------------------------------------------------------- helpers

const isObject = (v) => typeof v === 'object' && v !== null && !Array.isArray(v)
const readText = (p) => (fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null)

function parseYaml(text) {
	try {
		return {value: YAML.parse(text)}
	} catch (error) {
		return {error: error.message.split('\n')[0]}
	}
}

// Shell text without comment lines (keeps line count so line numbers stay valid).
const stripShellComments = (text) =>
	text
		.split('\n')
		.map((l) => (/^\s*#/.test(l) ? '' : l))
		.join('\n')

function lineOf(text, needle) {
	if (!text || !needle) return null
	const idx = text.split('\n').findIndex((l) => l.includes(needle))
	return idx === -1 ? null : idx + 1
}

function git(root, args, {allowFail = true} = {}) {
	try {
		return execFileSync('git', args, {cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore']})
	} catch (error) {
		if (allowFail) return null
		throw error
	}
}

function walk(dir, base = dir) {
	const out = []
	if (!fs.existsSync(dir)) return out
	for (const entry of fs.readdirSync(dir, {withFileTypes: true})) {
		const full = path.join(dir, entry.name)
		if (entry.isDirectory()) out.push(...walk(full, base))
		else out.push(path.relative(base, full).split(path.sep).join('/'))
	}
	return out.sort()
}

function envMap(environment) {
	const map = new Map()
	if (Array.isArray(environment)) {
		for (const e of environment) {
			if (typeof e !== 'string') continue
			const [k, ...v] = e.split('=')
			map.set(k, v.join('='))
		}
	} else if (isObject(environment)) {
		for (const [k, v] of Object.entries(environment)) map.set(k, v === null || v === undefined ? '' : String(v))
	}
	return map
}

function strings(value) {
	if (value === null || value === undefined) return []
	if (Array.isArray(value)) return value.flatMap(strings)
	if (isObject(value)) return Object.values(value).flatMap(strings)
	return [String(value)]
}

function dependsOn(config) {
	const d = config?.depends_on
	if (!d) return []
	if (Array.isArray(d)) return d.map((name) => ({name, condition: 'service_started'}))
	if (typeof d === 'string') return [{name: d, condition: 'service_started'}]
	return Object.entries(d).map(([name, c]) => ({name, condition: c?.condition ?? 'service_started'}))
}

function versionNumber(v) {
	const parts = String(v ?? '').split('.').map((n) => Number.parseInt(n, 10))
	if (parts.some(Number.isNaN)) return null
	return parts[0] * 10000 + (parts[1] ?? 0) * 100 + (parts[2] ?? 0)
}

// Host port published by a compose port entry, or null.
function publishedPort(entry) {
	if (typeof entry === 'number') return null
	if (isObject(entry)) {
		const p = Number.parseInt(entry.published, 10)
		return Number.isInteger(p) ? {port: p, protocol: entry.protocol === 'udp' ? 'udp' : 'tcp'} : null
	}
	if (typeof entry !== 'string') return null
	const m = entry.trim().match(/^(?:[\d.]+:)?(\d+):\d+(?:\/(tcp|udp))?$/i)
	return m ? {port: Number(m[1]), protocol: (m[2] || 'tcp').toLowerCase()} : null
}

function volumeParts(volume) {
	if (typeof volume !== 'string') return null
	// ${VAR:-x} contains ':' — keep braces together when splitting.
	const parts = []
	let depth = 0
	let current = ''
	for (const ch of volume) {
		if (ch === '{') depth++
		if (ch === '}') depth--
		if (ch === ':' && depth === 0) {
			parts.push(current)
			current = ''
		} else current += ch
	}
	parts.push(current)
	return {source: parts[0], target: parts[1] ?? '', options: parts[2] ?? ''}
}

// Path relative to APP_DATA_DIR for a bind source, or null.
function appDataRelative(source) {
	const m = source.match(/^\$\{APP_DATA_DIR\}(\/.*)?$/) || source.match(/^\$APP_DATA_DIR(\/.*)?$/)
	if (!m) return null
	return (m[1] || '/').replace(/^\/+/, '').replace(/\/+$/, '')
}

// Bash variables a shell file reads without a default.
function unguardedRefs(text, names) {
	const found = new Set()
	const guarded = new Set()
	for (const line of text.split('\n')) {
		if (/^\s*#/.test(line)) continue
		for (const name of names) {
			if (guarded.has(name)) continue
			// NAME="${NAME:-x}" or : "${NAME:=x}" makes later plain references safe.
			if (new RegExp(`^\\s*(export\\s+)?${name}=["']?\\$\\{${name}:?[-=]|^\\s*:\\s+["']?\\$\\{${name}:?=`).test(line)) {
				guarded.add(name)
				continue
			}
			const re = new RegExp(`\\$\\{${name}\\}|\\$${name}(?![A-Za-z0-9_])`)
			if (re.test(line)) found.add(name)
		}
	}
	return [...found]
}

// Variables compose would interpolate: $NAME or ${NAME...}, excluding $$ escapes.
function composeVariables(text) {
	const vars = new Map() // name -> {guarded}
	const cleaned = text
		.split('\n')
		.filter((l) => !/^\s*#/.test(l))
		.join('\n')
		.replace(/\$\$/g, '')
	for (const m of cleaned.matchAll(/\$\{([A-Za-z_][A-Za-z0-9_]*)([^}]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g)) {
		const name = m[1] || m[3]
		const guarded = Boolean(m[2] && /^:?[-?+]/.test(m[2]))
		const prev = vars.get(name)
		vars.set(name, {guarded: prev ? prev.guarded && guarded : guarded})
	}
	return vars
}

// ---------------------------------------------------------------- checker

class Checker {
	constructor(options) {
		this.o = options
		this.root = options.root || git(process.cwd(), ['rev-parse', '--show-toplevel'])?.trim() || process.cwd()
		const storeMeta = parseYaml(readText(path.join(this.root, 'umbrel-app-store.yml')) ?? '').value
		if (!isObject(storeMeta) || typeof storeMeta.id !== 'string') die(`No umbrel-app-store.yml with an id in ${this.root}`)
		this.storeId = storeMeta.id
		this.issues = []
		this.appDirs = fs
			.readdirSync(this.root, {withFileTypes: true})
			.filter((e) => e.isDirectory() && fs.existsSync(path.join(this.root, e.name, 'umbrel-app.yml')))
			.map((e) => e.name)
			.sort()
		this.officialPorts = options.official ? this.indexPorts(options.official, 'official') : null
		this.storePorts = this.indexPorts(this.root, 'store')
	}

	add(app, severity, rule, file, line, message) {
		const fileKey = file ? `${app}/${file}` : app
		if (this.issues.some((i) => i.app === app && i.rule === rule && i.file === fileKey && i.message === message)) return
		this.issues.push({app, severity, rule, file: file ? `${app}/${file}` : app, line: line ?? null, message})
	}

	indexPorts(root, label) {
		const index = new Map() // "tcp:8080" -> [{app, kind}]
		const push = (port, protocol, entry) => {
			const key = `${protocol}:${port}`
			if (!index.has(key)) index.set(key, [])
			index.get(key).push(entry)
		}
		for (const entry of fs.readdirSync(root, {withFileTypes: true})) {
			if (!entry.isDirectory()) continue
			const manifest = parseYaml(readText(path.join(root, entry.name, 'umbrel-app.yml')) ?? '').value
			if (!isObject(manifest) || manifest.disabled === true) continue
			if (Number.isInteger(manifest.port)) push(manifest.port, 'tcp', {app: entry.name, kind: 'manifest', label})
			const compose = parseYaml(readText(path.join(root, entry.name, 'docker-compose.yml')) ?? '').value
			for (const [service, config] of Object.entries(compose?.services ?? {})) {
				for (const p of config?.ports ?? []) {
					const pub = publishedPort(p)
					if (pub) push(pub.port, pub.protocol, {app: entry.name, kind: `compose ${service}`, label})
				}
			}
		}
		return index
	}

	run() {
		const apps = this.o.all ? this.appDirs : this.o.apps
		for (const app of apps) {
			if (!this.appDirs.includes(app)) {
				this.add(app, 'error', 'app.unknown', null, null, `No ${app}/umbrel-app.yml in ${this.root}.`)
				continue
			}
			this.checkApp(app)
		}
		if (this.o.officialLint) this.mergeOfficial(apps)
		this.applyAllows(apps)
		return apps
	}

	// ------------------------------------------------------------ per app

	checkApp(app) {
		const dir = path.join(this.root, app)
		const ctx = {app, dir, files: walk(dir)}
		ctx.manifestText = readText(path.join(dir, 'umbrel-app.yml'))
		const m = parseYaml(ctx.manifestText)
		if (m.error || !isObject(m.value)) {
			this.add(app, 'error', 'manifest.parse', 'umbrel-app.yml', null, `Manifest is not a YAML object: ${m.error ?? 'wrong type'}. umbrelOS silently drops it from the store.`)
			return
		}
		ctx.manifest = m.value
		ctx.composeText = readText(path.join(dir, 'docker-compose.yml'))
		const c = parseYaml(ctx.composeText ?? '')
		ctx.compose = isObject(c.value) ? c.value : null
		ctx.services = isObject(ctx.compose?.services) ? ctx.compose.services : {}
		ctx.serviceNames = Object.keys(ctx.services).filter((s) => s !== 'app_proxy')
		ctx.exportsText = readText(path.join(dir, 'exports.sh'))
		ctx.hasStorage = ctx.manifest.storage?.dataRoot === 'data'

		this.checkFileNames(ctx)
		this.checkManifest(ctx)
		if (ctx.compose) this.checkCompose(ctx)
		this.checkExports(ctx)
		this.checkHooks(ctx)
		this.checkTemplates(ctx)
		this.checkPackageFiles(ctx)
		if (this.o.base) this.checkUpdate(ctx)
	}

	checkFileNames({app, files}) {
		const wrong = {'docker-compose.yaml': 'docker-compose.yml', 'compose.yml': 'docker-compose.yml', 'compose.yaml': 'docker-compose.yml', 'umbrel-app.yaml': 'umbrel-app.yml', 'export.sh': 'exports.sh'}
		for (const f of files) {
			if (wrong[f]) this.add(app, 'error', 'package.filename', f, null, `\`${f}\` is never read by umbrelOS; name it \`${wrong[f]}\`.`)
			if (f.startsWith('hook/')) this.add(app, 'error', 'package.filename', f, null, 'Hooks live in `hooks/`, not `hook/`.')
		}
	}

	checkManifest(ctx) {
		const {app, manifest: mf, manifestText: t} = ctx
		const at = (key) => lineOf(t, `${key}:`)
		const err = (rule, key, msg) => this.add(app, 'error', rule, 'umbrel-app.yml', at(key), msg)
		const warn = (rule, key, msg) => this.add(app, 'warning', rule, 'umbrel-app.yml', at(key), msg)

		// Identity
		if (mf.id !== app) err('manifest.id', 'id', `\`id\` (${mf.id}) must equal the directory name (${app}); install resolves <store>/<id>.`)
		if (typeof mf.id === 'string') {
			if (!mf.id.startsWith(`${this.storeId}-`)) err('manifest.id_prefix', 'id', `\`id\` must start with \`${this.storeId}-\`; umbrelOS silently drops apps without the store prefix.`)
			if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(mf.id)) err('manifest.id_format', 'id', '`id` must be lowercase kebab-case (the app-auth endpoint rejects `_`).')
		}

		// Version
		if (typeof mf.version !== 'string') err('manifest.version_type', 'version', `\`version\` is a YAML ${typeof mf.version}; quote it (e.g. "1.2"). umbrelOS only offers updates when the store version is a string.`)
		else if (/^(latest|sha256:)/i.test(mf.version) || mf.version.trim() === '') err('manifest.version_value', 'version', '`version` must be the upstream release (or short commit SHA), never `latest` or a digest.')

		const mv = versionNumber(mf.manifestVersion)
		if (mv === null) err('manifest.manifest_version', 'manifestVersion', '`manifestVersion` must be numeric like 1, 1.1 or 2.0.')
		else {
			const v2Features = ['requiresHttps', 'storage', 'environment', 'folderAccess'].filter((k) => mf[k] !== undefined && mf[k] !== false)
			if (mv < 20000 && v2Features.length) warn('manifest.manifest_version', 'manifestVersion', `Uses ${v2Features.join(', ')} (umbrelOS 2.0 features) but manifestVersion is ${mf.manifestVersion}; use 2.0.`)
		}

		// Never-null fields (null crashes the store UI)
		for (const [key, kind] of [
			['gallery', 'list'],
			['dependencies', 'list'],
			['releaseNotes', 'string'],
		]) {
			if (!(key in mf) || mf[key] === null) err('manifest.null_field', key, `\`${key}\` must be present and not null; use ${kind === 'list' ? '`[]`' : '`""`'}.`)
		}

		// Icon and gallery: community stores use them verbatim.
		if (typeof mf.icon !== 'string' || !/^https:\/\/\S+$/.test(mf.icon)) {
			err('manifest.icon_url', 'icon', 'Set `icon` to an absolute https URL; without it umbrelOS shows the official store icon URL for this id, which does not exist.')
		} else this.checkOwnAssetUrl(ctx, mf.icon, 'icon')
		if (Array.isArray(mf.gallery)) {
			for (const g of mf.gallery) {
				if (typeof g !== 'string' || !/^https?:\/\/\S+$/.test(g)) err('manifest.gallery_url', 'gallery', `Gallery entry \`${g}\` must be an absolute URL (community stores do not prefix gallery paths).`)
				else this.checkOwnAssetUrl(ctx, g, 'gallery')
			}
		} else if (mf.gallery !== undefined && mf.gallery !== null) err('manifest.gallery_url', 'gallery', '`gallery` must be a list.')

		// Port
		const port = mf.port
		if (Number.isInteger(port)) {
			if (RESERVED_PORTS.has(port)) err('manifest.port_reserved', 'port', `Port ${port} is reserved for ${RESERVED_PORTS.get(port)}.`)
			if (port >= 40000 && port <= 49999) err('manifest.port_reserved', 'port', 'Ports 40000–49999 are reserved for umbrelOS virtual machines.')
			this.checkPortCollisions(ctx, port, 'tcp', 'manifest', 'port')
		}

		// Credentials
		const runtimeText = [ctx.exportsText, readText(path.join(ctx.dir, 'docker-compose.yml')), ...ctx.files.filter((f) => f.endsWith('.template')).map((f) => readText(path.join(ctx.dir, f)))].join('\n')
		if (mf.deterministicPassword === true && !/APP_PASSWORD/.test(runtimeText)) err('manifest.deterministic_password', 'deterministicPassword', '`deterministicPassword: true` but nothing uses `${APP_PASSWORD}`; Umbrel would show a password the app does not use.')
		if (typeof mf.defaultPassword === 'string' && mf.defaultPassword !== '' && mf.deterministicPassword !== true) {
			warn('manifest.static_password', 'defaultPassword', 'A static default password is the same on every device. Wire the login to `${APP_PASSWORD}` with `deterministicPassword: true`, or use browser sign-up.')
		}

		// Settings entries silently dropped by umbreld when invalid.
		const envNames = new Set()
		for (const e of Array.isArray(mf.environment) ? mf.environment : []) {
			if (!isObject(e) || typeof e.name !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(e.name)) {
				err('manifest.environment', 'environment', `environment entry ${JSON.stringify(e?.name)} has an invalid name; umbrelOS drops it silently.`)
				continue
			}
			if (envNames.has(e.name)) err('manifest.environment', 'environment', `Duplicate environment name \`${e.name}\`; umbrelOS drops duplicates.`)
			envNames.add(e.name)
			const services = Array.isArray(e.services) ? e.services : []
			if (services.length === 0) err('manifest.environment', 'environment', `environment \`${e.name}\` needs at least one service.`)
			for (const s of services) {
				if (s === 'app_proxy' || !ctx.serviceNames.includes(s)) err('manifest.environment', 'environment', `environment \`${e.name}\` targets service \`${s}\`, which is not a compose service; umbrelOS drops the entry silently.`)
			}
			if (typeof e.note === 'string' && e.note.length > 300) warn('manifest.environment', 'environment', `environment \`${e.name}\` note is over 300 characters and will be truncated.`)
		}
		const faIds = new Set()
		for (const f of Array.isArray(mf.folderAccess) ? mf.folderAccess : []) {
			if (!isObject(f) || typeof f.id !== 'string' || typeof f.name !== 'string' || !Array.isArray(f.mounts) || f.mounts.length === 0) {
				err('manifest.folder_access', 'folderAccess', `folderAccess entry ${JSON.stringify(f?.id)} needs id, name and at least one mount.`)
				continue
			}
			if (faIds.has(f.id)) err('manifest.folder_access', 'folderAccess', `Duplicate folderAccess id \`${f.id}\`.`)
			faIds.add(f.id)
			for (const mount of f.mounts) {
				const service = mount?.service ?? (ctx.serviceNames.length === 1 ? ctx.serviceNames[0] : null)
				if (!service || !ctx.serviceNames.includes(service)) err('manifest.folder_access', 'folderAccess', `folderAccess \`${f.id}\` mount targets unknown or ambiguous service \`${mount?.service}\`; umbrelOS drops it silently.`)
				if (typeof mount?.targetPath !== 'string' || !mount.targetPath.startsWith('/') || mount.targetPath === '/') err('manifest.folder_access', 'folderAccess', `folderAccess \`${f.id}\` targetPath must be an absolute path other than /.`)
			}
		}

		// Widgets: endpoint host must be a compose service.
		for (const w of Array.isArray(mf.widgets) ? mf.widgets : []) {
			const host = typeof w?.endpoint === 'string' ? w.endpoint.split(':')[0] : null
			if (host && !ctx.serviceNames.includes(host)) err('manifest.widgets', 'widgets', `Widget endpoint host \`${host}\` is not a compose service.`)
			if (host && ctx.services[host]?.network_mode === 'host') err('manifest.widgets', 'widgets', `Widget service \`${host}\` uses host networking; umbreld cannot resolve its container IP.`)
		}

		if (!ctx.hasStorage && Object.values(ctx.services).some((s) => (s?.volumes ?? []).some((v) => typeof v === 'string' && appDataRelative(volumeParts(v).source)?.startsWith('data')))) {
			warn('manifest.storage', 'storage', 'Declare `storage: {dataRoot: data}` so users can move app data to external storage (it can be added later but never removed).')
		}
	}

	// URLs pointing at this store's own repository must reference committed files.
	checkOwnAssetUrl(ctx, url, key) {
		const m = url.match(/^https:\/\/raw\.githubusercontent\.com\/Oni-giri\/yakitoris-app-store\/[^/]+\/(.+)$/i)
		if (!m) {
			if (/\/(main|master|HEAD|develop|dev)\//.test(url) && !/yakitoris-app-store/.test(url)) {
				this.add(ctx.app, 'warning', 'manifest.asset_mutable', 'umbrel-app.yml', lineOf(ctx.manifestText, url), `\`${key}\` points at a moving branch (${url}); pin it to a release tag or commit SHA.`)
			}
			return
		}
		if (!fs.existsSync(path.join(this.root, m[1]))) {
			this.add(ctx.app, 'error', 'manifest.asset_missing', 'umbrel-app.yml', lineOf(ctx.manifestText, url), `\`${key}\` references \`${m[1]}\`, which is not committed in this repo.`)
		}
	}

	checkPortCollisions(ctx, port, protocol, what, key) {
		const line = key ? lineOf(ctx.manifestText, `${key}:`) : null
		const file = key ? 'umbrel-app.yml' : 'docker-compose.yml'
		const fmt = (entries) => entries.map((e) => `${e.label === 'official' ? 'official store' : 'this store'} \`${e.app}\` (${e.kind})`).join(', ')
		const others = (index) => (index?.get(`${protocol}:${port}`) ?? []).filter((e) => !(e.label === 'store' && e.app === ctx.app))
		const store = others(this.storePorts)
		const official = others(this.officialPorts)
		if (store.length) this.add(ctx.app, 'error', 'ports.collision', file, line, `${what} port ${port}/${protocol} collides with ${fmt(store)}.`)
		if (official.length) this.add(ctx.app, 'error', 'ports.official_collision', file, line, `${what} port ${port}/${protocol} collides with ${fmt(official)}; a device with both installed routes only the first.`)
	}

	// ------------------------------------------------------------ compose

	checkCompose(ctx) {
		const {app, compose, services, composeText: t} = ctx
		const err = (rule, needle, msg) => this.add(app, 'error', rule, 'docker-compose.yml', lineOf(t, needle), msg)
		const warn = (rule, needle, msg) => this.add(app, 'warning', rule, 'docker-compose.yml', lineOf(t, needle), msg)

		if (compose.version !== undefined) warn('compose.version_key', 'version:', 'Drop the obsolete top-level `version:` key.')

		// app_proxy is config-only and deleted before compose up.
		const proxy = services.app_proxy
		if (proxy) {
			for (const k of Object.keys(proxy)) if (k !== 'environment') warn('app_proxy.config_only', 'app_proxy:', `\`app_proxy.${k}\` is ignored; app_proxy is configuration only on umbrelOS 2.x.`)
			const env = envMap(proxy.environment)
			for (const k of env.keys()) if (!APP_PROXY_KEYS.has(k)) err('app_proxy.unknown_key', k, `\`${k}\` is not an app_proxy key umbreld reads; it is silently ignored. Valid: ${[...APP_PROXY_KEYS].join(', ')}.`)
			const host = env.get('APP_HOST')
			if (host && !host.includes('$')) {
				const target = ctx.serviceNames.find((s) => host === `${app}_${s}_1` || host === s)
				if (!target) err('app_proxy.host', 'APP_HOST', `APP_HOST \`${host}\` is not \`${app}_<service>_1\` for any service here.`)
				else if (host === target) warn('app_proxy.host', 'APP_HOST', `Use APP_HOST \`${app}_${target}_1\`, not the bare service name.`)
			}
			const appPort = env.get('APP_PORT')
			if (appPort !== undefined && !appPort.includes('$') && !/^\d+$/.test(appPort)) err('app_proxy.port', 'APP_PORT', `APP_PORT \`${appPort}\` must be one container port number.`)
			if (env.get('PROXY_AUTH_ADD')?.toLowerCase() === 'false') warn('app_proxy.auth_off', 'PROXY_AUTH_ADD', 'Umbrel login is disabled for the whole app. Only acceptable if every route, including first-run setup, has the app\'s own auth.')
			const timeout = env.get('PROXY_TIMEOUT')
			if (timeout !== undefined && /^\d+$/.test(timeout) && Number(timeout) > 0 && Number(timeout) < 1000) warn('app_proxy.timeout', 'PROXY_TIMEOUT', `PROXY_TIMEOUT is in milliseconds; ${timeout} ms is almost certainly a mistake.`)
			this.checkWhitelist(ctx, env)
		}

		for (const [name, config] of Object.entries(services)) {
			if (name === 'app_proxy' || !isObject(config)) continue
			const svcErr = (rule, msg, needle = `${name}:`) => this.add(app, 'error', rule, 'docker-compose.yml', lineOf(t, needle), msg)
			const svcWarn = (rule, msg, needle = `${name}:`) => this.add(app, 'warning', rule, 'docker-compose.yml', lineOf(t, needle), msg)

			for (const dep of dependsOn(config)) {
				if (dep.name === 'app_proxy') svcErr('compose.app_proxy_ref', `\`${name}\` depends on app_proxy, which umbreld deletes before compose up.`)
			}
			for (const s of strings(config.links)) if (s.split(':')[0] === 'app_proxy') svcErr('compose.app_proxy_ref', `\`${name}\` links to app_proxy, which does not exist at runtime.`)

			if (config.build !== undefined) svcErr('compose.build', `\`${name}\` uses \`build:\`; it resolves against umbreld's directory and builds on the device. Use a prebuilt multi-arch image.`, 'build:')
			if (typeof config.image === 'string' && config.image.includes('$')) svcErr('compose.image_literal', `Image for \`${name}\` contains a variable; umbreld pulls the literal string before interpolation.`, config.image)
			if (config.env_file !== undefined) svcErr('compose.relative_path', `\`${name}\` uses env_file; relative paths resolve against umbreld's own directory and .env is never installed on update.`, 'env_file')

			// Hostnames: siblings must be addressed as <id>_<svc>_1.
			this.checkHostnames(ctx, name, config)

			// Host access (also see official access.* warnings).
			if (config.privileged === true) svcErr('access.privileged', `\`${name}\` is privileged.`, 'privileged:')
			if (config.network_mode === 'host') svcErr('access.host_network', `\`${name}\` uses host networking.`, 'network_mode:')
			for (const f of ['pid', 'ipc', 'uts', 'userns_mode', 'cgroupns_mode']) if (config[f] === 'host') svcErr(`access.${f}`, `\`${name}\` uses host ${f}.`, `${f}:`)
			for (const d of strings(config.devices)) {
				if (d.startsWith('/dev/dri')) svcErr('compose.dri', `\`${name}\` maps ${d}; umbreld strips /dev/dri. Declare \`permissions: [GPU]\` instead.`, '/dev/dri')
			}

			// Healthchecks
			const testText = strings(config.healthcheck?.test).join(' ')
			if (/\blocalhost\b/.test(testText)) svcWarn('compose.healthcheck_localhost', `\`${name}\` healthcheck uses localhost, which may resolve to ::1; use 127.0.0.1.`, 'localhost')
			if (config.healthcheck && config.healthcheck.disable !== true && !config.healthcheck.start_period && !/\bCMD-SHELL\b.*true\b/.test(testText)) {
				svcWarn('compose.healthcheck_start_period', `\`${name}\` healthcheck has no start_period; first boot on a Raspberry Pi can be slow.`, 'healthcheck:')
			}
			for (const dep of dependsOn(config)) {
				const target = services[dep.name]
				if (!target || dep.name === 'app_proxy') continue
				if (dep.condition === 'service_started' && (target.healthcheck || STATEFUL_IMAGE.test(String(target.image ?? '')))) {
					svcWarn('compose.depends_condition', `\`${name}\` waits for \`${dep.name}\` only to start; use \`condition: service_healthy\` (with a healthcheck on \`${dep.name}\`).`, 'depends_on:')
				}
			}

			// Users on database images.
			if (DB_IMAGE.test(String(config.image ?? '')) && config.user !== undefined) svcWarn('compose.db_user', `\`${name}\` sets \`user:\` on a database image; official DB entrypoints need root to initialise and chown the data dir.`, 'user:')

			// Databases must require a password on the shared network.
			if (DB_IMAGE.test(String(config.image ?? ''))) {
				const env = envMap(config.environment)
				if (/^trust$/i.test(env.get('POSTGRES_HOST_AUTH_METHOD') ?? '') || /^(yes|true|1)$/i.test(env.get('MYSQL_ALLOW_EMPTY_PASSWORD') ?? env.get('MARIADB_ALLOW_EMPTY_ROOT_PASSWORD') ?? '')) {
					svcErr('compose.db_no_password', `\`${name}\` accepts connections without a password; every app on umbrel_main_network can reach it.`)
				}
			}

			// Caches without a password on the shared network.
			if (CACHE_IMAGE.test(String(config.image ?? ''))) {
				const all = strings(config.command).join(' ') + ' ' + [...envMap(config.environment).keys()].join(' ')
				if (!/requirepass|PASSWORD|aclfile/i.test(all)) svcErr('compose.cache_no_password', `\`${name}\` (${String(config.image).split('@')[0]}) has no password; every app on umbrel_main_network can reach it. Use --requirepass with a derive_entropy secret.`)
			}

			// Hardcoded secrets.
			for (const [k, v] of envMap(config.environment)) {
				if (SECRET_KEY.test(k) && !v.includes('$') && !NOT_A_SECRET_VALUE.test(v.trim()) && !/^(\/|file:)/.test(v)) {
					svcErr('compose.hardcoded_secret', `\`${name}\` sets \`${k}\` to a literal value; derive it in exports.sh with derive_entropy.`, `${k}`)
				}
			}

			// Ports
			for (const p of config.ports ?? []) {
				const pub = publishedPort(p)
				if (pub) {
					if (RESERVED_PORTS.has(pub.port)) svcErr('ports.reserved', `\`${name}\` publishes reserved port ${pub.port}.`, String(pub.port))
					if (pub.port !== ctx.manifest.port || services.app_proxy) {
						const before = this.issues.length
						this.checkPortCollisions(ctx, pub.port, pub.protocol, `\`${name}\` published`, null)
						for (const i of this.issues.slice(before)) i.line = lineOf(t, String(pub.port))
					}
				}
			}

			this.checkVolumes(ctx, name, config)
		}

		// Undefined interpolation variables interpolate to "" silently.
		const exported = this.sourceExports(ctx)
		if (exported) {
			for (const [v, {guarded}] of composeVariables(t)) {
				if (guarded || RUNTIME_VARS.has(v) || exported.has(v)) continue
				const dependencyVar = (ctx.manifest.dependencies ?? []).length > 0 && /^APP_[A-Z0-9_]+$/.test(v)
				this.add(app, dependencyVar ? 'warning' : 'error', 'compose.undefined_var', 'docker-compose.yml', lineOf(t, v), `\`$${v}\` is not exported by exports.sh or umbrelOS; compose interpolates it to an empty string${dependencyVar ? ' (unless a dependency exports it)' : ''}. Escape literal dollars as \`$$\`.`)
			}
		}
	}

	checkWhitelist(ctx, env) {
		const t = ctx.composeText
		const list = (env.get('PROXY_AUTH_WHITELIST') ?? '').split(/[, ]+/).filter(Boolean)
		const set = new Set(list)
		for (const p of list) {
			if (['*', '/*', '/**', '/'].includes(p)) {
				this.add(ctx.app, 'error', 'app_proxy.whitelist_all', 'docker-compose.yml', lineOf(t, 'PROXY_AUTH_WHITELIST'), `Whitelist entry \`${p}\` makes the whole app public; use PROXY_AUTH_ADD only with a documented reason, or list exact paths.`)
				continue
			}
			if (/[^/]\*$/.test(p)) this.add(ctx.app, 'warning', 'app_proxy.whitelist_prefix', 'docker-compose.yml', lineOf(t, 'PROXY_AUTH_WHITELIST'), `\`${p}\` is a raw prefix match: it also matches any path that merely starts with the same characters (\`/api*\` matches \`/apikeys\`). Prefer \`/x\` plus \`/x/*\`.`)
			if (p.endsWith('/*')) {
				const base = p.slice(0, -2)
				if (base && !set.has(base) && !/\/\.well-known$/.test(base)) {
					this.add(ctx.app, 'warning', 'app_proxy.whitelist_exact', 'docker-compose.yml', lineOf(t, 'PROXY_AUTH_WHITELIST'), `\`${p}\` does not match \`${base}\` itself; add \`${base}\` if clients call it (bare requests get a 302 to Umbrel login).`)
				}
				if ((base.match(/\//g) ?? []).length === 1 && /^\/(api|v\d|graphql|trpc|auth|_next|app)$/i.test(base)) {
					this.add(ctx.app, 'warning', 'app_proxy.whitelist_broad', 'docker-compose.yml', lineOf(t, 'PROXY_AUTH_WHITELIST'), `\`${p}\` exposes a whole top-level API to the LAN without Umbrel login. Audit it for sign-up, admin bootstrap and unauthenticated routes (reference/gateway.md) and narrow it if possible.`)
				}
			}
		}
	}

	checkHostnames(ctx, name, config) {
		const {app, serviceNames, composeText: t} = ctx
		const found = new Map()
		const consider = (host, where) => {
			if (!host || host.includes('$')) return
			if (serviceNames.includes(host) && host !== 'localhost') found.set(host, where)
		}
		const scan = (s, where) => {
			for (const m of s.matchAll(/[a-z][a-z0-9+.-]*:\/\/(?:[^@/\s'"]*@)?([A-Za-z0-9_-]+)(?=[:/'"\s;]|$)/g)) consider(m[1], where)
			for (const m of s.matchAll(/@([A-Za-z0-9_-]+):\d+/g)) consider(m[1], where)
			for (const m of s.matchAll(/\bserver\s+([A-Za-z0-9_-]+):\d+/g)) consider(m[1], where)
			for (const m of s.matchAll(/\bset\s+\$\$?\w+\s+([A-Za-z0-9_-]+):\d+/g)) consider(m[1], where)
			for (const m of s.matchAll(/(?:^|\s)-h\s+([A-Za-z0-9_-]+)(?=\s|$)/g)) consider(m[1], where)
		}
		for (const [k, v] of envMap(config.environment)) {
			scan(v, k)
			if (/(HOST|HOSTNAME|SERVER|ADDR|ADDRESS|ENDPOINT)S?$/i.test(k)) {
				const m = v.trim().match(/^([A-Za-z0-9_-]+)(?::\d+)?$/)
				if (m) consider(m[1], k)
			}
		}
		for (const s of [...strings(config.command), ...strings(config.entrypoint), ...strings(config.healthcheck?.test)]) scan(s, 'command')
		const slug = app.replace(new RegExp(`^${this.storeId}-`), '').replace(/-/g, '_')
		for (const [host, where] of found) {
			// A service named after the app (e.g. tirreno_db) is unlikely to collide, but is still a bare name.
			const severity = host.replace(/-/g, '_').includes(slug) ? 'warning' : 'error'
			this.add(app, severity, 'compose.bare_host', 'docker-compose.yml', lineOf(t, where), `\`${name}\` reaches sibling \`${host}\` by its bare service name (${where}). All apps share umbrel_main_network, so \`${host}\` can resolve to another app's container. Use \`${app}_${host}_1\`.`)
		}
	}

	checkVolumes(ctx, name, config) {
		const {app, composeText: t, files, hasStorage} = ctx
		const templatesOut = new Set(files.filter((f) => !f.includes('/') && f.endsWith('.template')).map((f) => f.slice(0, -'.template'.length)))
		for (const volume of config.volumes ?? []) {
			if (typeof volume !== 'string') {
				this.add(app, 'error', 'volumes.syntax', 'docker-compose.yml', lineOf(t, `${name}:`), `\`${name}\` uses long-syntax volumes. The official linter rejects them and this checker cannot verify them; use short-syntax strings.`)
				continue
			}
			const v = volumeParts(volume)
			const line = lineOf(t, volume) ?? lineOf(t, v.source)
			const err = (rule, msg) => this.add(app, 'error', rule, 'docker-compose.yml', line, msg)
			const warn = (rule, msg) => this.add(app, 'warning', rule, 'docker-compose.yml', line, msg)

			if (/docker\.sock/.test(v.source)) err('access.docker_socket', `\`${name}\` mounts the Docker socket: host-root access to every app and the OS.`)
			if (v.source.startsWith('.')) err('compose.relative_path', `Relative source \`${v.source}\` resolves against umbreld's own directory. Use \${APP_DATA_DIR}/...`)
			if (/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(v.source)) err('persistence.named_volume', `Named volume \`${v.source}\` lives outside app data, survives uninstall and never moves with the data root. Bind-mount \${APP_DATA_DIR}/data/<dir>.`)
			if (/\$\{APP_DATA_DIR:[-?]/.test(v.source)) err('persistence.data_dir_form', `Write the source as \${APP_DATA_DIR}/data/...; \`${v.source}\` is not redirected when the data root moves.`)
			if (/\/data\/storage(?!\/downloads)/.test(v.source) && !/UMBREL_ROOT/.test(v.source)) err('persistence.storage_rewrite', `umbreld rewrites every \`/data/storage\` substring to \`/home\`; rename the directory in \`${v.source}\`.`)
			if (hasStorage && v.options) {
				for (const opt of v.options.split(',')) if (opt && !ALLOWED_VOLUME_OPTIONS.has(opt)) err('volumes.options', `Volume option \`${opt}\` makes umbreld's data-root patch fail the start.`)
			}

			const rel = appDataRelative(v.source)
			if (rel === null) {
				if (v.source.startsWith('/') && !/docker\.sock/.test(v.source) && !/^\/etc\/(localtime|timezone)$/.test(v.source)) err('access.host_mount', `\`${name}\` mounts host path \`${v.source}\`.`)
				continue
			}
			if (rel === '' ) continue // official linter reports direct APP_DATA_DIR mounts
			const committed = path.join(ctx.dir, rel)
			if (rel === 'data' || rel.startsWith('data/')) {
				if (fs.existsSync(committed) && fs.statSync(committed).isFile()) err('persistence.file_mount', `\`${rel}\` is a file under data/. umbreld runs mkdir -p on every data/ bind source before start; mount a directory instead.`)
				else if (!fs.existsSync(committed) && /\.[a-z0-9]{1,5}$/i.test(v.target) && !/\.d$/.test(v.target)) warn('persistence.file_mount', `\`${v.target}\` looks like a file but \`${rel}\` is a data/ bind source; umbreld creates a directory there.`)
				continue
			}
			// Outside data/
			if (templatesOut.has(rel)) continue
			if (fs.existsSync(committed) && walk(fs.statSync(committed).isDirectory() ? committed : path.dirname(committed)).some((f) => f !== '.gitkeep')) {
				ctx.frozen = [...(ctx.frozen ?? []), rel]
				err('package.frozen_mount', `\`${rel}\` is a package file outside umbrelOS's update whitelist (compose, exports.sh, top-level *.template, torrc, hooks). Existing installs keep the first-install copy forever. Inline it in compose or make it a top-level template.`)
			} else if (hasStorage) {
				err('persistence.outside_data_root', `\`${rel}\` is outside data/: it does not move with storage.dataRoot. Keep durable state under \${APP_DATA_DIR}/data/.`)
			} else {
				warn('persistence.outside_data_root', `\`${rel}\` is outside data/; keep durable state under \${APP_DATA_DIR}/data/ and declare storage.dataRoot.`)
			}
		}
	}

	// Source exports.sh the way umbreld does (set -euo pipefail, pre-exports env only).
	sourceExports(ctx) {
		if (ctx._exported !== undefined) return ctx._exported
		ctx._exported = new Set()
		if (ctx.exportsText === null) return ctx._exported
		const script = `
set -euo pipefail
derive_entropy() { [[ -n "\${1:-}" ]] || return 1; printf '%s' "$1" | sha256sum | cut -c1-64; }
app_entropy_identifier="app-${ctx.app}-seed"
EXPORTS_APP_ID="${ctx.app}"; EXPORTS_APP_DIR="/tmp/umbrel/app-data/${ctx.app}"; EXPORTS_APP_FILE="$EXPORTS_APP_DIR/exports.sh"
EXPORTS_APP_DATA_DIR="$EXPORTS_APP_DIR/data"; EXPORTS_TOR_DATA_DIR="/tmp/umbrel/tor/data"
before_opts="$(set +o)"; before_fns="$(compgen -A function | sort)"; before_vars="$(compgen -v | sort)"
. "$1"
status=$?
echo "__EXPORTS__"; compgen -e | sort
echo "__OPTS__"; [[ "$(set +o)" == "$before_opts" ]] && echo same || echo changed
echo "__FNS__"; comm -13 <(echo "$before_fns") <(compgen -A function | sort)
echo "__VARS__"; comm -13 <(echo "$before_vars") <(compgen -v | sort)
exit $status
`
		const env = {
			PATH: process.env.PATH,
			HOME: '/tmp',
			APP_DATA_DIR: `/tmp/umbrel/app-data/${ctx.app}`,
			APP_DATA_ROOT: `/tmp/umbrel/app-data/${ctx.app}/data`,
			UMBREL_ROOT: '/tmp/umbrel',
			NETWORK_IP: '10.21.0.0',
			GATEWAY_IP: '10.21.0.1',
			DEVICE_HOSTNAME: 'umbrel',
			DEVICE_DOMAIN_NAME: 'umbrel.local',
			TOR_PROXY_IP: '10.21.21.11',
			TOR_PROXY_PORT: '9050',
			REMOTE_TOR_ACCESS: 'false',
			BITCOIN_NETWORK: 'mainnet',
		}
		const result = spawnSync('bash', ['-c', script, 'check-exports', path.join(ctx.dir, 'exports.sh')], {env, encoding: 'utf8', timeout: 20_000})
		const out = result.stdout ?? ''
		if (result.status !== 0 || !out.includes('__EXPORTS__')) {
			this.add(ctx.app, 'error', 'exports.source_fails', 'exports.sh', null, `Sourcing exports.sh under \`set -euo pipefail\` (as umbrelOS does, before APP_ID/APP_SEED/APP_PASSWORD/APP_PROXY_PORT exist) failed with status ${result.status}: ${(result.stderr || '').trim().split('\n').slice(-3).join(' | ') || 'no output'}. Install/start/update would abort.`)
			ctx._exported = null // unknown: skip checks that depend on the exported set
			return null
		}
		const lines = out.split('\n')
		const section = (name) => {
			const start = lines.indexOf(`__${name}__`)
			if (start === -1) return []
			const rest = lines.slice(start + 1)
			const end = rest.findIndex((l) => /^__[A-Z]+__$/.test(l))
			return (end === -1 ? rest : rest.slice(0, end)).filter(Boolean)
		}
		ctx._exported = new Set(section('EXPORTS'))
		if (section('OPTS')[0] === 'changed') this.add(ctx.app, 'error', 'exports.shell_options', 'exports.sh', null, 'exports.sh changes shell options in Umbrel\'s shell.')
		const fns = section('FNS').filter((f) => f !== 'derive_entropy')
		if (fns.length) this.add(ctx.app, 'warning', 'exports.leftovers', 'exports.sh', null, `exports.sh leaves functions defined in Umbrel's shell: ${fns.join(', ')}; \`unset -f\` them.`)
		const ignore = new Set(['status', 'before_opts', 'before_fns', 'before_vars', 'BASH_REMATCH', '_', 'PIPESTATUS', 'BASH_LINENO', 'BASH_SOURCE', 'FUNCNAME', 'COLUMNS', 'LINES'])
		const vars = section('VARS').filter((v) => !ignore.has(v) && !ctx._exported.has(v))
		if (vars.length) this.add(ctx.app, 'warning', 'exports.leftovers', 'exports.sh', null, `exports.sh leaves helper variables in Umbrel's shell: ${vars.join(', ')}; \`unset\` them at the end.`)
		return ctx._exported
	}

	checkExports(ctx) {
		const {app, exportsText: t} = ctx
		if (t === null) return
		const err = (rule, needle, msg) => this.add(app, 'error', rule, 'exports.sh', lineOf(t, needle), msg)
		const warn = (rule, needle, msg) => this.add(app, 'warning', rule, 'exports.sh', lineOf(t, needle), msg)

		const syntax = spawnSync('bash', ['-n', path.join(ctx.dir, 'exports.sh')], {encoding: 'utf8'})
		if (syntax.status !== 0) err('exports.syntax', null, `bash -n: ${syntax.stderr.trim()}`)

		for (const v of unguardedRefs(t, SET_AFTER_EXPORTS)) err('exports.too_early', v, `\`$${v}\` is not set yet when exports.sh is sourced (umbrelOS exports it afterwards). Use a default like \`\${${v}:-...}\` or derive it.`)
		if (/\$\{?APP_DATA_DIR\b/.test(t)) warn('exports.app_data_dir', 'APP_DATA_DIR', 'In exports.sh use EXPORTS_APP_DATA_DIR (this app\'s possibly-moved data) or EXPORTS_APP_DIR; APP_DATA_DIR belongs to whichever app is starting.')
		const code = stripShellComments(t)
		if (RANDOM_SECRET.test(code)) err('exports.random', code.match(RANDOM_SECRET)[0], 'exports.sh is sourced on every lifecycle step; random values change each time. Use derive_entropy.')

		const labels = new Map()
		for (const m of code.matchAll(/derive_entropy\s+("([^"]*)"|'([^']*)'|(\S+))/g)) {
			const label = m[2] ?? m[3] ?? m[4]
			if (labels.has(label)) err('exports.label_reuse', label, `derive_entropy label \`${label}\` is used twice; each secret needs its own label.`)
			labels.set(label, true)
			if (!/app_entropy_identifier|APP_SEED/.test(label) && !label.includes(app)) warn('exports.label_scope', label, `derive_entropy label \`${label}\` is not scoped to this app; use "\${app_entropy_identifier}-<purpose>".`)
		}
		ctx.labels = labels
		this.sourceExports(ctx)
	}

	checkHooks(ctx) {
		const {app, files, hasStorage} = ctx
		const hooks = files.filter((f) => f.startsWith('hooks/') && !f.endsWith('.gitkeep'))
		const gitModes = new Map()
		for (const line of (git(this.root, ['ls-files', '-s', '--', `${app}/hooks`]) ?? '').split('\n').filter(Boolean)) {
			const [mode, , , file] = line.split(/\s+/)
			gitModes.set(file, mode)
		}
		for (const h of hooks) {
			const name = h.slice('hooks/'.length)
			const full = path.join(ctx.dir, h)
			const text = readText(full) ?? ''
			const code = stripShellComments(text)
			if (['pre-uninstall', 'post-uninstall'].includes(name)) this.add(app, 'error', 'hooks.never_run', h, null, `umbreld never runs \`${name}\`.`)
			const mode = gitModes.get(`${app}/${h}`)
			if (mode && mode !== '100755') this.add(app, 'error', 'hooks.git_mode', h, null, `Git mode is ${mode}; umbreld only runs executable hooks. Run: git update-index --chmod=+x ${app}/${h}`)
			// umbrelOS runs hooks by their shebang; /bin/sh is dash there.
			const shell = /^#!.*\b(ba)?sh\b/.test(text.split('\n')[0]) && !/bash/.test(text.split('\n')[0]) ? (spawnSync('dash', ['-c', 'true']).status === 0 ? 'dash' : 'sh') : 'bash'
			const syntax = spawnSync(shell, ['-n', full], {encoding: 'utf8'})
			if (syntax.status !== 0) this.add(app, 'error', 'hooks.syntax', h, null, `${shell} -n: ${syntax.stderr.trim()}`)
			if (hasStorage && /\$\{?APP_DATA_DIR\}?\/data\b/.test(code)) this.add(app, 'error', 'hooks.data_path', h, lineOf(text, 'APP_DATA_DIR'), 'Hooks must write app data through ${APP_DATA_ROOT}; ${APP_DATA_DIR}/data is the old location after the user moves the data root.')
			if (RANDOM_SECRET.test(code)) this.add(app, 'warning', 'hooks.random', h, lineOf(text, code.match(RANDOM_SECRET)[0]), 'Generating secrets in a hook: hook failures are ignored and files outside derive_entropy are not reproducible. Prefer derive_entropy in exports.sh.')
			if (/\b(curl|wget)\b/.test(code)) this.add(app, 'warning', 'hooks.network', h, lineOf(text, code.match(/\b(curl|wget)\b/)[0]), 'Network calls in hooks have no timeout and block the app lifecycle if they hang.')
			if (/^\s*docker\s+(run|pull|exec)\b/m.test(code)) this.add(app, 'warning', 'hooks.docker', h, null, 'Docker commands in hooks run against the host daemon as root; prefer compose services.')
		}
	}

	checkTemplates(ctx) {
		for (const f of ctx.files.filter((f) => f.endsWith('.template'))) {
			if (f.includes('/')) {
				this.add(ctx.app, 'error', 'templates.location', f, null, 'Only top-level *.template files are rendered.')
				continue
			}
			const text = readText(path.join(ctx.dir, f)) ?? ''
			const exported = this.sourceExports(ctx)
			if (!exported) continue
			const unknown = [...composeVariables(text.replace(/\$\$/g, '\u0000'))].filter(([v]) => !RUNTIME_VARS.has(v) && !exported.has(v)).map(([v]) => v)
			if (unknown.length) this.add(ctx.app, 'warning', 'templates.envsubst', f, null, `envsubst replaces every $VAR; these are not exported and become empty: ${unknown.slice(0, 8).join(', ')}${unknown.length > 8 ? ', …' : ''}. Use compose inline config with $$ escaping for files with their own $variables.`)
		}
	}

	checkPackageFiles(ctx) {
		const iconFile = ctx.manifest.icon?.match(/yakitoris-app-store\/[^/]+\/[^/]+\/(.+)$/i)?.[1]
		for (const f of ctx.files) {
			if (UPDATE_COPIED(f) || f.endsWith('.gitkeep')) continue
			if (f === iconFile || (Array.isArray(ctx.manifest.gallery) && ctx.manifest.gallery.some((g) => g.endsWith(`/${ctx.app}/${f}`)))) continue
			if ((ctx.frozen ?? []).some((r) => f === r || f.startsWith(`${r}/`))) continue
			if (f.startsWith('data/')) {
				this.add(ctx.app, 'warning', 'package.seed_file', f, null, 'Seed files under data/ reach fresh installs only, never existing installs, and are not restored by updates.')
				continue
			}
			if (/^icon[^/]*\.(svg|png)$/i.test(f)) {
				this.add(ctx.app, 'warning', 'package.unused_asset', f, null, 'Icon file is not referenced by the manifest `icon` URL.')
				continue
			}
			if (/\.(env|db|sqlite3?|log|pid|pem|key)$/i.test(f) || f === '.env') this.add(ctx.app, 'error', 'package.runtime_artifact', f, null, 'Looks like a secret or runtime artifact; never commit it.')
			else this.add(ctx.app, 'warning', 'package.stray_file', f, null, 'Not installed on update (only compose, exports.sh, top-level *.template, torrc, hooks/ and the manifest are). Remove it, or inline it if the app needs it.')
		}
	}

	// ------------------------------------------------------------ update safety

	checkUpdate(ctx) {
		const {app} = ctx
		const base = this.o.base
		const baseManifestText = git(this.root, ['show', `${base}:${app}/umbrel-app.yml`])
		if (baseManifestText === null) return // new app
		const baseManifest = parseYaml(baseManifestText).value ?? {}
		const changed = (git(this.root, ['diff', '--name-only', base, '--', app]) ?? '')
			.split('\n')
			.filter(Boolean)
			.map((f) => f.slice(app.length + 1))
		const untracked = (git(this.root, ['ls-files', '--others', '--exclude-standard', '--', app]) ?? '').split('\n').filter(Boolean).map((f) => f.slice(app.length + 1))
		const allChanged = [...new Set([...changed, ...untracked])]
		const runtimeFiles = allChanged.filter((f) => f !== 'umbrel-app.yml' && UPDATE_COPIED(f))
		const dataFiles = allChanged.filter((f) => f.startsWith('data/') && !f.endsWith('.gitkeep'))
		if (dataFiles.length) this.add(app, 'warning', 'update.data_files', null, null, `Changed files under data/ (${dataFiles.join(', ')}) reach fresh installs only; existing installs never receive them. Use a hook or inline config if they matter.`)
		const RUNTIME_MANIFEST_KEYS = ['storage', 'environment', 'folderAccess', 'requiresHttps', 'widgets', 'permissions', 'backupIgnore', 'port', 'dependencies', 'deterministicPassword', 'manifestVersion', 'nativeTlsHostnameSuffixes']
		const runtimeKeys = RUNTIME_MANIFEST_KEYS.filter((k) => JSON.stringify(baseManifest[k]) !== JSON.stringify(ctx.manifest[k]))
		const versionChanged = String(baseManifest.version) !== String(ctx.manifest.version)
		const at = (key) => lineOf(ctx.manifestText, `${key}:`)

		if (!versionChanged && (runtimeFiles.length || runtimeKeys.length)) {
			this.add(app, 'error', 'update.version_not_bumped', 'umbrel-app.yml', at('version'), `Runtime changes since ${base} (${[...runtimeFiles, ...runtimeKeys.map((k) => `manifest ${k}`)].join(', ')}) but \`version\` is still ${ctx.manifest.version}. Installed devices only receive changes when the version changes; use ${String(ctx.manifest.version).replace(/-umbrel\.\d+$/, "")}-umbrel.N or the new upstream version.`)
		}
		if (versionChanged && (typeof ctx.manifest.releaseNotes !== 'string' || ctx.manifest.releaseNotes.trim() === '')) {
			this.add(app, 'warning', 'update.release_notes', 'umbrel-app.yml', at('releaseNotes'), 'Version changed but releaseNotes is empty; the update dialog shows them to upgrading users.')
		} else if (versionChanged && baseManifest.releaseNotes === ctx.manifest.releaseNotes) {
			this.add(app, 'warning', 'update.release_notes', 'umbrel-app.yml', at('releaseNotes'), 'Version changed but releaseNotes did not; write notes for people upgrading.')
		}
		if (baseManifest.storage?.dataRoot === 'data' && ctx.manifest.storage?.dataRoot !== 'data') {
			this.add(app, 'error', 'update.storage_removed', 'umbrel-app.yml', at('storage'), 'Removing storage.dataRoot makes the app unstartable for users who moved its data.')
		}
		if (baseManifest.port !== ctx.manifest.port) this.add(app, 'warning', 'update.port_changed', 'umbrel-app.yml', at('port'), `Port changes from ${baseManifest.port} to ${ctx.manifest.port}: bookmarks and client configs break; update exports.sh fallbacks and say so in releaseNotes.`)
		const names = (list, key) => new Set((Array.isArray(list) ? list : []).map((e) => e?.[key]).filter(Boolean))
		for (const [key, field] of [
			['environment', 'name'],
			['folderAccess', 'id'],
		]) {
			const now = names(ctx.manifest[key], field)
			for (const n of names(baseManifest[key], field)) if (!now.has(n)) this.add(app, 'warning', 'update.settings_removed', 'umbrel-app.yml', at(key), `${key} \`${n}\` was removed or renamed; users' saved values for it are dropped.`)
		}

		const baseCompose = parseYaml(git(this.root, ['show', `${base}:${app}/docker-compose.yml`]) ?? '').value
		const baseServices = isObject(baseCompose?.services) ? baseCompose.services : {}
		for (const s of Object.keys(baseServices)) {
			if (!(s in ctx.services)) this.add(app, 'warning', 'update.service_removed', 'docker-compose.yml', null, `Service \`${s}\` was removed or renamed: its container name, settings env and folder mounts change.`)
		}
		for (const [s, cfg] of Object.entries(ctx.services)) {
			const before = baseServices[s]?.image
			const now = cfg?.image
			if (typeof before !== 'string' || typeof now !== 'string' || !DB_IMAGE.test(now)) continue
			const major = (img) => {
				const tag = img.split('@')[0].split(':').pop()
				return tag.match(/-pg(\d+)/)?.[1] ?? tag.match(/^(?:v|pg)?(\d+)/)?.[1]
			}
			if (major(before) && major(now) && major(before) !== major(now)) {
				this.add(app, 'error', 'update.db_major', 'docker-compose.yml', lineOf(ctx.composeText, now), `\`${s}\` changes database major version (${major(before)} → ${major(now)}); the existing data directory will not start without a migration.`)
			}
		}
		const mounts = (services) =>
			new Set(
				Object.values(services)
					.flatMap((cfg) => cfg?.volumes ?? [])
					.filter((v) => typeof v === 'string')
					.map((v) => appDataRelative(volumeParts(v).source))
					.filter((r) => r && r.startsWith('data/')),
			)
		const oldMounts = mounts(baseServices)
		const hookText = ctx.files.filter((f) => f.startsWith('hooks/')).map((f) => readText(path.join(ctx.dir, f))).join('\n')
		for (const m of mounts(ctx.services)) {
			if (oldMounts.has(m)) continue
			const leaf = m.replace(/^data\//, '')
			if (!hookText.includes(leaf)) this.add(app, 'warning', 'update.new_data_dir', 'docker-compose.yml', lineOf(ctx.composeText, m), `New bind source \`${m}\`: existing installs get it created by umbreld as root:root (data/ scaffolding is not copied on update). Add a pre-start hook that creates and chowns it if the container is not root.`)
		}
		if (ctx.labels) {
			const baseExports = git(this.root, ['show', `${base}:${app}/exports.sh`]) ?? ''
			for (const m of stripShellComments(baseExports).matchAll(/derive_entropy\s+("([^"]*)"|'([^']*)'|(\S+))/g)) {
				const label = m[2] ?? m[3] ?? m[4]
				if (!ctx.labels.has(label)) this.add(app, 'error', 'update.label_removed', 'exports.sh', null, `derive_entropy label \`${label}\` was removed or changed; the secret it produced (e.g. the database password) changes and existing data becomes inaccessible.`)
			}
		}
	}

	// ------------------------------------------------------------ official lint + allows

	mergeOfficial(apps) {
		let report
		try {
			report = JSON.parse(fs.readFileSync(this.o.officialLint, 'utf8'))
		} catch (error) {
			this.add('(official)', 'error', 'official.unreadable', null, null, `Could not read official lint output: ${error.message}`)
			return
		}
		for (const issue of report.issues ?? []) {
			const app = String(issue.file ?? '').split('/')[0]
			if (OFFICIAL_EXPECTED.has(issue.rule) && !(issue.rule === 'manifest.release_notes' && issue.severity === 'warning')) continue
			if (!apps.includes(app)) continue
			// Our checker reports these with store-specific wording; avoid duplicates.
			if (['access.docker_socket', 'access.privileged', 'access.host_network'].includes(issue.rule)) continue
			this.issues.push({app, severity: issue.severity, rule: `official:${issue.rule}`, file: issue.file, line: issue.line ?? null, message: issue.message})
		}
	}

	applyAllows(apps) {
		for (const app of apps) {
			const dir = path.join(this.root, app)
			if (!fs.existsSync(dir)) continue
			const allows = new Map()
			for (const f of walk(dir)) {
				const text = readText(path.join(dir, f)) ?? ''
				for (const m of text.matchAll(/#\s*yakitori-allow:\s*([A-Za-z0-9_.:,-]+)\s+(.+)$/gm)) {
					const reason = m[2].trim()
					for (const rule of m[1].split(',')) {
						if (!ALLOWABLE_RULE.test(rule)) this.add(app, 'error', 'allow.not_permitted', f, lineOf(text, m[0]), `\`${rule}\` cannot be allowed; only host access (access.*), image.architecture, image.latest, service.restart and compose.networks can. Fix the finding instead.`)
						else if (reason.split(/\s+/).length < 3) this.add(app, 'error', 'allow.reason', f, lineOf(text, m[0]), `yakitori-allow for \`${rule}\` needs a real reason (3+ words).`)
						else allows.set(rule, reason)
					}
				}
			}
			for (const issue of this.issues) {
				if (issue.app !== app || issue.severity === 'allowed') continue
				const bare = issue.rule.replace(/^official:/, '')
				const reason = allows.get(issue.rule) ?? allows.get(bare)
				if (reason) {
					issue.severity = 'allowed'
					issue.message += ` [allowed: ${reason}]`
				}
			}
		}
	}

	// ------------------------------------------------------------ URLs (optional)

	async checkUrls(apps) {
		for (const app of apps) {
			const mf = parseYaml(readText(path.join(this.root, app, 'umbrel-app.yml')) ?? '').value
			if (!isObject(mf)) continue
			const urls = [mf.icon, ...(Array.isArray(mf.gallery) ? mf.gallery : [])].filter((u) => typeof u === 'string' && /^https?:\/\//.test(u))
			for (const url of urls) {
				try {
					let res = await fetch(url, {method: 'HEAD', redirect: 'follow', signal: AbortSignal.timeout(15_000)})
					if (res.status === 405 || res.status === 403) res = await fetch(url, {redirect: 'follow', signal: AbortSignal.timeout(15_000)})
					const type = res.headers.get('content-type') ?? ''
					if (!res.ok) this.add(app, 'error', 'manifest.url_unreachable', 'umbrel-app.yml', null, `${url} returned HTTP ${res.status}.`)
					else if (!/^image\//.test(type) && !/raw\.githubusercontent\.com/.test(url)) this.add(app, 'warning', 'manifest.url_type', 'umbrel-app.yml', null, `${url} is served as \`${type}\`, not an image.`)
				} catch (error) {
					this.add(app, 'error', 'manifest.url_unreachable', 'umbrel-app.yml', null, `${url}: ${error.message}`)
				}
			}
		}
	}
}

// ---------------------------------------------------------------- report

function report(checker, apps, format) {
	const order = {error: 0, warning: 1, allowed: 2}
	const issues = checker.issues.sort((a, b) => a.app.localeCompare(b.app) || order[a.severity] - order[b.severity] || a.rule.localeCompare(b.rule))
	if (format === 'json') {
		console.log(JSON.stringify({apps, issues}, null, 2))
		return
	}
	const byApp = new Map()
	for (const i of issues) {
		if (!byApp.has(i.app)) byApp.set(i.app, [])
		byApp.get(i.app).push(i)
	}
	for (const app of apps) {
		const list = byApp.get(app) ?? []
		const e = list.filter((i) => i.severity === 'error').length
		const w = list.filter((i) => i.severity === 'warning').length
		console.log(`\n${app}: ${e} error(s), ${w} warning(s)${list.length - e - w ? `, ${list.length - e - w} allowed` : ''}`)
		for (const i of list) {
			const where = i.line ? `${i.file}:${i.line}` : i.file
			console.log(`  ${i.severity.toUpperCase().padEnd(7)} ${i.rule}  ${where}\n          ${i.message}`)
		}
	}
	for (const [app, list] of byApp) if (!apps.includes(app)) for (const i of list) console.log(`\n${i.severity.toUpperCase()} ${i.rule}: ${i.message}`)
	const errors = issues.filter((i) => i.severity === 'error').length
	const warnings = issues.filter((i) => i.severity === 'warning').length
	console.log(`\n${errors} error(s), ${warnings} warning(s) across ${apps.length} app(s).${checker.o.official ? '' : ' (No --official dir: collisions with the official store were NOT checked.)'}`)
}

const options = parseArgs(process.argv.slice(2))
const checker = new Checker(options)
const apps = checker.run()
if (options.checkUrls) await checker.checkUrls(apps)
report(checker, apps, options.format)
process.exit(checker.issues.some((i) => i.severity === 'error') ? 1 : 0)
