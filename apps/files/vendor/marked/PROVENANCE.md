marked v12.0.2 (MIT), the prebuilt `marked.min.js` from the npm package `marked@12.0.2`, unchanged. Its licence,
`LICENSE.md` beside it, is that package's own file, unchanged: marked's MIT licence and the original Markdown's BSD
licence. Files uses it for the Markdown preview. To update it, replace both files with another release's
`marked.min.js` and `LICENSE.md`; the page's markdown-safety block and test/files-markdown-safety.test.mjs check the
result.
