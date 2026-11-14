import fs from 'node:fs';
import path from 'node:path';
import { CLI_ROOT } from './paths.mjs';
import { TARGETS } from './targets.mjs';

// Resized from LOGO-Compress.png (sha256 cce868ae0e0e20ae7e380e92f96f0a105a758eac23c56e1d1dc521fa34b6a4e9); embedded so init needs no sibling checkout.
const LOGO_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAIAAAACACAMAAAD04JH5AAADAFBMVEVaxcca0+oX3PAX2OsW2+8U2/AT2fAT2O8S1+4SzOwP1vAO' +
  'z+4Nw/ANvPQNuvcNuvINt/QNs/INre0C+v4J1e4Kx/EHvvALsvUEqvsLqPMLrOgMqexMkMQWj+gMpvAOje0LpfMLnvUKovQKmPEJ' +
  'oPUJm/IJlu0Jh+4Il/IIj/MIgu0IgOoIfuwIf+kIfewIfOgIeegIdugIdegHi/gGgvMAf+QHfO4Heu4HeeoHduwHdegTb94CAQIA' +
  'UNAAANYAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
  'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
  'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
  'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
  'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
  'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
  'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
  'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAACZFnRUAAAAQXRSTlP/////' +
  '////////////////////////////////////////////////////////////////////////////////ADBV7McAAA1RSURBVHja' +
  '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';
const LOGO_PNG = Buffer.from(LOGO_PNG_BASE64, 'base64');

export const TEMPLATES = Object.freeze([
  'blank', 'counter', 'dashboard', 'fullstack', 'particles', 'project',
]);
const ENTRY = Object.freeze({
  blank: ['blank.opu', 'main.opu'],
  counter: ['main.opu', 'main.opu'],
  dashboard: ['dashboard.opu', 'main.opu'],
  fullstack: ['fullstack.opu', 'main.opu'],
  particles: ['particles.opu', 'particles.opu'],
});

const BRAND_README = '\n![OPUROM](logo.png)\n\n' +
  '`logo.png` is the 128x128 project image; `favicon.ico` and `index.html` use it.\n';
const INDEX_HTML = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>OPUROM</title>
  <!-- favicon.ico is generated from logo.png. -->
  <link rel="icon" type="image/x-icon" href="favicon.ico">
</head>
<body>
  <p>See <a href="README.md">README.md</a> for build commands.</p>
</body>
</html>
`;

function faviconIco(png) {
  const header = Buffer.alloc(22);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(1, 4);
  header[6] = 128;
  header[7] = 128;
  header.writeUInt16LE(1, 10);
  header.writeUInt16LE(32, 12);
  header.writeUInt32LE(png.length, 14);
  header.writeUInt32LE(header.length, 18);
  return Buffer.concat([header, png]);
}

const FAVICON_ICO = faviconIco(LOGO_PNG);

function writeBrandFiles(target) {
  fs.writeFileSync(path.join(target, 'logo.png'), LOGO_PNG);
  fs.writeFileSync(path.join(target, 'favicon.ico'), FAVICON_ICO);
  fs.writeFileSync(path.join(target, 'index.html'), INDEX_HTML);
}

export function init(dir, { cwd = process.cwd(), template = 'counter' } = {}) {
  if (!TEMPLATES.includes(template)) {
    throw new Error(`unknown template: ${template} (expected one of ${TEMPLATES.join(', ')})`);
  }
  const target = path.resolve(cwd, String(dir));
  if (fs.existsSync(target)) {
    if (!fs.statSync(target).isDirectory()) throw new Error(`not a directory: ${target}`);
    if (fs.readdirSync(target).length > 0) {
      throw new Error(`refusing to overwrite non-empty directory: ${target}`);
    }
  }

  const name = path.basename(target);
  const config = { name, targets: [...TARGETS] };
  const templates = path.join(CLI_ROOT, 'templates');
  if (template === 'project') {
    // Module roots let a nested module import a sibling by file name without '..'.
    config.moduleRoots = ['models', 'views'];
    fs.cpSync(path.join(templates, 'project'), target, { recursive: true });
  } else {
    const [source, entry] = ENTRY[template];
    fs.mkdirSync(path.join(target, 'src'), { recursive: true });
    fs.copyFileSync(path.join(templates, source), path.join(target, 'src', entry));
    fs.writeFileSync(
      path.join(target, 'README.md'),
      `# ${name}\n${BRAND_README}\n` +
        `Generated by \`opurom init\` with the \`${template}\` template. ` +
        `Edit [src/${entry}](src/${entry}), then:\n\n` +
        '```sh\n' +
        `node <path-to>/opurom-cli/bin/opurom.mjs check src/${entry}\n` +
        `node <path-to>/opurom-cli/bin/opurom.mjs build --src src/${entry} --target web --out dist/web\n` +
        `node <path-to>/opurom-cli/bin/opurom.mjs dev --src src/${entry}\n` +
        '```\n',
    );
  }
  writeBrandFiles(target);
  fs.writeFileSync(path.join(target, 'opurom.json'), `${JSON.stringify(config, null, 2)}\n`);
  fs.writeFileSync(path.join(target, '.gitignore'), 'node_modules/\n.DS_Store\ndist/\ntmp/\n');
  return target;
}
