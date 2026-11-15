import { build } from 'esbuild';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));

const REPOSITORY = 'https://github.com/ydddp/mail-hub';
// The script is installed from the user's own Mail Hub, which replaces this
// mark with its origin when serving it (src/userscript-route.ts). Update URL
// and the default connection address therefore always point back at it.
const ORIGIN_MARK = '%%MAILHUB_ORIGIN%%';
const SCRIPT_URL = `${ORIGIN_MARK}/userscript/mail-hub.user.js`;

const metadata = `// ==UserScript==
// @name         Mail Hub 邮箱助手
// @namespace    ${REPOSITORY}/userscript
// @version      ${pkg.version}
// @description  用你自己的 Mail Hub 临时邮箱收取验证码，手动上报成功并关闭。
// @author       ydddp
// @match        http://*/*
// @match        https://*/*
// @run-at       document-idle
// @noframes
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_deleteValue
// @grant        GM_getTab
// @grant        GM_saveTab
// @grant        GM_registerMenuCommand
// @connect      *
// @updateURL    ${SCRIPT_URL}
// @downloadURL  ${SCRIPT_URL}
// @supportURL   ${REPOSITORY}/issues
// ==/UserScript==
`;

const result = await build({
  entryPoints: [join(here, 'src', 'main.ts')],
  outfile: join(here, 'mail-hub.user.js'),
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: ['chrome120', 'firefox128'],
  charset: 'utf8',
  legalComments: 'none',
  sourcemap: false,
  minify: false,
  write: false,
  logLevel: 'warning',
  loader: { '.css': 'text' },
  define: { __MAILHUB_SERVED_FROM__: JSON.stringify(ORIGIN_MARK) },
  banner: { js: metadata },
});

const output = result.outputFiles[0].text;

// The install file must be self-contained: a bare import would silently wait on
// a module loader the target page does not have.
const bareImport = output.match(/^\s*(?:import\s|export\s|require\()/m);
if (bareImport) throw new Error(`bundled script still has a module reference: ${bareImport[0].trim()}`);
if (!output.includes('==UserScript==')) throw new Error('metadata block missing from build output');
if (!output.includes(`@version      ${pkg.version}`)) throw new Error('version in metadata does not match package.json');
if (!output.includes(`@updateURL    ${SCRIPT_URL}`) || !output.includes(JSON.stringify(ORIGIN_MARK))) {
  throw new Error('origin mark missing: the server could not point the script back at itself');
}

writeFileSync(join(here, 'mail-hub.user.js'), output, 'utf8');
console.log(`userscript/mail-hub.user.js  ${pkg.version}  ${(Buffer.byteLength(output) / 1024).toFixed(1)} KiB`);
