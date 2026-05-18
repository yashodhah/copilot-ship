# Project Instructions

## Releases

Always release on the `beta` branch only. Never bump `package.json` version manually — `semantic-release` manages versioning automatically and will produce `x.x.x-beta.N` prerelease tags from the `beta` branch.

Do not touch `package.json` version manually — `semantic-release` manages it. Do not push to `main` or suggest a stable release unless explicitly instructed.
