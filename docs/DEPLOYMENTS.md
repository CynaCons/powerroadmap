# Deployment ledger

**Observed** state of every PowerRoadmap deployment surface. Update it from what
you actually saw — a query, a fetch, a page you opened — never from what a
workflow's exit text implied or from what you expect to be true. The runbook is
[`RELEASING.md`](RELEASING.md).

Repository: `CynaCons/powerroadmap` — renamed from `CynaCons/powerplanner` on
2026-10-28. Observations recorded before that date name the old repository and
are left as they were observed; the old name still resolves.

## Current state — observed 2026-11-02

| Surface | State | Observed |
|---|---|---|
| GitHub release (latest) | `v2.35.0`, non-draft, not prerelease, published 2026-11-02T11:43:13Z from `main` | `gh release view v2.35.0 --json` |
| Release assets | `PowerRoadmap.html` alone — 427,603 bytes | `gh release view --json assets` |
| Asset integrity | `b5f61ae9240de043c7b45a14f393ecdd837201133aba259e2f430e983adfb440`, and **four independent reads agree**: the digest GitHub reports, the downloaded asset, the committed git blob at the tag, and the on-disk template | `gh release download`, `git cat-file blob v2.35.0:dist-template/index.html`, `sha256sum` |
| Published app runs | the downloaded asset opened **straight off the filesystem, no server**, passed all 14 release checks: version 2.35.0 in the bytes, a finger drags a bar 122.6px, the chart is a named tab stop that arrow keys drive, Enter presses a focused button, F2 renames a clicked bar, ctrl-click adds and removes, handles 16×24 / 24×24, 0 of 134 text runs under AA in both themes, today ≠ deadline, the crowded grid held at 0.329 opacity, and a modal keeps focus through 10 Tabs | `scratchpad/verify-v2350.mjs` against the downloaded file |
| Build & Release workflow | `completed/success` for tag `v2.35.0`, 1m39s, run `41438818946` | `gh run list` |
| Web CI | `completed/success` on `main`, 1m49s, run `41438803664` | same |
| GitHub Pages | HTTP 200 at https://cynacons.github.io/powerroadmap/ | `curl` |
| Pages deploy | **none for this release, correctly** — `site/` is untouched by both commits, and `deploy-site.yml` only runs on a push that touches it. Last deploy 2026-10-28. | `git diff --name-only -- site/`, `gh run list --workflow deploy-site.yml` |
| `src/version.ts` | `2.35.0` | repo |
| `package.json` | `2.35.0` — matches | repo |
| `dist-template/index.html` | tracked and rebuilt at the tag; blob and on-disk digests agree and `git status` is clean | repo |
| npm | not a surface — nothing published | DECISIONS.md D5 |
| MCP Registry | not a surface — nothing published | DECISIONS.md D5 |

### The update routes, re-measured at v2.35.0

| Route | Answer |
|---|---|
| `api.github.com/repos/CynaCons/powerroadmap/releases/latest` | HTTP 200, `v2.35.0` |
| `api.github.com/repos/CynaCons/powerplanner/releases/latest` | HTTP 301 to the above, resolving to `v2.35.0` — the redirect every build before v2.20.0 depends on, still alive |


The bar count moved from 99 at v2.28.0 to 33 here. That is a counting change,
not a regression: 99 was three SVG rects per bar, and 33 agrees with what the
status bar itself reports — `33 tasks`.

### The update routes, re-measured at v2.34.1

All four fetched 2026-10-30 after the release, not inferred:

| Route | Observed |
|---|---|
| `raw…/CynaCons/powerroadmap/main/package.json` | `2.34.1` |
| `api.github.com/repos/CynaCons/powerroadmap/releases/latest` | `v2.34.1` |
| `api.github.com/repos/CynaCons/powerplanner/releases/latest` — the **old** name, which every build before v2.20.0 asks for | `v2.34.1`, through a `301` to `/repositories/1250571066/releases/latest` |
| `raw…/CynaCons/powerroadmap/v2.34.1/dist-template/index.html` | `200`, 419,816 bytes, digest `94356d66…` — identical to the published asset |

