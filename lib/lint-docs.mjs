import fs from 'node:fs';
import path from 'node:path';

const SKIPPED_DIRS = new Set(['.git', 'node_modules', 'target', 'tmp', 'dist']);
const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\u2E80-\u2FDF\u3000-\u303F\u3100-\u312F\u31A0-\u31BF\u31C0-\u31EF\u31F0-\u31FF\u3200-\u33FF\uFE30-\uFE4F\uFF00-\uFFEF]/u;
const RULES = [
  { rule: 'local-path', pattern: /\/Users\/|\/mac\/work|\$HOME\/\.cargo\/bin|\/private\/var\// },
  { rule: 'codename', pattern: /\bR\d{1,2}\b|round-\d+|Round \d+|r\d+_[a-z]/ },
  { rule: 'figure-caption', pattern: /^\*Figure \d+:/ },
  { rule: 'boilerplate', pattern: /All published source, comments and documentation are written in English\./ },
  { rule: 'cjk', pattern: CJK },
  { rule: 'self-deprecating', pattern: /no invented|never a fake|fake pass|no real hardware|not implemented here/i },
];
const RULE_ORDER = new Map(RULES.map(({ rule }, index) => [rule, index]));

function compareText(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

function fenceMarker(line) {
  return /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1] ?? null;
}

export function markdownFiles(root = '.') {
  const absoluteRoot = path.resolve(root);
  const files = [];
  const walk = (dir) => {
    const entries = fs.readdirSync(dir, { withFileTypes: true })
      .sort((a, b) => compareText(a.name, b.name));
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!SKIPPED_DIRS.has(entry.name)) walk(full);
      } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) {
        files.push(full);
      }
    }
  };
  walk(absoluteRoot);
  return files;
}

function findingsFor(absoluteRoot, files) {
  const findings = [];
  for (const file of files) {
    const name = path.relative(absoluteRoot, file).split(path.sep).join('/');
    let fence = null;
    const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
    for (let index = 0; index < lines.length; index++) {
      const line = lines[index];
      const marker = fenceMarker(line);
      if (marker) {
        if (!fence) fence = marker;
        else if (marker[0] === fence[0] && marker.length >= fence.length) fence = null;
        continue;
      }
      if (fence) continue;
      for (const { rule, pattern } of RULES) {
        if (pattern.test(line)) {
          findings.push({ file: name, line: index + 1, rule, text: line });
        }
      }
    }
  }
  return findings.sort((a, b) => compareText(a.file, b.file)
    || a.line - b.line
    || RULE_ORDER.get(a.rule) - RULE_ORDER.get(b.rule));
}

export function lintDocs(root = '.') {
  const absoluteRoot = path.resolve(root);
  return findingsFor(absoluteRoot, markdownFiles(absoluteRoot));
}

export function runLintDocs({ root = '.', log = console.log } = {}) {
  const absoluteRoot = path.resolve(root);
  const files = markdownFiles(absoluteRoot);
  const findings = findingsFor(absoluteRoot, files);
  const fileWord = files.length === 1 ? 'file' : 'files';
  if (findings.length === 0) {
    log(`lint-docs ok: ${files.length} Markdown ${fileWord} scanned`);
    return 0;
  }
  for (const finding of findings) {
    log(`${finding.file}:${finding.line}: ${finding.rule}: ${finding.text}`);
  }
  const findingWord = findings.length === 1 ? 'finding' : 'findings';
  log(`lint-docs: ${findings.length} ${findingWord} in ${files.length} Markdown ${fileWord} scanned`);
  return 1;
}
