/**
 * The `before-quit` handler: holds every quit until `drain` has settled once, then quits again.
 * The tray, the menu bar, the dock and a data-directory restart all come through here, so each
 * one stops the owned host before `will-quit` releases the data location lease. "Draining" is
 * its own state: the app's `quitting` flag is set by callers before they quit and must not be
 * read as "the drain already started".
 */
export function holdQuit(
  drain: () => Promise<void>,
  quit: () => void,
): (event: { preventDefault(): void }) => void {
  let draining = false;
  let drained = false;
  return (event) => {
    if (drained) return;
    event.preventDefault();
    if (draining) return;
    draining = true;
    void drain().then(() => {
      drained = true;
      quit();
    });
  };
}
