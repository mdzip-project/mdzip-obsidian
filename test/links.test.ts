// Runs the MDZip spec's link resolution fixture against src/links.ts.
// Fixture copied from mdzip-spec examples/fixtures/link-resolution-cases.json
// (1.2.0-draft); refresh it when the spec's copy changes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolveLink, samePath, type LinkHost, type LinkSource } from '../src/links.ts';

interface FixtureArchive {
  entries: string[];
  entryPoint: string;
}
interface Fixture {
  host: { files: string[]; directories: string[]; archives: Record<string, FixtureArchive> };
  cases: {
    name: string;
    from: LinkSource;
    link: string;
    context?: { hostLocation?: boolean; outsideLinks?: boolean; intoArchiveLinks?: boolean };
    expected: Record<string, unknown>;
  }[];
}

const fixture: Fixture = JSON.parse(
  readFileSync(new URL('./fixtures/link-resolution-cases.json', import.meta.url), 'utf8')
);
const { files, directories, archives } = fixture.host;

for (const c of fixture.cases) {
  test(c.name, async () => {
    const host: LinkHost = {
      kind: (p) => (archives[p] ? 'archive' : files.includes(p) ? 'file' : directories.includes(p) ? 'directory' : null),
      findEntry: async (archive, entry) => archives[archive]?.entries.find((e) => samePath(e, entry)) ?? null,
      entryPoint: async (archive) => archives[archive]?.entryPoint ?? null,
      ...c.context,
    };
    assert.deepEqual(await resolveLink(c.from, c.link, host), c.expected);
  });
}
