// Shared inline-rename widget: swaps a host element's contents for a text
// input, commits on blur/Enter, cancels (commits unchanged) on Escape.

/**
 * Replace `host`'s contents with a rename input seeded to `currentName`.
 * `commit` is called once with the trimmed new name (or `currentName` if the
 * field was cleared) when the user confirms (blur/Enter) or cancels (Escape).
 */
export function inlineRename(
  host: HTMLElement,
  currentName: string,
  commit: (newName: string) => void,
  opts: { width?: string } = {},
): void {
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'shader-tab-rename-input';
  input.value = currentName;
  if (opts.width) input.style.width = opts.width;

  let done = false;
  const finish = (): void => {
    if (done) return; // guard against blur firing again when commit re-renders
    done = true;
    commit(input.value.trim() || currentName);
  };

  input.addEventListener('blur', finish);
  input.addEventListener('keydown', (e: KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      input.blur();
    } else if (e.key === 'Escape') {
      input.value = currentName;
      input.blur();
    }
  });

  host.textContent = '';
  host.appendChild(input);
  input.focus();
  input.select();
}
