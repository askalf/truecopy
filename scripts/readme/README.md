# README assets

The pictures under `.github/readme/` come from two places.

| Asset | Made by | Source of truth |
|---|---|---|
| `terminal.svg` | `node scripts/readme/terminal.mjs` | **This checkout's CLI, run for real** in a throwaway directory (its own `truecopy.lock`; HOME, USERPROFILE and CANON_HOME pointed into the scratch dir; the keychain off): scan the poisoned demo manifest, pin and sign the clean one, verify, edit one tool description the way a silent upstream update would, verify again. Output is drawn as printed; a line wider than 92 columns wraps at a `; ` boundary with a hanging indent. Every verdict and exit code the README quotes is checked first, and if one moved the script exits 1 and writes nothing. The CLI prints its own punctuation, so the file is marked `redline-protected` in `.gitattributes`. |
| `hero.jpg` | ChatGPT's image model, from a written brief | The brief names every word in the picture, and every word is a claim the README makes in text beside it. When the flow or a claim changes, re-brief the picture in the same pass that edits the prose. JPEG quality 95. A social-preview card (1280×640, under GitHub's 1 MB cap) follows the same rule and is uploaded by hand at Settings → General → Social preview. |

GitHub serves README images through its camo proxy inside an `<img>`, which loads no external fonts, stylesheets or scripts. So `terminal.svg` embeds Space Mono (SIL OFL, `fonts/OFL.txt`) as base64 and pins every monospace run with `textLength` so alignment survives a fallback font. The typing animation is SMIL; a `prefers-reduced-motion` rule stops the cursor blink.

`lib.mjs` and `terminal.mjs` use Node's standard library only. None of this ships in the npm tarball (`files` in `package.json` is `src` only), and npm renders the README from the published tarball, so README changes reach npm with the next release.

`scripts/check-readme-links.mjs` (run in CI) fails when a relative link, image or `#anchor` in the README or `docs/` stops resolving.
