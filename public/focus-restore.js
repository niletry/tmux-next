// @ts-check
/**
 * Decides whether a blur should be answered by pulling focus back to the
 * terminal.
 *
 * The page tracks *intent*: iOS drops the soft keyboard the moment xterm's
 * textarea loses focus, and a tap on any button or bar steals it, so rather
 * than chase each case the terminal takes its focus back whenever something
 * took it away. That default is wrong in exactly the cases where another part
 * of the page was *given* the focus on purpose.
 *
 * Two such cases exist. The rename field needs the tap that focused it to
 * stick, or the title is not typable. And an overlay that lifts the screen
 * into selectable HTML — the copy overlay — needs the focus to leave: its
 * `<pre>` is not focusable, so the long press that starts a selection on a
 * phone blurs the textarea, and answering that blur with `term.focus()` moves
 * the document selection into the textarea. The selection handles disappear in
 * the same frame they appear, which is the whole overlay not working on a
 * phone while looking fine on a desktop — there a drag keeps going after the
 * steal and simply re-makes the selection.
 *
 * @param {object} state
 * @param {boolean} state.keyboardWanted  the user has not dismissed the keyboard
 * @param {boolean} state.renaming        the title field owns the keyboard
 * @param {boolean} state.modalOpen       an overlay owns the screen
 * @returns {boolean}
 */
export function shouldRestoreFocus({ keyboardWanted, renaming, modalOpen }) {
  return keyboardWanted && !renaming && !modalOpen;
}
