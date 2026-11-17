# Optional dsh sidebar extension proposal

`brand-controls.patch` proposes two single/root slots for dsh sidebar 0.2.1-rc.5:

- `sidebar.brand.control`: `{ wide: boolean }`
- `sidebar.primary.action`: `{ wide: boolean; native: ReactNode }`

This is a review artifact, not an automatically applied dependency patch. No installed package is modified. Integrating upstream must also add the corresponding SlotMap declarations in the upstream TypeScript source and run upstream checks. Rebase the compiled proposal onto maintained upstream source before release.

Without these slots, Kode retains its safe workspace-level mode control. Title switching and suppression of the native global New Session button are available only when the extension is present. Do not describe those features as active in stock dsh.

The isolated browser test can use an explicitly supplied reviewed bundle through `KODE_TEST_SIDEBAR_BUNDLE`. Production resolves the installed sidebar normally. The Kode Orbit logo is an original collaboration identity, not an official DeepSeek logo.
