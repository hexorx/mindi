# Nous UI font identification and disposition

Exact @nous-research/ui 0.18.2 archive contains 28 font paths, representing 14 distinct files: identical src/dist pairs. All font name/copyright/version records were read with fontkit; hashes, names and exact paths are in font-identification.json. No package LICENSE was found.

| Family | Bundled styles | Identified rights source | Disposition |
|---|---|---|---|
| Collapse | Thin, Thin Italic, Light, Light Italic, Regular, Italic, Bold, Bold Italic | Blaze Type / Keussel, embedded copyright 2023; proprietary commercial licensing | Replace |
| Rules Compressed | Regular, Medium | Blaze Type / Matthieu Salvaggio / Léon Hugues, embedded copyright 2022; proprietary commercial licensing | Replace |
| Rules Expanded | Regular, Bold | Same Rules rights source | Replace |
| Mondwest | Regular | Pangram Pangram Foundry, embedded copyright 2020; proprietary commercial licensing | Replace |
| PP NeueBit | Bold | Pangram Pangram Foundry, embedded copyright 2020; proprietary commercial licensing | Replace |

Primary references (consulted 2026-09-30): [Collapse](https://blazetype.eu/typefaces/collapse/), [Rules](https://blazetype.eu/typefaces/rules/), [Blaze EULA](https://blazetype.eu/eula/), [Blaze license categories](https://blazetype.eu/license/), [Pangram bitmap font pack](https://pangrampangram.com/products/bitmap-fonts).

These are not established OFL fonts. Foundry identification and commercial licensing do not establish that this package has rights to redistribute them in an image. No qualifying image redistribution grant was supplied. Per Mindi's authorized fallback, Codi replaces every listed font with system fonts or independently verified OFL alternatives in HEX-193, including CSS references and copies in src/dist/build outputs. Check the final image and distributable layers for all 14 hashes; a CSS-only change is insufficient. Font licensing residual stays open until replacement evidence lands. No purchase or upstream contact is required.
