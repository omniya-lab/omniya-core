// Keep MathJax completely local. The combined v4 bundle supplies the mature
// semantic-enrichment, speech, and Expression Explorer implementation. Omniya
// deliberately delegates populated-tree arrow navigation to that explorer;
// see https://docs.mathjax.org/en/v4.0/basic/explorer-commands.html.
// Assistive MathML remains enabled for ATs that consume semantic descendants,
// while the explorer remains the focus/edit authority.
globalThis.MathJax = {
  loader: {
    load: ['a11y/assistive-mml'],
    // These aliases point at packages installed with the app. In particular,
    // this prevents the bundled CHTML/SRE components from falling back to
    // their public CDN defaults.
    paths: {
      mathjax: '../../node_modules/@mathjax/src/bundle',
      fonts: '../../node_modules/@mathjax',
      sre: '../../node_modules/@mathjax/src/bundle/sre',
      // Not the installed copy: a patched one that scripts/build/build-editor.mjs writes
      // next to the page, with how a function with a power is spoken (see
      // speech-rules.js). Every other rule in it is the installed one.
      mathmaps: './mathmaps'
    }
  },
  startup: { typeset: false },
  options: {
    enableEnrichment: true,
    enableSpeech: true,
    enableBraille: true,
    enableAssistiveMml: true,
    a11y: { inTabOrder: true, roleDescription: 'math' },
    sre: { locale: 'en', domain: 'clearspeak', style: 'default' }
  }
};
