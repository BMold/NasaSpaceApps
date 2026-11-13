// Prints docs/documentacion/documentacion.html to ARES-TWIN-documentacion.pdf
// with headless Google Chrome (no extra npm dependency). Set CHROME_PATH if
// Chrome is installed somewhere else.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const src = fileURLToPath(new URL('../docs/documentacion/documentacion.html', import.meta.url));
const out = fileURLToPath(new URL('../ARES-TWIN-documentacion.pdf', import.meta.url));

const candidates = [
  process.env.CHROME_PATH,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
].filter(Boolean);
const chrome = candidates.find((p) => existsSync(p));
if (!chrome) {
  console.error('Google Chrome not found. Set CHROME_PATH to its executable.');
  process.exit(1);
}

// A throwaway profile, so the user's own Chrome profile is never touched.
const profile = mkdtempSync(join(tmpdir(), 'ares-twin-pdf-'));
execFileSync(
  chrome,
  [
    '--headless=new',
    `--user-data-dir=${profile}`,
    '--no-first-run',
    '--disable-gpu',
    '--no-pdf-header-footer',
    '--virtual-time-budget=15000',
    '--run-all-compositor-stages-before-draw',
    `--print-to-pdf=${out}`,
    pathToFileURL(src).href,
  ],
  { stdio: ['ignore', 'ignore', 'ignore'], cwd: root },
);
rmSync(profile, { recursive: true, force: true });
console.log(`ARES-TWIN-documentacion.pdf generated (${Math.round(statSync(out).size / 1024)} KB)`);
