# Vibe Gasless Transaction Flow

A technical reference tracing Vibe browser actions through GaslessQ or Enigma to contract execution and settlement discovery.

- [Interactive HTML](index.html): contents navigation, eight ownership-labeled diagrams, workflow controls and 35 expandable code references. The HTML embeds its styling, scripts, diagrams and excerpts for offline reading.
- [Printable PDF](Vibe-Gasless-Transaction-Flow.pdf): the complete reference with static diagrams.
- [Markdown](flow-reference.md): the text edition with embedded images.
- [Figures](figures/): SVG and PNG assets for reuse.
- [Evidence ledger](ARCHITECTURE_EVIDENCE.md), [source manifest](source-manifest.json), [architecture model](architecture-model.json) and [validation record](validation.json).

Contract evidence is pinned to `170ae4cfba1eac7453beeb9cd13c3007132c6510`; service evidence to `7a07c0c2f55b3f558a39e6f715149d7633df54f7`. The six cited Vibe bundles were retrieved on 13 September 2026 from the immutable URLs inspected on 12 September. The current application entry page, production configuration and any specific transaction settlement remain unverified. This edition includes the withdrawal-library refactor and upgrade workflow v8/client handoff v3.

When refreshing this reference, review source changes first, then update the evidence, semantic model, affected flow descriptions and rendered diagrams together. Recheck internal links, workflow controls, mobile and reduced-motion behavior, source excerpts and PDF layout. Regenerate the file hashes after changing the deliverables.