The third row is the one that matters: builds in the wild compiled the old
repository name in and cannot be corrected remotely. They still find this
release.

The digest trap below did not spring this time, and the reason is the one the
section gives: `dist-template/index.html` had been written by
`npm run build:template`, so it was LF on disk and matched its own blob. Hashing
the working copy happened to be safe here. It is still the wrong habit — hash
the blob.

### A digest trap on Windows

`core.autocrlf=true` and no `.gitattributes`, so `dist-template/index.html` is
*checked out* with CRLF: at v2.20.0, 378,167 bytes on disk against a
377,854-byte blob. The blob is what the Linux runner checks out and publishes,
so hashing the local working copy gives a different digest and looks like a
failed release. Hash `git cat-file blob HEAD:dist-template/index.html`, not the
file on disk.

It depends on how the file got there, which is why it does not bite every time.
A file written by `npm run build:template` is LF and matches the blob — at
v2.21.0 both were 388,308 bytes and `git status` stayed clean after the rebuild.
A file restored by `git checkout --` is CRLF and does not. So the trap springs
after a checkout, not after a build. A `.gitattributes` pinning the template to
LF would remove the distinction; it is in the backlog.

## Asset names — one file, from v2.22.0

Releases up to and including v2.21.0 carried the single-file app three times,
as `PowerRoadmap.html`, `PowerGantt.html` and `PowerPlanner.html`, on the
reasoning that an installed build looks for the asset name it shipped with and
would be stranded without its own.

That reasoning was wrong, and checking it is what retired the aliases. The
updater does not read the release asset at all: `fetchBuild()` in
`src/utils/updateChecker.ts` fetches
`raw.githubusercontent.com/<repo>/<tag>/dist-template/index.html` and falls back
to the asset only in case the CORS situation ever changes — which it has not,
because release-asset downloads carry no `access-control-allow-origin` header
and a page therefore cannot read one. Every build back to v2.17.0 takes the raw
route. Dropping the aliases strands nothing.

Owner report 2026-10-29, on opening the v2.21.0 release page: three HTML files
that are the same file, and no way to tell which to download. From v2.22.0 the
release publishes `PowerRoadmap.html` only.

`RELEASE_ASSET_NAMES` still lists all three names, newest first, and should
stay that way: the matcher runs in an old build reading a *new* release, and
has to recognise at least one name it knows.

What cannot be dropped is the **old repository name**. `api.github.com/repos/
CynaCons/powerplanner/releases/latest` is still what every build before v2.20.0
asks for, and it resolves only because GitHub redirects a renamed repository.
That redirect is the single point of failure for those builds; re-measure it at
every release. At v2.28.0 it returned `v2.28.0`; at v2.34.1 it returned
`v2.34.1`, as a `301` to `/repositories/1250571066/releases/latest`.

GitHub also attaches a source zip and tarball to every release automatically.
They cannot be removed, and they are not ours.

## The rename — done 2026-10-28

`CynaCons/powerplanner` → `CynaCons/powerroadmap`, on the owner's approval. It
had been held back because the updater ships inside every saved file and cannot
be fixed retroactively, so a rename that broke either route would strand every
build in the wild.

The prediction, measured 2026-10-27 against `facebook/jest` as a proxy, and the
outcome, measured against this repository within minutes of renaming it:

| Route, asked under the OLD name | Predicted | Observed 2026-10-28 |
|---|---|---|
| `api.github.com/repos/<old>/releases/latest` | 301 with CORS on the redirect | **301** to `/repositories/1250571066/releases/latest`, `access-control-allow-origin: *` on the 301 **and** on the followed 200 |
| `raw.githubusercontent.com/<old>/main/package.json` | 200, no redirect | **200**, `access-control-allow-origin: *`, no redirect |
| `github.com/<old>/releases/latest/download/PowerRoadmap.html` | not measured | **200** after redirects, resolves to `release-assets.githubusercontent.com` |

So every build in the wild keeps updating through the old name, and the site's
download buttons keep working from old links. `GITHUB_REPO` in
`src/utils/updateChecker.ts` moved to the new name for builds from v2.20.0 on.

