// @ts-check
/**
 * Decides when a tap on a modal backdrop is a dismissal.
 *
 * Closing on `pointerdown` looks instant and is wrong on a phone: the rest of
 * the sequence — pointerup, then the click the browser synthesises from the
 * touch — is delivered after the overlay has left the DOM, so it is hit-tested
 * against whatever now sits under the finger. On the terminal page that is the
 * toolbar, and closing the copy overlay fired Copy, Paste or Upload underneath
 * it. So dismissal waits for the click, by which time the backdrop is still
 * there to absorb it.
 *
 * Waiting for the click is not enough on its own. A selection dragged out of
 * the text and released on the backdrop produces a click whose target is the
 * common ancestor — the backdrop — and closing there would throw the selection
 * away at the moment it was made. So the tap has to have started on the
 * backdrop too.
 */

/**
 * @param {unknown} backdrop  the element a dismissing tap must hit
 */
export function createBackdropDismiss(backdrop) {
  let startedOnBackdrop = false;

  return {
    /** @param {unknown} target  the pointerdown target */
    down(target) {
      startedOnBackdrop = target === backdrop;
    },
    /**
     * @param {unknown} target  the click target
     * @returns {boolean}  whether the caller should close the overlay now
     */
    click(target) {
      const dismiss = startedOnBackdrop && target === backdrop;
      startedOnBackdrop = false;
      return dismiss;
    },
  };
}
