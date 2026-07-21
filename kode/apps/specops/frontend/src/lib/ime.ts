/**
 * Browser IME implementations disagree about when `isComposing` flips around
 * the Enter that commits a candidate. Guard the native flag, keyCode 229, our
 * explicit composition state, and the immediately-following Enter.
 */
export function shouldSubmitOnEnter(event: KeyboardEvent, composing: boolean, compositionEndedAt: number): boolean {
  if (event.key !== 'Enter' || event.shiftKey) return false;
  if (composing || event.isComposing || event.keyCode === 229) return false;
  return Date.now() - compositionEndedAt > 100;
}
