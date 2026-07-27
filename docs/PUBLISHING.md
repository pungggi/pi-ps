# Publishing `pi-powershell` to npm

`pi-powershell` (repo `pi-ps`) ships **raw TypeScript source** (pi loads `.ts`
extensions at runtime — no build step). Releases are **CI-driven**: push a
`v*.*.*` git tag and GitHub Actions publishes to npm with
[provenance](https://docs.npmjs.com/generating-provenance-statements) (SLSA).

Manual `npm publish` is intentionally blocked by the `prepublishOnly` guard in
`package.json` so every release goes through CI (guarantees version sync +
provenance + a clean test run).

```
git tag v3.1.0 && git push origin v3.1.0
        │
        ▼
release.yml  ──►  npm ci → typecheck → test → version-sync check → npm publish --provenance
                                                                      │
                                                                      ▼
                                                            npmjs.com/package/pi-powershell
```

---

## 1. Prerequisites (one-time)

1. An **npm account** that owns `pi-powershell` (maintainer: `ngsoftware`).
2. **2FA enabled** on the account (required for modern publish).
3. Confirm ownership:
   ```bash
   npm view pi-powershell version
   npm view pi-powershell maintainers
   ```
4. **Repo must be public** for `--provenance` (already is).

---

## 2. Auth for CI (pick ONE)

### Option A — Trusted Publishing / OIDC (preferred, no long-lived token)

No `NPM_TOKEN`. GitHub Actions proves identity via OIDC (`id-token: write` is
already in `release.yml`).

1. Sign in at [npmjs.com](https://www.npmjs.com) as the package owner.
2. Open `https://www.npmjs.com/package/pi-powershell` → **Settings → Trusted Publisher**
   → Add GitHub Actions:
   - **Organization or user:** `pungggi`
   - **Repository:** `pi-ps`
   - **Workflow filename:** `release.yml` (exact name, no path)
   - Environment: leave empty unless you use GitHub Environments
3. On GitHub, delete a bad token so it cannot override OIDC:
   ```bash
   gh secret delete NPM_TOKEN --repo pungggi/pi-ps
   ```
4. Re-run the release job (see §5).

Docs: https://docs.npmjs.com/trusted-publishers

### Option B — Classic **Automation** token (works immediately)

`EOTP` means the token still requires an authenticator code. CI cannot type OTP.

1. npmjs.com → avatar → **Access Tokens** → **Generate New Token**.
2. Choose **Classic token → Automation**
   - **Not** “Publish”
   - **Not** “Read-only”
   - Automation exists specifically to **bypass 2FA on publish** in CI.
3. Copy `npm_…` (shown once).
4. Set the GitHub secret:
   ```bash
   gh secret set NPM_TOKEN --repo pungggi/pi-ps
   # paste token, Enter
   gh secret list --repo pungggi/pi-ps
   ```
5. Re-run the release job (see §5).

> Same token used by `pungggi/pi-schedule` can be reused here if it still has
> publish rights for `pi-powershell`.

---

## 3. Publish a release (each time)

Keep `package.json` version and the git tag in sync (`release.yml` enforces it).

```bash
# already bumped package.json to 3.1.0, committed on master:
git tag v3.1.0
git push origin master --follow-tags
gh run watch
```

Or atomically via npm:
```bash
npm version patch -m "release: %s"   # or minor / major
git push origin master --follow-tags
gh run watch
```

---

## 4. Re-run a failed tag release (do not retag)

```bash
gh run list --workflow=release.yml --limit 5
gh run rerun <run-id> --failed
gh run watch <run-id>
npm view pi-powershell version
```

Do **not** delete/recreate the tag unless you must move it (discouraged).

---

## 5. Verify a release

```bash
npm view pi-powershell
npm view pi-powershell version
```

On the npm page you should see a **Provenance** badge linking to the Actions run.

Install / update:
```bash
pi update npm:pi-powershell
# or fresh:
pi install npm:pi-powershell
```

---

## 6. Troubleshooting

| Symptom | Fix |
|---|---|
| **`EOTP` / one-time password** | Token is not Automation. Use **Classic → Automation**, or delete `NPM_TOKEN` and use **Trusted Publisher** OIDC. |
| **`E401` / invalid token** | Local `~/.npmrc` token expired — irrelevant for CI. Fix `NPM_TOKEN` secret or OIDC. |
| **`E404` on PUT** | Not logged in as package owner / no publish rights. |
| `version drift: tag != package.json` | Align versions, retag only if necessary. |
| Provenance `ENOTSUPPORTED` | Needs GHA + `id-token: write` + public repo (already set). |
| Local emergency publish | `CI=1 npm publish --access public --provenance` after `npm login` (interactive OTP OK). Prefer CI. |

---

## 7. Why not only manual `npm publish`?

Manual publish skips the CI test gate, can desync tags, and needs laptop OTP /
a valid local token. Tag → `release.yml` keeps tests, version sync, and
provenance. Keep `prepublishOnly` blocking non-CI publishes.
