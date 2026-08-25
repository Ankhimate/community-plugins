# Community format plugins

These are ordinary sandboxed JavaScript plugins, not Rust crates or built-in
format handlers. The editor fetches `marketplace.json` from this repository and
installs the files it declares into the user's plugin directory. Adding a
package to that index makes it available without an editor release.

- `spine/` registers `import.spine` and `export.spine`. Its export template is
  a package resource read through `ankhimate.resource()`.
- `dragonbones/` registers `import.dragonbones`.
- `tweegee-item/` registers the **Tweegee Items** panel, which imports and
  equips binary game-specific `.twitem` metadata and its sibling external atlas
  on the open avatar. Its facing
  control reproduces the legacy avatar's visibility lists, root reflection,
  front/rear container reversal, and head-item depth change.

In the editor, open **Settings → Plugins** and install the package you want. It
is downloaded as ordinary JavaScript into Ankhimate's platform configuration
`plugins` directory and discovered immediately. Manual installs
work too: copy the whole directory, preserving `plugin.js` and any files beside
it, then restart the editor. MCP reads the same directory when it starts.

Without these directories installed, Spine and DragonBones do not appear in the
import registry and Spine does not appear in the export formats. Plugins receive
only the input file's confined sidecars and their packaged resources; they have
no general filesystem, network, or clock access.
