# Blog editor build

The deployed editor is self-hosted under `static/blog-editor/milkdown/`.
It does not fetch scripts, styles or fonts from a third-party CDN.

From this directory, install the locked dependencies and rebuild:

```sh
pnpm install --frozen-lockfile
node build.mjs
```

Run publishing and compatibility checks from the repository root:

```sh
node --test tools/blog-editor-tests/*.test.mjs
```

The editor uses Milkdown Crepe 7.23.0 with selected features. Markdown with
HTML or Hugo shortcodes opens in source mode. Loading a supported document
preserves its original source until the visual document is actually edited.
View preferences and rendered image blob URLs never enter saved post content.

When changing built files, update the asset versions in `index.html` and
`app.js`. GitHub Pages copies the prebuilt assets; it does not run this build.
