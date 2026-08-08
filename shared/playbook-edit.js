// Writing a Send step's instruction back into the Mermaid source.
//
// The diagram IS the campaign, so "change what this email says" has to mean
// changing that node's label — an instruction stored anywhere else would drift
// from the diagram the engine actually walks. Shared by the sample-email editor
// in the web app and by the server, so a label written by one is always
// readable by the parser in server/playbook.js.

export const INSTRUCTION_MAX = 240

// Mermaid labels cannot carry brackets, quotes or pipes, and the parser reads a
// node definition up to the first `]`. Whatever someone types is flattened to
// fit rather than silently breaking their diagram.
export function sanitizeInstruction(text, max = INSTRUCTION_MAX) {
  return String(text ?? '')
    .replace(/[[\]{}()"|]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max)
}

// Replace the instruction on `nodeId`'s definition. Returns the source
// unchanged when that id is not defined as a Send step in it, or when the new
// instruction is empty — a step with nothing to say is not an edit, it is a
// mistake, and the diagram should survive it.
export function setSendInstruction(source, nodeId, instruction) {
  const clean = sanitizeInstruction(instruction)
  if (!clean) return String(source)
  const id = String(nodeId).replace(/[^A-Za-z0-9_-]/g, '')
  if (!id) return String(source)
  // The definition is the one occurrence of the id that carries a Send label;
  // later mentions on edge lines are bare ids and must not be touched.
  const def = new RegExp(`(^|[^A-Za-z0-9_-])${id}\\[\\s*"?\\s*send\\s*:?\\s*[^\\]]*?"?\\s*\\]`, 'i')
  const m = String(source).match(def)
  if (!m) return String(source)
  return String(source).slice(0, m.index) + `${m[1]}${id}[Send: ${clean}]` + String(source).slice(m.index + m[0].length)
}

// Fold a whole set of edits in one pass, skipping the ones that change nothing.
export function applyInstructions(source, edits) {
  let out = String(source)
  for (const { nodeId, instruction } of edits || []) out = setSendInstruction(out, nodeId, instruction)
  return out
}