### What the rename did break: the old Pages URL

| URL | Observed 2026-10-28 |
|---|---|
| https://cynacons.github.io/powerplanner/ | **404**, with no `Location` — GitHub issues no Pages redirect for a renamed project site |
| https://cynacons.github.io/powerroadmap/ | 200 |

Anyone holding a link to the old landing page gets a 404. Nothing in the app
depends on it — the updater never touches Pages — so no build is stranded, but
the link is dead and only a placeholder repository at the old name, serving a
redirect page, would revive it. Not done; it is a new public surface and the
owner's call.

## Which releases can update themselves

| Release | Carries the updater | Note |
|---|---|---|
| v2.17.0 | **yes** | first build that can update itself |
| v2.16.0 | no | tagged at `b900c6f`, before the updater landed in `842ee92` |
| v2.11.0 and earlier | no | no assets at all |

Verified against the published build, not the repo: fetching
`v2.17.0/dist-template/index.html` returns 363,694 bytes containing
`Check for updates`, `raw.githubusercontent` and `powerplanner-update-check`;
the same fetch at `v2.16.0` contains none of them.

A build without an updater has to be replaced by hand — the updater ships
inside each saved file, so it cannot be delivered retroactively.

### Observed: a real v2.19.0 build finding v2.20.0 across the rename

The point of the gate (PLAN.md v2.17.1) was to see an installed build update
itself rather than argue that it could. Done 2026-10-28, and made harder on
purpose by running it *after* the rename.

`PowerRoadmap.html` was downloaded from the published **v2.19.0** release — a
build with `GITHUB_REPO = 'CynaCons/powerplanner'`, the OLD name, compiled in
and unchangeable. Served over `http://localhost:5181` so the page had a real
origin, with the 6-hour check cache cleared first. Pressing **Check for
updates** produced:

```json
{"available":true,"latestVersion":"2.20.0",
 "downloadUrl":"https://github.com/CynaCons/powerroadmap/releases/download/v2.20.0/PowerRoadmap.html",
 "releaseUrl":"https://github.com/CynaCons/powerroadmap/releases/tag/v2.20.0",
 "tag":"v2.20.0"}
```

and the dialog offered "Update to 2.20.0". Note what the old build resolved:
it asked under the old name and GitHub handed back URLs carrying the **new**
one, so it follows the rename without knowing the name changed.

The fetch the update would then perform was run in that same page, against the
old name, and returned 200 with `<div id="root">` present — `fetchBuild`'s own
acceptance guard — carrying `2.20.0`.

**Not exercised:** the final write. Served over http there is no file handle,
so `performUpdate` takes the download branch, and that was left for the owner
to click. Everything up to the write is observed; the write itself is browser
plumbing and independent of the rename.

### Observed: a real v2.28.0 build finding v2.34.1

Done 2026-10-30, immediately after publishing v2.34.1, and it goes further than
the v2.19.0 run above: this time the bytes the updater would install were
hashed inside the page.

The published **v2.28.0** asset was served over `http://localhost:5198`. Not a
simulation — no module stubbed, no checker logic re-implemented. The gear button
in that build's own header, then **Check for updates** inside its Settings
dialog, which is where the control lives in a build that predates the side
panel. The dialog then read `Version 2.34.1 is available.` with a primary button
labelled `Update to 2.34.1`.

| What | Observed |
|---|---|
| The build's own version | `2.28.0`, from its Settings dialog and its status bar |
| `UpdateInfo` the UI call produced | `available: true`, `latestVersion: 2.34.1`, `tag: v2.34.1`, and both URLs carrying the **new** repository name |
| Which build asked | the cache entry it wrote has `forVersion: "2.28.0"` |
| The release API from the page | `200`, `tag_name: v2.34.1`, asset `PowerRoadmap.html` 419,816 bytes |
| The route `fetchBuild` takes | `200`, `text/plain`, 419,816 bytes |
| `looksRight()`, the guard it applies | `<div id="root">` present |
| **The bytes it would install** | in-page SHA-256 `94356d66…` — **identical to the published asset** |
| CORS | nothing blocked; both cross-origin bodies were readable, which is the proof |

