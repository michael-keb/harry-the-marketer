// One Mermaid theme for both places a playbook is drawn: the marketing site's
// hero and the campaign editor's live preview. They had drifted apart, and both
// were on Mermaid's built-in 'dark' theme, which supplies its own greys, tans
// and oranges — the diagram is the product's central image, so it should not be
// the one thing on screen wearing someone else's palette.
//
// `theme: 'base'` is the only Mermaid theme that accepts every variable below,
// so nothing falls through to a default. Values mirror the tokens in index.css.
export const MERMAID_BRAND_THEME = {
  fontFamily: 'inherit',
  fontSize: '14.5px',
  background: '#ffffff',

  // Nodes: mint fill, accent-500 border, ink text.
  primaryColor: '#e5f7f0',
  primaryBorderColor: '#0f9d6e',
  primaryTextColor: '#1b2a3d',
  secondaryColor: '#d7f3e9',
  secondaryBorderColor: '#0f9d6e',
  secondaryTextColor: '#1b2a3d',
  tertiaryColor: '#ffffff',
  tertiaryBorderColor: '#b6e4d0',
  tertiaryTextColor: '#1b2a3d',
  mainBkg: '#e5f7f0',
  nodeBorder: '#0f9d6e',
  nodeTextColor: '#1b2a3d',

  // Edges: accent-500 lines, accent-700 labels on a white chip.
  lineColor: '#0f9d6e',
  edgeLabelBackground: '#ffffff',
  labelBackground: '#ffffff',
  titleColor: '#1b2a3d',
  textColor: '#0a6b4c',

  clusterBkg: '#fafcfd',
  clusterBorder: '#e1e8ed',
}

export const MERMAID_BRAND_CONFIG = {
  startOnLoad: false,
  theme: 'base',
  securityLevel: 'strict',
  flowchart: { curve: 'basis', useMaxWidth: true, padding: 12 },
  themeVariables: MERMAID_BRAND_THEME,
}
