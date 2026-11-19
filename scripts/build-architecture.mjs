#!/usr/bin/env node
// Draws each pattern's architecture.png from the Mermaid flowchart under "## Architecture" in its README.md, with
// the AWS Architecture Icons in docs/architecture/icons (needs rsvg-convert: `brew install librsvg` or
// `apt-get install librsvg2-bin`). The README block is the only source; edit it, then run `npm run diagrams`.
// Usage: node scripts/build-architecture.mjs [--check] [pattern-folder ...]
//   --check: parse every block and fail on an unknown icon or a node without a position (no rendering).
//
// The flowchart, as GitHub renders it, plus layout comments GitHub hides:
//   flowchart LR
//     %% at viewer 0 0                     place node "viewer" at column 0, row 0 (0-based grid)
//     subgraph dist["Distribution"]        a group box; the id prefix picks the style: dist, aws, vpc
//       cloudfront["Amazon CloudFront"]
//       fn{{"viewer-request function"}}
//     end
//     fn -->|"cf.fetch GET /hello"| lambda_origin
//     kvs_store -.->|"async"| fn           -.-> is drawn dashed
// A node's id up to the first "_" names its icon: viewer, cloudfront, lambda, api-gateway (apigw), sqs, dynamodb
// (ddb), s3, cognito, elb (alb), vpc, waf, secrets (secrets-manager), eventbridge, ec2, agent, edge-location,
// fn (the CloudFront Functions resource icon), and kvs (drawn: the icon set has no KeyValueStore icon). An edge whose label starts with cf.fetch or cf.beacon is the network call (orange).

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const ICONS = path.join(ROOT, 'docs/architecture/icons');

const CELL_W = 230;
const CELL_H = 170;
const MARGIN = 40;
const ICON = 64;
const COLORS = {
  call: '#ED7100',
  flow: '#232F3E',
  async: '#7D8998',
  aws: '#232F3E',
  dist: '#8C4FFF',
  vpc: '#7AA116',
};

const escapeXml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const ALIASES = { apigw: 'api-gateway', ddb: 'dynamodb', alb: 'elb', secrets: 'secrets-manager', fn: 'cloudfront-functions' };

function architectureBlock(readme, file) {
  const at = readme.indexOf('\n## Architecture');
  if (at === -1) throw new Error(`${file}: no "## Architecture" section`);
  const open = readme.indexOf('```mermaid', at);
  const close = readme.indexOf('```', open + 10);
  const next = readme.indexOf('\n## ', at + 5);
  if (open === -1 || (next !== -1 && open > next)) throw new Error(`${file}: no mermaid block under "## Architecture"`);
  return readme.slice(open + 10, close);
}

