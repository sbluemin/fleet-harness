// Console-wide keyboard commands must consult this boundary before acting. Dialogs
// can be rendered through portals, so event listener ordering is not a safe guard.
export function isBlockingDialogOpen(documentFor: Document = document): boolean {
  return documentFor.querySelector('[aria-modal="true"]:not([hidden])') !== null;
}