`access-control-allow-origin` read back as `null` on both responses. That is not
a missing header: ACAO is not a CORS-safelisted response header, so page JS
cannot read it by design. The evidence is that the bodies were readable at all —
a wrong ACAO throws `TypeError: Failed to fetch` instead.

**Still not exercised:** the write. `performUpdate` was never called and the
button was never clicked. Served over http there is no file handle, so it would
take the download branch anyway. The read side is now proven to the byte; the
write remains the owner's click.

## Update route — the one the in-app updater uses

Verified live on 2026-10-26, not inferred:

```
curl -I https://raw.githubusercontent.com/CynaCons/powerplanner/v2.16.0/dist-template/index.html
  → HTTP 200, 355,051 bytes
  → access-control-allow-origin: *
```

That header is why this route exists. Release-asset downloads do not carry it,
so a page cannot fetch them (DECISIONS.md D9). If this route ever stops
serving, updating breaks for every build already in the wild.

## What this ledger made visible

**Fixed 2026-10-26.** Every tag from v1.0.0 to v2.11.0 had zero assets, so the
single-file HTML the product *is* had never been published. `v2.16.0` is the
first release to carry one.

Its first run failed, on its own tag: the SRS-ABR-050 portable-build gate read
`dist-template/PowerRoadmap.html`, which the same change had made an untracked
artifact, and `npm test` ran before `npm run build:template`. Nothing had
published — no release object, no assets — so the tag was recut rather than
burning a version. The gate now reads the committed `index.html` and the
workflow builds before testing.

**The published app is three iterations behind the code.** Tag `v2.11.0` predates
the v2.12 legibility work and the v2.13 command-bar work (C0 and C1, committed
2026-08-07 and 2026-08-10). `dist-template/` was last built 2026-08-10 and does
not include anything since.

**CI history is misleading.** The only workflow that ran on code pushes was
`native-pure`, and it failed on all five of its last runs — `ilammy/msvc-dev-cmd`
cannot find vcvars on the current `windows-latest` image. The web app had no CI
at all. As of 2026-10-23 `native-pure` is manual-dispatch only while native is
parked, and `web-ci.yml` covers lint, unit, build and the single-file build.

## History

| Date | Surface | Version | Note |
|---|---|---|---|
| 2026-11-02 | GitHub release | v2.35.0 | An independent polish round plus the unreleased v2.34.2. Touch and the keyboard reach the chart; Enter presses focused buttons; modals keep focus; F2, ctrl-click, the selection counts and the right-click Delete all corrected; row deletion stops leaving dangling dependencies; the grid, the deadline colour, small-text contrast and empty bars all read. 93 defects found across six measured dimensions, 64 behaviours confirmed sound, 22 fixed; the rest are in the backlog. Full e2e before the tag: 543 reported, 303 passed, 239 skipped by project, 1 failed — a dark-theme contrast assertion that did not reproduce and that the published bytes disprove at 0 of 134 under AA. |
| 2026-10-30 | GitHub release | v2.34.1 | Six closed iterations since v2.28.0: the save round-trip repaired, the controls moved to a side panel, multi-row selection, mark placement, label editing and bar styling. Full e2e before the tag — 444 reported, 252 passed, 192 skipped by project, 0 failed — and it took three runs, the first two red on real defects. Nine commits; the last published tag had been v2.28.0, so v2.29.0–v2.34.0 were never tagged and ship inside this one. |
| 2026-10-29 | GitHub release | v2.28.0 | Six iterations from the owner's live walkthrough. First release to publish one asset instead of three. e2e not run before the tag, by the owner's instruction. |
| 2026-10-28 | GitHub release | v2.21.0 | Last release to carry the three byte-identical aliases. |
| 2026-08-07 | GitHub release | v2.11.0 | Web agent bridge. No assets attached. |
| 2026-05-27 | GitHub release | v2.3.0 | No assets attached. |
| 2026-05-27 | GitHub release | v2.0.0 | No assets attached. |
| 2026-05-27 | GitHub release | v1.0.1 | No assets attached. |
| 2026-05-27 | GitHub release | v1.0.0 | No assets attached. |
