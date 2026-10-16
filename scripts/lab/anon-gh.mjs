/**
 * Lab only. A read-only stand-in for `gh` that talks to api.github.com with NO token, so a dry run can look at the
 * real repository and be unable to change it: anything but a GET throws. Answers are cached on disk (the anonymous
 * limit is 60 calls an hour). Never ported.
 *
 * It understands exactly what scripts/ci/carry-over.mjs asks:
 *   pr list --repo R ... --json a,b       pr view N --repo R --json a,b       api PATH [--paginate] [--jq EXPR]
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';

const CACHE = process.env.ANON_CACHE || '/tmp/anon-gh-cache';
mkdirSync(CACHE, { recursive: true });
export const stats = { network: 0, cached: 0 };

function get(url) {
  const file = join(CACHE, createHash('sha1').update(url).digest('hex'));
  if (existsSync(file)) { stats.cached += 1; return JSON.parse(readFileSync(file, 'utf8')); }
  // curl, with no Authorization header at all.
  const out = execFileSync('curl', ['-sS', '-D', '-', '-H', 'Accept: application/vnd.github+json', url], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  stats.network += 1;
  const split = out.indexOf('\r\n\r\n');
  const head = out.slice(0, split);
  const body = out.slice(split + 4);
  const status = Number(/^HTTP\/\S+ (\d+)/.exec(head)?.[1]);
  if (status !== 200) throw new Error(`GET ${url} -> ${status} ${body.slice(0, 120)}`);
  const next = /<([^>]+)>;\s*rel="next"/.exec(head)?.[1] ?? null;
  const value = { body: JSON.parse(body), next };
  writeFileSync(file, JSON.stringify(value));
  return value;
}

const jq = (expr, json) => execFileSync('jq', ['-c', expr], { input: JSON.stringify(json), encoding: 'utf8' }).trim();

export function anonGh(args) {
  const [a, b] = args;
  const flag = (name) => args[args.indexOf(name) + 1];
  const repo = flag('--repo');
  if (a === 'pr' && b === 'list') {
    const out = [];
    for (let url = `https://api.github.com/repos/${repo}/pulls?state=open&base=testing&per_page=100`; url;) {
      const r = get(url);
      out.push(...r.body);
      url = r.next;
    }
    return JSON.stringify(out.map((p) => ({
      number: p.number, body: p.body, headRefName: p.head.ref, headRefOid: p.head.sha, isCrossRepository: p.head.repo?.full_name !== repo,
      baseRefName: p.base.ref, labels: p.labels.map((l) => ({ name: l.name }))
    })));
  }
  if (a === 'pr' && b === 'view') {
    const p = get(`https://api.github.com/repos/${repo}/pulls/${args[2]}`).body;
    // `mergeable` is null while GitHub is still working it out: that reads as not conflicting here, as it would to a retry.
    return JSON.stringify({ mergeable: p.mergeable === false ? 'CONFLICTING' : 'MERGEABLE', body: p.body, changedFiles: p.changed_files, headRefOid: p.head.sha });
  }
  if (a === 'api') {
    if (args.includes('-X') || args.includes('--method') || args.includes('-f') || args.includes('-F') || args.includes('--input')) throw new Error('read-only: this stand-in only does GET');
    const path = args.find((x, i) => i > 0 && !x.startsWith('-') && args[i - 1] !== '--jq' && args[i - 1] !== '-q');
    const expr = args.includes('--jq') ? flag('--jq') : null;
    const paginate = args.includes('--paginate');
    const lines = [];
    let doc;
    for (let url = `https://api.github.com/${path}${path.includes('?') ? '&' : '?'}per_page=100`; url;) {
      const r = get(url);
      doc = r.body;
      if (expr) lines.push(jq(expr, r.body));
      url = paginate ? r.next : null;
    }
    return expr ? `${lines.filter(Boolean).join('\n')}\n` : JSON.stringify(doc);
  }
  throw new Error(`read-only: not understood: ${args.join(' ')}`);
}
