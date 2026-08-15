# @deepseek-ai/dsh-theme-pack

This app-owned DSH Profile Bundle contributes the two product themes used by DeepSeek Harness Desktop App.

- `professional-blue` is the default product theme, with an ink-blue background, restrained cobalt accent, and separate light and dark palettes.
- `anime-blue` is optional and enables the anime home presentation.

The Bundle owns installation and provenance through `dsh.bundle.patch`, and its patch inserts the `dsh-theme-pack` Cordis plugin row so Profile also owns runtime lifecycle. Its `dshWork.themes` descriptor contains only renderer-safe color and appearance tokens; it does not inject raw CSS or create a second theme registry.

Before exposing the Client surface, the product runtime adapter uses the official DSH Settings API to persist `ui-theme.preference: dark` only when that namespace has no user preference. An explicit `light`, `dark`, or `system` value is never overwritten. Product theme selection remains in DeepSeek Harness Desktop App's theme settings: a missing selection resolves to `professional-blue`, while an explicit `anime-blue` selection remains valid.
