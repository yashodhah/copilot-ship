# copilot-plugin

Install GitHub Copilot plugin artifacts into canonical Copilot directories.

## npm vs npx (quick explanation)

- **npm** is the package manager used to install/publish packages.
- **npx** runs a package's CLI command (usually from npm) without requiring a permanent global install.

Before publishing, you can test this project fully from local source.

## Build and test locally (no publish required)

### 1. Install dependencies

```bash
npm ci
```

### 2. Build TypeScript

```bash
npm run build
```

### 3. Run local checks

```bash
npm test
```

### 4. Run the CLI directly from local build output

```bash
node dist/index.js --help
```

### 5. End-to-end install test against the plugin marketplace repo

```bash
# from this repo root
node dist/index.js add https://github.com/github/copilot-plugins --plugin spark -y
node dist/index.js list
```

This installs artifacts into `./.github/` by default.

## Optional: test as if globally installed

If you want to invoke `copilot-plugin` directly (without `node dist/index.js`):

```bash
npm link
copilot-plugin --help
```

When done:

```bash
npm unlink -g copilot-plugin
```