function parse(block, file) {
  const nodes = new Map();
  const groups = [];
  const edges = [];
  const pos = new Map();
  let group = null;
  const label = (s) => s.replace(/^"|"$/g, '').replace(/<br\/?>/g, '\n').replace(/#quot;/g, '"');
  const addNode = (id, text) => {
    if (!nodes.has(id)) nodes.set(id, { id, label: id });
    if (text !== undefined) nodes.get(id).label = label(text);
    if (group && !group.nodes.includes(id)) group.nodes.push(id);
  };
  for (const raw of block.split('\n')) {
    const line = raw.trim();
    let m;
    if (!line || line.startsWith('flowchart')) continue;
    if ((m = line.match(/^%%\s*at\s+(\S+)\s+(\d+)\s+(\d+)/))) { pos.set(m[1], { col: +m[2], row: +m[3] }); continue; }
    if (line.startsWith('%%')) continue;
    if ((m = line.match(/^subgraph\s+(\w+)(?:\["?(.*?)"?\])?$/))) {
      group = { id: m[1], label: m[2] ? label(m[2]) : m[1], style: m[1].split('_')[0], nodes: [] };
      groups.push(group);
      continue;
    }
    if (line === 'end') { group = null; continue; }
    if ((m = line.match(/^(\w+)\s*(-\.->|-->)\s*(?:\|(.*?)\|\s*)?(\w+)$/))) {
      addNode(m[1]); addNode(m[4]);
      const text = m[3] ? label(m[3]) : '';
      edges.push({ from: m[1], to: m[4], label: text,
        style: m[2] === '-.->' ? 'async' : /^\d*\.?\s*cf\.(fetch|beacon)/.test(text) ? 'call' : 'flow' });
      continue;
    }
    if ((m = line.match(/^(\w+)\s*(?:\[\(|\{\{|\[)(.*?)(?:\)\]|\}\}|\])$/))) { addNode(m[1], m[2]); continue; }
    throw new Error(`${file}: cannot read this architecture line: ${line}`);
  }
  for (const n of nodes.values()) {
    const prefix = n.id.split('_')[0];
    n.icon = ALIASES[prefix] || prefix;
    if (n.icon !== 'kvs' && !existsSync(path.join(ICONS, n.icon + '.png'))) {
      throw new Error(`${file}: node ${n.id}: no icon "${n.icon}" in docs/architecture/icons`);
    }
    const p = pos.get(n.id);
    if (!p) throw new Error(`${file}: node ${n.id} has no "%% at ${n.id} <col> <row>" line`);
    Object.assign(n, p);
  }
  return { nodes: [...nodes.values()], groups, edges };
}

function center(n) {
  return { x: MARGIN + n.col * CELL_W + CELL_W / 2, y: MARGIN + 30 + n.row * CELL_H + ICON / 2 };
}

function iconSvg(n) {
  const { x, y } = center(n);
  const left = x - ICON / 2;
  const top = y - ICON / 2;
  let shape;
  if (n.icon === 'kvs') {
    const rx = ICON / 2;
    const ry = 9;
    shape = `<path d="M${left} ${top + ry} v${ICON - 2 * ry} a${rx} ${ry} 0 0 0 ${ICON} 0 v-${ICON - 2 * ry}" fill="#8C4FFF"/>` +
      `<ellipse cx="${x}" cy="${top + ry}" rx="${rx}" ry="${ry}" fill="#B48CFF"/>` +
      `<text x="${x}" y="${y + 14}" font-family="Helvetica, Arial, sans-serif" font-size="16" font-weight="bold" fill="#fff" text-anchor="middle">KVS</text>`;
  } else {
    const data = readFileSync(path.join(ICONS, n.icon + '.png')).toString('base64');
    shape = `<image x="${left}" y="${top}" width="${ICON}" height="${ICON}" href="data:image/png;base64,${data}"/>`;
  }
  const label = String(n.label).split('\n').map((line, i) =>
    `<text x="${x}" y="${top + ICON + 20 + i * 16}" font-family="Helvetica, Arial, sans-serif" font-size="13" fill="#232F3E" text-anchor="middle">${escapeXml(line)}</text>`).join('');
  return shape + label;
}

// Right-angle connector between two nodes: straight when they share a row or column, else an elbow.
function edgeSvg(spec, e, i) {
  const a = spec.nodes.find((n) => n.id === e.from);
  const b = spec.nodes.find((n) => n.id === e.to);
  const pa = center(a);
  const pb = center(b);
  const gap = ICON / 2 + 8;
  const color = COLORS[e.style] || COLORS.flow;
  const dash = e.style === 'async' ? ' stroke-dasharray="6 5"' : '';
  let d;
  let lx;
  let ly;
  if (a.row === b.row) {
    const dir = Math.sign(pb.x - pa.x);
    const off = (e.offset || 0) * 14;
    d = `M${pa.x + dir * gap} ${pa.y + off} H${pb.x - dir * gap}`;
    lx = (pa.x + pb.x) / 2;
    ly = pa.y + off - 8;
  } else if (a.col === b.col) {
    const dir = Math.sign(pb.y - pa.y);
    const off = (e.offset || 0) * 14;
    d = `M${pa.x + off} ${pa.y + dir * (gap + (dir > 0 ? 34 : 0))} V${pb.y - dir * (gap + (dir < 0 ? 34 : 0))}`;
    lx = pa.x + off + 8;
    ly = (pa.y + pb.y) / 2;
  } else {
    const dirX = Math.sign(pb.x - pa.x);
    const dirY = Math.sign(pb.y - pa.y);
    d = `M${pa.x + dirX * gap} ${pa.y} H${pb.x} V${pb.y - dirY * (gap + (dirY < 0 ? 34 : 0))}`;
    lx = (pa.x + pb.x) / 2;
    ly = pa.y - 8;
  }
  const anchor = a.col === b.col && a.row !== b.row ? 'start' : 'middle';
  const label = e.label ? String(e.label).split('\n').map((line, j) =>
    `<text x="${lx}" y="${ly - (String(e.label).split('\n').length - 1 - j) * 14}" font-family="Helvetica, Arial, sans-serif" font-size="12" fill="${color}" text-anchor="${anchor}" paint-order="stroke" stroke="#fff" stroke-width="4">${escapeXml(line)}</text>`).join('') : '';
  return `<path d="${d}" fill="none" stroke="${color}" stroke-width="2"${dash} marker-end="url(#arrow-${e.style || 'flow'})"/>` + label;
}

function groupSvg(spec, g) {
  const nodes = g.nodes.map((id) => spec.nodes.find((n) => n.id === id));
  const minCol = Math.min(...nodes.map((n) => n.col));
  const maxCol = Math.max(...nodes.map((n) => n.col));
  const minRow = Math.min(...nodes.map((n) => n.row));
  const maxRow = Math.max(...nodes.map((n) => n.row));
  const pad = g.style === 'aws' ? 4 : 6;
  const x = MARGIN + minCol * CELL_W + pad;
  const y = MARGIN + minRow * CELL_H + (g.style === 'aws' ? 0 : 8);
  const w = (maxCol - minCol + 1) * CELL_W - 2 * pad;
  const h = (maxRow - minRow + 1) * CELL_H - (g.style === 'aws' ? 0 : 16);
  const color = COLORS[g.style] || COLORS.aws;
  const dash = g.style === 'dist' ? ' stroke-dasharray="8 5"' : '';
  return `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="none" stroke="${color}" stroke-width="1.5"${dash}/>` +
    `<text x="${x + 10}" y="${y + 18}" font-family="Helvetica, Arial, sans-serif" font-size="13" font-weight="bold" fill="${color}">${escapeXml(g.label)}</text>`;
}

function svg(spec) {
  const cols = Math.max(...spec.nodes.map((n) => n.col)) + 1;
  const rows = Math.max(...spec.nodes.map((n) => n.row)) + 1;
  const width = cols * CELL_W + 2 * MARGIN;
  const height = rows * CELL_H + 2 * MARGIN;
  const markers = Object.entries({ call: COLORS.call, flow: COLORS.flow, async: COLORS.async }).map(([k, c]) =>
    `<marker id="arrow-${k}" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto-start-reverse">` +
    `<path d="M1 1 L9 5 L1 9" fill="none" stroke="${c}" stroke-width="1.6"/></marker>`).join('');
  // Outer groups first so inner ones draw on top.
  const groups = [...(spec.groups || [])].sort((a, b) => b.nodes.length - a.nodes.length).map((g) => groupSvg(spec, g)).join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">` +
    `<defs>${markers}</defs><rect width="100%" height="100%" fill="#fff"/>${groups}` +
    spec.edges.map((e, i) => edgeSvg(spec, e, i)).join('') + spec.nodes.map(iconSvg).join('') + '</svg>';
}

function run() {
  const args = process.argv.slice(2);
  const check = args.includes('--check');
  const only = args.filter((a) => !a.startsWith('--')).map((a) => path.basename(a));
  const dirs2 = readdirSync(path.join(ROOT, 'patterns')).filter((d) => /^\d\d-/.test(d) && (!only.length || only.includes(d)));
  let drawn = 0;
  for (const d of dirs2) {
    const file = path.join('patterns', d, 'README.md');
    const readme = readFileSync(path.join(ROOT, file), 'utf8');
    if (!readme.includes('\n## Architecture')) continue;
    const spec = parse(architectureBlock(readme, file), file);
    drawn++;
    if (check) continue;
    execFileSync('rsvg-convert', ['--zoom', '2', '-o', path.join(ROOT, 'patterns', d, 'architecture.png')], { input: svg(spec) });
    console.log(`✔ patterns/${d}/architecture.png`);
  }
  if (check) console.log(`✔ ${drawn} architecture diagrams parse`);
}

run();
