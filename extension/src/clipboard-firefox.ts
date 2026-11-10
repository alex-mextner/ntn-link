/**
 * Firefox has no offscreen documents; its background page may use the async clipboard with
 * the clipboardWrite permission, inside the user-initiated command or click.
 */
export function copyDirect(text: string): Promise<void> {
  return navigator.clipboard.writeText(text);
}
